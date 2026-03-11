# Key0 — Timeout & Retry Handling Review

This document audits every async operation in the Key0 SDK for timeout protection, retry behavior, and failure-mode gaps. Each finding includes the file, the risk, and a recommended fix.

---

## Table of Contents

1. [Summary of Findings](#summary-of-findings)
2. [Timeout Gaps](#timeout-gaps)
3. [Retry Gaps](#retry-gaps)
4. [State Leaks (Money-at-Risk)](#state-leaks-money-at-risk)
5. [Fire-and-Forget Risks](#fire-and-forget-risks)
6. [Redis Failure Modes](#redis-failure-modes)
7. [Settlement Failure Modes](#settlement-failure-modes)
8. [Distributed Lock Risks](#distributed-lock-risks)
9. [Additional Timeout Gaps](#additional-timeout-gaps)
10. [Refund Cron Failure Modes](#refund-cron-failure-modes)
11. [Data Consistency & TTL Issues](#data-consistency--ttl-issues)
12. [Miscellaneous](#miscellaneous)
13. [Recommendations Summary](#recommendations-summary)

---

## Summary of Findings

| Severity | Count | Category |
|----------|-------|----------|
| CRITICAL | 3 | Money stuck in PAID state (R1), no timeout on `onIssueToken` (T1), no timeout on facilitator fetch (T2) |
| HIGH | 10 | Infinite lock loop (R4), no timeout on gas wallet/waitForReceipt/OAuth/Docker (T3, T5, T7-T8), no facilitator retry (R2), resource re-verify after settlement (S2), refund cron crashes (RC1-RC2), facilitator idempotency (SE3) |
| MEDIUM | 10 | Implicit RPC timeout (T4), PAID->DELIVERED failure (S1), no `fromAddress` refund path (S3), non-atomic create (R3), pipeline unchecked (RD2), Redis errors (RD3), lock release (SE1), refund retry (RC3), refund batch (RC4), fire-and-forget hooks (F1) |
| LOW | 8 | Timer leaks (T6), expired hook (F2), no health check (RD1), queue error swallow (SE2), lock key prefix (DL1), ghost sorted set entries (DC1), verbose logging (M1), hardcoded maxTimeout (M2) |

---

## Timeout Gaps

### T1. `onIssueToken` has NO timeout (CRITICAL)

**File**: `src/core/challenge-engine.ts:376` (submitProof), `src/core/challenge-engine.ts:656` (processHttpPayment)

**Problem**: The `onIssueToken` callback is awaited with no timeout. If the seller's token issuance hangs (e.g., remote service down, database lock), the request hangs forever. Critically, at this point the state is already **PAID** and `txHash` is already marked used — so the client has paid, money is locked, and no token is delivered.

**Current code**:
```ts
const tokenResult = await this.config.onIssueToken({ ... });
```

**Impact**: Client pays USDC, record stays PAID forever (until refund cron runs, if one exists). HTTP request hangs indefinitely.

**Fix**: Wrap in `Promise.race` with a configurable timeout (e.g., `tokenIssueTimeoutMs`, default 15s). The error codes `TOKEN_ISSUE_FAILED` / `TOKEN_ISSUE_TIMEOUT` already exist in the types but are never thrown by the engine.

```ts
const timeoutMs = this.config.tokenIssueTimeoutMs ?? 15_000;
const tokenResult = await Promise.race([
  this.config.onIssueToken({ ... }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Key0Error("TOKEN_ISSUE_TIMEOUT", "Token issuance timed out", 504)), timeoutMs)
  ),
]);
```

---

### T2. `settleViaFacilitator` fetch calls have NO timeout (CRITICAL)

**File**: `src/integrations/settlement.ts:219` (verify), `src/integrations/settlement.ts:250` (settle)

**Problem**: Both `fetch()` calls to the facilitator (`/verify` and `/settle`) use no `AbortController` or timeout. If the Coinbase facilitator is slow or unresponsive, the request hangs indefinitely.

**Current code**:
```ts
const verifyRes = await fetch(`${facilitatorUrl}/verify`, { ... });
// ...
const settleRes = await fetch(`${facilitatorUrl}/settle`, { ... });
```

**Impact**: Client request hangs indefinitely. If the client retries, the EIP-3009 signature may be settled twice (facilitator is not idempotent from our side).

**Fix**: Add `AbortController` with timeout (30s for verify, 60s for settle):

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  const verifyRes = await fetch(url, { ...opts, signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

---

### T3. `settleViaGasWallet` — `scheme.verify()` and `scheme.settle()` have NO timeout (HIGH)

**File**: `src/integrations/settlement.ts:322` (verify), `src/integrations/settlement.ts:342` (settle)

**Problem**: The `ExactEvmScheme.verify()` and `.settle()` calls interact with the blockchain (RPC calls). They have no timeout. An unresponsive RPC node causes indefinite hang.

**Impact**: Same as T2 — request hangs, potential double-settlement on retry.

**Fix**: Wrap each in `Promise.race` with a configurable timeout (e.g., 30s for verify, 90s for settle since it waits for tx confirmation).

---

### T4. `verifyTransfer` — RPC calls have no explicit timeout (MEDIUM)

**File**: `src/adapter/verify-transfer.ts:22` (`getTransactionReceipt`), `src/adapter/verify-transfer.ts:111` (`getBlock`)

**Problem**: Both viem RPC calls (`getTransactionReceipt`, `getBlock`) have no explicitly configured timeout. Viem's HTTP transport provides a default ~10s per-request timeout, so these won't hang forever — but the code relies on an implicit library default that could change.

**Impact**: `submitProof()` blocks for up to ~10s per call on slow RPC. No money risk.

**Fix**: Explicitly configure the viem transport with a `timeout` option to make the behavior visible and controllable.

---

### T5. `sendUsdc` — `waitForTransactionReceipt` has NO timeout (HIGH)

**File**: `src/adapter/send-usdc.ts:102`, `src/adapter/send-usdc.ts:126`

**Problem**: `waitForTransactionReceipt` polls the chain until the tx is mined. If the tx is stuck (low gas, chain congestion), this waits forever. This is called during refunds.

**Impact**: Refund cron worker blocks indefinitely on a single stuck refund, preventing all other refunds from processing.

**Fix**: Use viem's built-in `timeout` option on `waitForTransactionReceipt`:

```ts
const receipt = await publicClient.waitForTransactionReceipt({
  hash: txHash,
  timeout: 120_000, // 2 minutes
});
```

---

### T6. `onVerifyResource` timeout timer is never cleared (LOW)

**File**: `src/core/challenge-engine.ts:163-174`, repeated at `:468-479`, `:558-569`

**Problem**: The `setTimeout` in the `Promise.race` pattern is never cleared when the `onVerifyResource` resolves before the timeout. This leaks a timer handle. While Node/Bun will GC it, under high concurrency this creates unnecessary timer pressure.

**Current code**:
```ts
const exists = await Promise.race([
  this.config.onVerifyResource(resourceId, req.tierId),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(...), timeoutMs)
  ),
]);
```

**Fix**: Clear the timer on resolution:

```ts
let timer: ReturnType<typeof setTimeout>;
const exists = await Promise.race([
  this.config.onVerifyResource(resourceId, req.tierId).finally(() => clearTimeout(timer)),
  new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(...), timeoutMs);
  }),
]);
```

---

## Retry Gaps

### R1. No retry on `onIssueToken` failure — PAID record orphaned (CRITICAL)

**File**: `src/core/challenge-engine.ts:376-382`, `src/core/challenge-engine.ts:656-662`

**Problem**: If `onIssueToken` throws (remote service error, temporary DB issue), the exception propagates up. The challenge stays in **PAID** state with `txHash` marked as used. There is:
- No retry attempt
- No transition to an error state
- No way for the client to retry (txHash is claimed)

The only recovery is the refund cron (if deployed), which refunds after `minAgeMs` — but this means the client loses access to the resource they paid for, even if the failure was transient.

**Impact**: Client pays, gets nothing. Must wait for refund (if cron exists).

**Fix options** (in order of preference):
1. **Immediate retry with backoff** — retry `onIssueToken` 2-3 times before giving up
2. **Transition to DELIVERY_FAILED state** — add a new state so operators can see and manually fix
3. **Allow client retry** — if `processHttpPayment` is called again with the same `requestId` and the record is PAID, re-attempt `onIssueToken` instead of rejecting

---

### R2. No retry on facilitator settlement failure (HIGH)

**File**: `src/integrations/settlement.ts:208-286`

**Problem**: If `/verify` succeeds but `/settle` fails (network blip, facilitator temporary error), the entire settlement fails. The EIP-3009 signature is still valid and unused on-chain, but the client gets a `PAYMENT_FAILED` error. The client would need to re-submit the same signature, but there's no guarantee the nonce hasn't been consumed.

**Impact**: Potential payment loss if the facilitator partially processed the settlement.

**Fix**: Retry `/settle` 2-3 times with exponential backoff before failing. The settlement is idempotent from the chain's perspective (same nonce can't be replayed).

---

### R3. Redis `store.create()` pipeline is not atomic (MEDIUM)

**File**: `src/core/storage/redis.ts:183-203`

**Problem**: The `create()` method does an `EXISTS` check, then a `pipeline.exec()`. This is not truly atomic — a race between two concurrent creates for the same `challengeId` could pass the `EXISTS` check simultaneously. The pipeline itself is atomic (all-or-nothing on the server), but the EXISTS guard is separate.

**Current code**:
```ts
const exists = await this.redis.exists(key);  // Not in pipeline
if (exists) throw ...;
const pipeline = this.redis.pipeline();
pipeline.hset(key, flat);
// ...
await pipeline.exec();
```

**Impact**: Unlikely with UUID-based challengeIds, but possible if `requestId` collision occurs.

**Fix**: Use `HSETNX` on the first field, or check the pipeline result for unexpected overwrites. Or simply rely on the Lua transition scripts for correctness (which already handle this).

---

### R4. `acquireRedisLock` loops forever with no max attempts (HIGH)

**File**: `src/integrations/settlement.ts:393-403`

**Problem**: The lock acquisition loop has no maximum retry count or overall timeout. If a lock is stuck (holder crashed without releasing, despite the 60s TTL), this waits up to 60s for TTL expiry. But if the lock is perpetually re-acquired by other workers faster than the TTL, this loops indefinitely.

Note: if `redis.set()` itself throws (Redis connection lost), the error propagates out of the loop immediately — it does NOT cause an infinite retry. The infinite loop only occurs when Redis is reachable but the lock is held.

**Current code**:
```ts
async function acquireRedisLock(...): Promise<void> {
  while (true) {
    const ok = await redis.set(key, token, "NX", "PX", LOCK_TTL_MS);
    if (ok === "OK") return;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}
```

**Impact**: Thread blocked indefinitely under lock contention. In a burst scenario (many concurrent settlements), all workers queue up polling every 200ms with no deadline.

**Fix**:
```ts
async function acquireRedisLock(redis, key, token, maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ok = await redis.set(key, token, "NX", "PX", LOCK_TTL_MS);
    if (ok === "OK") return;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  throw new Key0Error("INTERNAL_ERROR", "Failed to acquire settlement lock", 503);
}
```

---

## State Leaks (Money-at-Risk)

### S1. PAID -> DELIVERED transition failure leaves money in limbo (MEDIUM)

**File**: `src/core/challenge-engine.ts:403-406`, `src/core/challenge-engine.ts:684-687`

**Problem**: After `onIssueToken` succeeds and returns a valid token, the PAID -> DELIVERED transition could fail (Redis down, connection timeout). If it fails:
- The transition is `await`ed before `return grant`, so the error propagates and the client gets a 500 — they **never receive** the AccessGrant.
- The record stays PAID with a valid JWT already generated but never stored or delivered.
- The `txHash` is marked used — client can't retry with the same txHash.
- The refund cron will eventually refund this PAID record — which is correct behavior.

The risk is limited: the JWT was generated in memory but never sent to the client. However, the client experiences a confusing failure: they paid, got a 500, can't retry, and must wait for a refund.

**Impact**: Client pays, gets a 500, can't retry. Must wait for refund. No actual double-spend since the token was never transmitted.

**Fix**: Wrap the PAID -> DELIVERED transition in try/catch so the grant is still returned even if Redis fails at this final step:

```ts
try {
  await this.store.transition(challenge.challengeId, "PAID", "DELIVERED", { ... });
} catch (err) {
  console.error("[Key0] Failed to mark DELIVERED, returning grant anyway:", err);
  // Grant is valid — return it. Record stays PAID; if refund cron runs before
  // client uses the token, that's an acceptable edge case vs. losing the payment entirely.
}
```

---

### S2. `processHttpPayment` verifies resource AFTER settlement (HIGH)

**File**: `src/integrations/x402-http-middleware.ts:179-193`, `src/integrations/express.ts:202-221`

**Problem**: In the HTTP flow (Transport 1 and 2), the sequence is:
1. `settlePayment()` — money moves on-chain
2. `engine.processHttpPayment()` — which calls `onVerifyResource()` again

If `onVerifyResource` fails in step 2 (resource deleted between challenge and payment), the payment has **already been settled on-chain** but the engine throws `RESOURCE_NOT_FOUND`. The money is on-chain in the seller's wallet, no PAID record exists, and no refund mechanism kicks in.

**Impact**: Client pays, resource no longer exists, no refund path.

**Fix options**:
1. Skip re-verification in `processHttpPayment` (the resource was already verified during challenge phase)
2. If re-verification is needed, do it BEFORE settlement
3. If verification fails post-settlement, create the PAID record anyway so the refund cron can handle it

---

### S3. No recovery path for PAID records without `fromAddress` (MEDIUM)

**File**: `src/core/storage/redis.ts:270`

**Problem**: `findPendingForRefund` filters for `record.fromAddress` being set. If a PAID record doesn't have `fromAddress` (e.g., facilitator mode where payer extraction failed), it's invisible to the refund cron forever.

**Impact**: Money stuck permanently — PAID record with no refund path and no delivery.

**Fix**: Log a warning for PAID records older than `minAgeMs` that lack `fromAddress`. Consider a separate alert/queue for manual operator review.

---

## Fire-and-Forget Risks

### F1. `onPaymentReceived` hook errors are silently swallowed (MEDIUM)

**File**: `src/core/challenge-engine.ts:410-412`, `src/core/challenge-engine.ts:691-693`

**Problem**: The hook is called without `await` and errors are caught and logged. This is intentional (non-blocking), but if the hook does critical work (e.g., provisioning access, notifying downstream systems), failures are silently lost.

```ts
this.config.onPaymentReceived(grant).catch((err: unknown) => {
  console.error("[Key0] onPaymentReceived hook error:", err);
});
```

**Impact**: Downstream systems may not know about successful payments.

**Fix**: Consider adding an optional `onPaymentReceivedErrorHandler` callback, or emitting an event that operators can monitor. At minimum, add structured logging with the `challengeId`.

---

### F2. `onChallengeExpired` hook errors are silently swallowed (LOW)

**File**: `src/core/challenge-engine.ts:272-274`

**Problem**: Same pattern as F1. Fire-and-forget with error logging only.

**Impact**: Low — expired challenges are informational.

---

## Redis Failure Modes

### RD1. No Redis connection health check at startup (LOW)

**File**: `src/core/storage/redis.ts`, `src/factory.ts`

**Problem**: Neither the store constructors nor `createKey0()` verify that the Redis connection is healthy. If Redis is misconfigured or down, the first real request will fail with a cryptic ioredis error.

**Fix**: Add a `ping()` check in the factory or provide an explicit `healthCheck()` method.

---

### RD2. Redis pipeline failure in `create()` is not inspected (MEDIUM)

**File**: `src/core/storage/redis.ts:203`

**Problem**: `pipeline.exec()` returns an array of `[error, result]` tuples. The code doesn't inspect the results. If any command in the pipeline fails (e.g., `HSET` succeeds but `SET EX` fails due to memory pressure), the request index won't exist but the challenge hash will — breaking idempotency lookups.

**Current code**:
```ts
await pipeline.exec();  // Results not checked
```

**Fix**: Inspect pipeline results:
```ts
const results = await pipeline.exec();
for (const [err] of results ?? []) {
  if (err) throw new Error(`Redis pipeline command failed: ${err.message}`);
}
```

---

### RD3. Redis down during state transition causes unhandled rejection (MEDIUM)

**File**: `src/core/storage/redis.ts:249`

**Problem**: If Redis disconnects during `this.redis.eval(TRANSITION_LUA, ...)`, ioredis throws a connection error. This propagates up to the request handler, which returns a 500. But the challenge may be in an inconsistent state if the Lua script partially executed before the connection dropped (unlikely with Lua atomicity, but possible with network-level issues).

**Impact**: Generally safe due to Lua atomicity, but the error message to the client is unhelpful.

**Fix**: Catch Redis connection errors explicitly and return a retryable error code (503).

---

## Settlement Failure Modes

### SE1. Gas wallet settlement — nonce conflict on lock release failure (MEDIUM)

**File**: `src/integrations/settlement.ts:452-457`

**Problem**: If settlement succeeds but `releaseRedisLock` fails (Redis down at that exact moment), the lock stays held until TTL expires (60s). During that time, no other settlement can proceed. This creates a 60s window of blocked settlements.

**Fix**: The 60s TTL handles this, but log a warning when release fails so operators know.

---

### SE2. In-process queue — silently swallows errors in chain (LOW)

**File**: `src/integrations/settlement.ts:461-465`

**Problem**: The in-process queue chains promises:
```ts
const result = gasWalletSettleQueue.then(() => settleViaGasWallet(...));
gasWalletSettleQueue = result.catch(() => {});
```

The pattern is technically correct: the caller gets `result` (which may reject), and the queue chain is protected by `.catch(() => {})`. Synchronous throws inside `.then()` are also safe. However, the silent `.catch(() => {})` means failed settlements leave no trace in the queue — only the immediate caller sees the error.

**Impact**: Low — operational visibility only. The caller still gets the error.

---

### SE3. Facilitator verify+settle is not idempotent on our side (HIGH)

**File**: `src/integrations/settlement.ts:208-286`

**Problem**: If `/settle` succeeds but the response fails to parse (network drop after facilitator processes), we throw `PAYMENT_FAILED`. But the money has already moved on-chain. The client retries, we call `/settle` again — the facilitator may reject (nonce already used) or the EIP-3009 sig is consumed.

**Impact**: Payment settled but system doesn't know. Record never reaches PAID. No refund path.

**Fix**: After settlement failure, attempt to look up the transaction on-chain before declaring failure. Or: record the settlement attempt (challengeId + signature hash) before calling `/settle`, so we can recover on retry.

---

## Distributed Lock Risks

### DL1. Lock key uses first 10 chars of private key (LOW)

**File**: `src/integrations/settlement.ts:450`

```ts
const lockKey = `key0:settle-lock:${privateKey.slice(0, 10)}`;
```

**Problem**: The lock key is based on the private key prefix. This is a minor security concern (leaking key prefix in Redis) and a correctness concern (two different keys with the same first 10 chars would share a lock — extremely unlikely but technically possible).

**Fix**: Use a hash of the public address instead:
```ts
const lockKey = `key0:settle-lock:${gasAccount.address}`;
```

---

## Additional Timeout Gaps

### T7. `oauthClientCredentialsAuth` fetch has NO timeout (HIGH)

**File**: `src/helpers/auth.ts:104`

**Problem**: The OAuth token fetch call has no `AbortController` or timeout. If the OAuth provider is slow or unresponsive, every request that needs auth headers hangs indefinitely. Since the token is cached, this only affects the first request or token refresh — but that one request blocks.

**Fix**: Add `AbortController` with 10s timeout, consistent with the remote token issuer pattern.

---

### T8. `buildDockerTokenIssuer` fetch has NO timeout (HIGH)

**File**: `src/helpers/docker-token-issuer.ts:38`

**Problem**: The Docker token issuer's fetch to `ISSUE_TOKEN_API` has no timeout. This is called as `onIssueToken`, so it compounds with T1 — the engine has no timeout on the callback, and the callback itself has no timeout on its HTTP call. Double unprotected.

**Fix**: Add `AbortController` with configurable timeout (default 10s).

---

## Refund Cron Failure Modes

### RC1. `findPendingForRefund` failure crashes entire cron run (HIGH)

**File**: `src/core/refund.ts:43`

**Problem**: `store.findPendingForRefund(minAgeMs)` is called outside any try/catch. If Redis is temporarily unreachable, the entire `processRefunds()` throws and no refunds are processed. The caller (cron scheduler) may or may not retry.

**Fix**: Wrap in try/catch, return empty results with an error flag so the caller can decide to retry.

---

### RC2. `REFUND_FAILED` transition failure inside catch block is unhandled (HIGH)

**File**: `src/core/refund.ts:88`

**Problem**: When `sendUsdc()` fails, the catch block calls `store.transition(..., "REFUND_PENDING", "REFUND_FAILED")`. But this transition itself has no try/catch. If Redis is down at this point:
- The transition throws
- The error escapes the per-record catch block
- The `for` loop terminates — remaining records are never processed
- The record stays in `REFUND_PENDING` forever (Lua atomicity means next cron run can't re-claim it since it's no longer PAID)

**Impact**: Record stuck in REFUND_PENDING with no way to recover automatically. Remaining refunds in the batch are skipped.

**Fix**: Wrap the REFUND_FAILED transition in its own try/catch:

```ts
} catch (err: unknown) {
  const error = err instanceof Error ? err.message : String(err);
  try {
    await store.transition(record.challengeId, "REFUND_PENDING", "REFUND_FAILED", {
      refundError: error,
    });
  } catch (transitionErr) {
    console.error(`[Refund] Failed to mark REFUND_FAILED for ${record.challengeId}:`, transitionErr);
    // Record stays REFUND_PENDING — needs manual operator intervention
  }
  results.push({ ... });
}
```

---

### RC3. No retry for REFUND_FAILED records (MEDIUM)

**File**: `src/core/refund.ts:87-90`

**Problem**: Once a record reaches `REFUND_FAILED`, no automatic mechanism exists to retry it. The cron only queries PAID records via the sorted set. `REFUND_FAILED` is a terminal state.

**Impact**: If the failure was transient (RPC timeout, gas spike), the refund is permanently abandoned unless an operator manually intervenes.

**Fix options**:
1. Add a separate query for `REFUND_FAILED` records with a retry count
2. Add a `REFUND_FAILED` sorted set with timestamps, query and retry after a backoff period
3. Provide an admin API endpoint to re-trigger refunds for failed records

---

### RC4. No concurrency limit on refund batch (MEDIUM)

**File**: `src/core/refund.ts:45-101`

**Problem**: The `for` loop processes all eligible records sequentially. If there's a backlog of 1000+ PAID records (e.g., after a prolonged `onIssueToken` outage), the cron run could take hours since each `sendUsdc` waits for on-chain confirmation.

**Fix**: Add a `batchSize` config (default: 50) to limit records per cron run. Or process refunds in parallel with a concurrency limit.

---

## Data Consistency & TTL Issues

### DC1. Paid sorted set retains ghost entries after challenge hash TTL expires (LOW)

**File**: `src/core/storage/redis.ts:261-275`

**Problem**: When a PAID record's challenge hash expires after 7 days (Redis TTL), the entry in the `key0:paid` sorted set is never removed. The refund cron calls `findPendingForRefund`, gets the challengeId from the sorted set, but `store.get()` returns null. The entry is silently skipped (line 270) but **remains in the sorted set forever**.

Over time, long-running deployments accumulate ghost entries. Each cron run fetches and discards these, wasting Redis bandwidth.

**Impact**: Low — performance/hygiene only. No correctness issue.

**Fix**: When `store.get()` returns null for a challengeId in the paid set, call `ZREM` to clean it up:

```ts
if (!record) {
  await this.redis.zrem(this.paidSetKey(), challengeId);
  continue;
}
```

---

### DC2. Request index TTL can cause duplicate challenge creation (LOW)

**File**: `src/core/storage/redis.ts:201` (requestTTL = 900s), `src/core/challenge-engine.ts:489-503`

**Problem**: The request index key (`key0:request:{requestId}`) has a 900s TTL. The challenge record itself has a 7-day TTL. After the request index expires, a new `requestAccess()` with the same `requestId` will create a second PENDING challenge — the old one still exists in Redis but is unreachable via `findActiveByRequestId`.

This is safe because:
- Each challenge has a unique `challengeId`
- The double-spend guard (`seenTxStore`) prevents the same `txHash` from being used twice
- The old PENDING record will eventually expire

**Impact**: Low — wastes a Redis key. The `challengeTTLSeconds` config is used for both the engine-side challenge expiry AND the request index TTL, so they're aligned. The 7-day hash TTL is purely for record-keeping.

**No fix needed** — behavior is correct. Noting for documentation only.

---

### DC3. `processHttpPayment` skips on-chain verification (BY DESIGN — not a gap)

**File**: `src/core/challenge-engine.ts:539-697`

**Note**: Unlike `submitProof()` (which calls `adapter.verifyProof()` for on-chain verification), `processHttpPayment()` does NOT verify the transaction on-chain. This is by design — the settlement layer (`settlePayment()`) already settled the transaction, so the `txHash` is trusted.

This is **correct** but worth documenting: the two paths have fundamentally different trust models:
- `submitProof`: client provides a txHash → server must verify on-chain
- `processHttpPayment`: server settled the tx itself → txHash is trusted

---

### DC4. `verifyTransfer` has a viem default per-request timeout, but it's implicit (CLARIFICATION)

**File**: `src/adapter/verify-transfer.ts`, `src/adapter/adapter.ts:32-35`

**Clarification on T4**: Viem's HTTP transport has a default 10-second timeout per individual RPC request. So `getTransactionReceipt` and `getBlock` will throw after ~10s if the RPC node doesn't respond. This is **not** explicitly configured in our code — it relies on viem's internal default.

The finding in T4 remains valid for robustness (we should explicitly configure the timeout rather than relying on a library default that could change), but the severity is lower than originally described. Individual RPC calls won't hang forever.

This does NOT apply to T5 (`waitForTransactionReceipt`), which retries polling internally and CAN run forever despite the per-request timeout.

---

## Miscellaneous

### M1. Verbose console.log in production middleware (LOW)

**File**: `src/integrations/x402-http-middleware.ts:46-68`, `src/integrations/express.ts:58-63`

**Problem**: Every request logs full headers, bodies, and payment signatures to stdout. This is a security concern (payment signatures in logs) and performance concern.

**Fix**: Use a configurable logger. Default to silent in production.

---

### M2. `maxTimeoutSeconds: 300` is hardcoded (LOW)

**File**: `src/core/challenge-engine.ts:100`, `src/integrations/settlement.ts:104`

**Problem**: The x402 `maxTimeoutSeconds` is hardcoded to 300 (5 minutes) in multiple places. Should derive from `challengeTTLSeconds` config.

---

## Recommendations Summary

### Immediate (Critical/High — should fix before production)

| # | Fix | Effort |
|---|-----|--------|
| T1 | Add timeout to `onIssueToken` calls | Small |
| T2 | Add `AbortController` timeout to facilitator fetch calls | Small |
| R1 | Add retry logic for `onIssueToken` (2-3 attempts with backoff) | Medium |
| R4 | Add max-wait to `acquireRedisLock` | Small |
| S2 | Move resource re-verification before settlement, or skip it | Medium |
| SE3 | Add on-chain lookup fallback after settlement network errors | Medium |
| T7 | Add timeout to OAuth client credentials fetch | Small |
| T8 | Add timeout to Docker token issuer fetch | Small |
| RC1 | Wrap `findPendingForRefund` in try/catch | Small |
| RC2 | Wrap REFUND_FAILED transition in its own try/catch | Small |

### Short-term (Medium — fix in next sprint)

| # | Fix | Effort |
|---|-----|--------|
| S1 | Handle PAID->DELIVERED transition failure gracefully (return grant anyway) | Small |
| T3 | Add timeout to gas wallet `scheme.verify()` / `scheme.settle()` | Small |
| T4 | Configure viem transport timeout for `verifyTransfer` | Small |
| T5 | Add timeout to `waitForTransactionReceipt` in `sendUsdc` | Small |
| R2 | Add retry to facilitator `/settle` call | Small |
| RD2 | Inspect Redis pipeline results in `create()` | Small |
| S3 | Alert on PAID records without `fromAddress` | Small |
| F1 | Add structured error reporting for `onPaymentReceived` failures | Small |
| RC3 | Add retry mechanism for REFUND_FAILED records | Medium |
| RC4 | Add batch size limit to refund cron | Small |
| RD3 | Catch Redis connection errors in transitions and return 503 | Small |
| SE1 | Log warning when lock release fails | Small |

### Low priority (Nice to have)

| # | Fix | Effort |
|---|-----|--------|
| T6 | Clear timers in `Promise.race` patterns | Small |
| DL1 | Use address hash for lock key instead of key prefix | Small |
| M1 | Replace console.log with configurable logger | Medium |
| M2 | Derive `maxTimeoutSeconds` from config | Small |
| RD1 | Add Redis health check at startup | Small |
| DC1 | Clean up ghost entries in paid sorted set during refund scan | Small |

---

## Appendix: Timeout Coverage Matrix

| Operation | Has Timeout? | Default | Configurable? |
|-----------|-------------|---------|---------------|
| `onVerifyResource` | Yes | 5s | `resourceVerifyTimeoutMs` |
| `onIssueToken` | Yes | 15s | `tokenIssueTimeoutMs` |
| `settleViaFacilitator` /verify | Yes | 30s | No (hardcoded) |
| `settleViaFacilitator` /settle | Yes | 60s | No (hardcoded) |
| `settleViaGasWallet` verify | Yes | 30s | No (hardcoded) |
| `settleViaGasWallet` settle | Yes | 90s | No (hardcoded) |
| `verifyTransfer` getTransactionReceipt | Implicit (viem ~10s) | ~10s | No (library default) |
| `verifyTransfer` getBlock | Implicit (viem ~10s) | ~10s | No (library default) |
| `sendUsdc` writeContract | Implicit (viem ~10s) | ~10s | No (library default) |
| `sendUsdc` waitForTransactionReceipt | **NO** | - | - |
| `acquireRedisLock` | Yes | 30s max wait | `maxWaitMs` param |
| `oauthClientCredentialsAuth` fetch | **NO** | - | - |
| `buildDockerTokenIssuer` fetch | **NO** | - | - |
| `RemoteResourceVerifier` | Yes | 5s | `timeoutMs` |
| `RemoteTokenIssuer` | Yes | 10s | `timeoutMs` |
| Challenge TTL (Redis key) | Yes | 900s | `challengeTTLSeconds` |
| Record TTL (Redis key) | Yes | 7 days | `recordTTLSeconds` |
| Delivered TTL (Redis key) | Yes | 12 hours | `deliveredTTLSeconds` |
| Seen TX TTL (Redis key) | Yes | 7 days | hardcoded |
| Settlement lock TTL | Yes | 60s | hardcoded |

## Appendix: Retry Coverage Matrix

| Operation | Has Retry? | Strategy | Idempotent? |
|-----------|-----------|----------|-------------|
| `onIssueToken` | Yes | 2 retries, exponential backoff (500ms base), **not on timeout** | Depends on implementation |
| `onVerifyResource` | **NO** | - | Yes (read-only) |
| Facilitator /verify | **NO** | - | Yes (read-only) |
| Facilitator /settle | Yes | 2 retries, exponential backoff (500ms base), **not on PAYMENT_FAILED** | Partially (nonce-bound) |
| Gas wallet settle | **NO** | - | No (nonce increments) |
| Redis state transition | **NO** | Atomic Lua (no retry needed) | Yes |
| Redis markUsed (SET NX) | **NO** | Atomic (no retry needed) | Yes |
| `sendUsdc` (refund) | **NO** | - | No |
| Lock acquisition | Yes | Poll every 200ms, 30s max wait | Yes |

---

## Post-Implementation Bugs Found

Bugs discovered during code review of the timeout & retry implementation itself.

### B1. `issueTokenWithRetry` retries on TOKEN_ISSUE_TIMEOUT (HIGH — fixed)

**File**: `src/core/challenge-engine.ts` — `issueTokenWithRetry` catch block

**Problem**: `Promise.race` does not cancel the losing promise. When the timeout fires, the original `onIssueToken` call is still in-flight. The retry loop catches the timeout error and spawns a second concurrent call, risking duplicate token issuance for the same challenge.

**Fix**: Break immediately on `TOKEN_ISSUE_TIMEOUT` — do not retry. Only transient errors (network blips, temporary service unavailability) are retried.

---

### B2. `retryWithBackoff` retries non-retryable PAYMENT_FAILED errors (HIGH — fixed)

**File**: `src/integrations/settlement.ts` — `retryWithBackoff` catch block

**Problem**: The facilitator's `/settle` endpoint throws `PAYMENT_FAILED` for both deterministic rejections (invalid signature, insufficient funds, nonce already consumed) and transient failures. Retrying a deterministic rejection wastes ~3.5s of latency and can never succeed.

**Fix**: Break immediately on `PAYMENT_FAILED` — only retry transient errors (network timeouts, `AbortError`, unexpected failures).

---

### B3. `retryFailedRefunds` orphans records — ZADD skipped (HIGH — fixed)

**File**: `src/core/refund.ts` — `retryFailedRefunds`

**Problem**: `store.transition(id, "REFUND_FAILED", "PAID")` passes no `paidAt`, so the Lua script's `score` argument is `""` and the `ZADD` to the `key0:paid` sorted set is skipped. The record's hash state becomes PAID but it is invisible to `findPendingForRefund()` (which queries via `ZRANGEBYSCORE`). The function returns success while the record is permanently orphaned.

**Fix**: Read the record first to get the original `paidAt`, then pass it in the transition so the Lua script fires `ZADD` and the sorted set index is maintained.
