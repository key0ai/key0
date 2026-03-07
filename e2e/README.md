# AgentGate E2E Test Suite

End-to-end tests that run the real AgentGate Docker container against Base Sepolia testnet. Every test exercises the full stack: HTTP layer → challenge engine → Redis storage → on-chain USDC settlement.

## Architecture

```
Test Process (Bun)
  ├── Backend Server (in-process Express, port 3001)
  │     ├── POST /internal/issue-token   ← controllable: success | fail
  │     ├── POST /test/set-mode          ← switches backend behaviour per-test
  │     └── GET  /api/resource/:id       ← protected API (validates Bearer JWT)
  │
  ├── Docker: agentgate (port 3000)
  │     env: ISSUE_TOKEN_API → http://host.docker.internal:3001/internal/issue-token
  │
  ├── Docker: redis:7-alpine (port 6380)
  │     ← AgentGate stores challenge state here
  │     ← Tests read/write state directly via ioredis for setup and assertions
  │
  └── E2eTestClient (viem, EIP-3009)
        1. POST /x402/access (no payment)     → HTTP 402 + challengeId
        2. signTypedData(TransferWithAuth)    → off-chain EIP-3009 signature
        3. POST /x402/access (payment-signature header) → gas wallet settles → AccessGrant (JWT)
        4. GET  /api/resource/:id (Bearer)    → protected backend API
```

## Prerequisites

- Docker Desktop running
- Node / Bun installed
- Funded test wallets on Base Sepolia (see `.env.example`)

## Running

```bash
# Run all e2e tests (starts Docker stack automatically)
cd e2e
bun run test

# Run a single scenario
bun test scenarios/happy-path.test.ts --preload ./global-setup.ts

# Fast check — no wallet needed
bun test scenarios/agent-card.test.ts --preload ./global-setup.ts
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
|---|---|
| `CLIENT_WALLET_PRIVATE_KEY` | Signs EIP-3009 authorizations (buyer) |
| `CLIENT_WALLET_ADDRESS` | Buyer address |
| `GAS_WALLET_PRIVATE_KEY` | Pays gas for on-chain settlement; also second buyer in concurrent test |
| `GAS_WALLET_ADDRESS` | Gas wallet address |
| `AGENTGATE_WALLET_ADDRESS` | Receives USDC payments; signs EIP-3009 for refunds |
| `AGENTGATE_WALLET_KEY` | AGENTGATE wallet private key (for signing refund authorizations) |
| `ALCHEMY_BASE_SEPOLIA_RPC_URL` | Reliable RPC — Alchemy or equivalent |

## Test Scenarios

### `agent-card.test.ts` — Agent Card (2 tests)

Verifies the `GET /.well-known/agent.json` discovery document.

- Checks the response shape: `name`, `description`, `url`, a `skills` array, and a `capabilities.extensions` entry that declares the x402 extension as `required: true`.
- Checks the `"basic"` skill's pricing: `amount` is a dollar string (`"$0.10"`), `chainId` is `84532` (Base Sepolia).

No wallet or on-chain interaction needed.

---

### `happy-path.test.ts` — Happy Path (3 tests)

The full purchase flow where everything works correctly.

**Main test (purchase → JWT → protected API):**
1. `POST /x402/access` with no payment → server returns HTTP 402 with `challengeId` and payment requirements in a base64-encoded `payment-required` header.
2. Client signs an EIP-3009 `TransferWithAuthorization` off-chain — authorizes the gas wallet to move USDC from the client's address to the AgentGate wallet.
3. `POST /x402/access` with `payment-signature` header containing the EIP-3009 signature → gas wallet executes the on-chain transfer → server issues an `AccessGrant` (JWT).
4. `GET /api/resource/resource-1` with `Authorization: Bearer <jwt>` → backend returns 200 with resource data.

**Also tests:**
- No token → 401
- Invalid token → 401

---

### `challenge-timeout.test.ts` — Challenge Timeout (1 test)

Verifies that idempotency resets after a challenge TTL expires.

Instead of waiting 300 seconds for the real TTL, it deletes the `agentgate:request:{requestId}` index key from Redis directly — simulating expiry. The second `requestAccess` call with the same `requestId` creates a new challenge with a different `challengeId`, proving the idempotency window is bounded by the key's TTL.

---

### `double-spend.test.ts` — Double Spend Protection (1 test)

Verifies that a signed EIP-3009 authorization cannot be reused across two challenges.

Does a full purchase and gets a grant. Then submits the exact same `payment-signature` on a new challenge. The server rejects it with `TX_ALREADY_REDEEMED`. Prevention relies on the `agentgate:seentx:{nonce}` SET NX key in Redis — once a nonce is recorded, the same value can never claim a second challenge.

---

### `wrong-amount.test.ts` — Wrong Amount (1 test)

Verifies that underpayment is rejected before any state is committed.

Signs an EIP-3009 authorization for `1n` micro-USDC (far below the required `100_000n` / $0.10). Settlement rejects it with `AMOUNT_INSUFFICIENT` — the `value` field in the authorization is checked against the required amount before the on-chain call is made.

---

### `wrong-recipient.test.ts` — Wrong Recipient (1 test)

Verifies that payment directed to the wrong address is rejected.

Signs an EIP-3009 authorization with the `to` field set to a random address instead of the AgentGate wallet address. Settlement rejects it with `WRONG_RECIPIENT` — the `payTo` in the authorization must match `config.walletAddress`.

---

### `invalid-tier.test.ts` — Invalid Tier (2 tests)

Verifies tier validation on `POST /x402/access`.

- **Nonexistent tierId**: returns `400 TIER_NOT_FOUND` — challenge creation fails before any PENDING record is written.
- **Missing tierId**: returns `402` discovery response with all available tiers — this is the discovery mode (no PENDING record, just a list of tiers to choose from).

---

### `x402-discovery.test.ts` — x402 Discovery (3 tests)

Verifies the discovery flow: `POST /x402/access` with no `tierId`.

The `/x402/access` endpoint has three modes:
1. **No tierId** → discovery 402: returns all tiers in the `accepts` array with `tierId` in each tier's `extra`. No PENDING record is created. Also validates the `payment-required` header, `www-authenticate` header, and `agentgate` extensions (inputSchema, outputSchema).
2. **tierId, no signature** → challenge 402 (covered by happy-path)
3. **tierId + signature** → settle and grant (covered by happy-path)

---

### `expired-authorization.test.ts` — Expired Authorization (1 test)

Verifies that an EIP-3009 authorization with a `validBefore` timestamp in the past is rejected.

Signs a `TransferWithAuthorization` with `validBeforeOverride: 1n` (Unix epoch + 1 second — far in the past). The settlement layer's `verify()` checks `block.timestamp <= validBefore` and rejects the authorization before any on-chain call. No gas is spent.

---

### `idempotent-challenge.test.ts` — Idempotent Challenge (1 test)

Verifies that the same `requestId` always returns the same `challengeId` within the TTL window.

Calls `requestAccess` twice with identical `requestId`. Both responses return the same `challengeId`. The `agentgate:request:{requestId}` index key in Redis ensures the second call finds and returns the existing challenge instead of creating a new one.

---

### `token-issuance-failure.test.ts` — Token Issuance Failure (1 test)

Verifies the critical invariant: **a PAID record stays PAID when the downstream token issuance fails.**

Puts the backend into "fail" mode (`POST /test/set-mode`). Does a full payment — the gas wallet settles the on-chain USDC transfer successfully. The server calls `POST /internal/issue-token`, gets 500, and returns an error to the client. The challenge record in Redis is checked directly: it must be `PAID`, not rolled back to `PENDING` and not lost. This guarantees the refund cron can find and refund the payment.

---

### `refund-success.test.ts` — Refund Success (1 test)

Verifies the refund cron picks up a PAID record and returns USDC to the original payer.

Writes a PAID record directly into Redis via `writePaidChallengeRecord` (bypasses the full payment flow to avoid cost and latency). The record has `fromAddress = CLIENT_WALLET_ADDRESS`, `amountRaw = 10_000n` ($0.01 USDC), and `paidAt` set 10 seconds in the past — already past the 3-second `REFUND_MIN_AGE_MS`. The test polls `readChallengeState()` every second until it becomes `"REFUNDED"` (within 30 seconds).

Internally, the cron:
1. Queries the `agentgate:paid` sorted set for records older than `REFUND_MIN_AGE_MS`.
2. Atomically transitions the record `PAID → REFUND_PENDING` (prevents double-refund across instances).
3. Sends USDC back to `fromAddress` via EIP-3009 `transferWithAuthorization` — the gas wallet pays the gas.
4. Transitions `REFUND_PENDING → REFUNDED` with the `refundTxHash`.

USDC cost per run: ~$0.01.

---

### `refund-failure.test.ts` — Refund Failure (1 test)

Verifies that when the AGENTGATE wallet has 0 USDC, the refund fails gracefully — the record transitions to `REFUND_FAILED` rather than being stuck in `REFUND_PENDING` indefinitely.

Uses a **separate Docker stack** (`docker-compose.e2e-refund-fail.yml`) where `AGENTGATE_WALLET_PRIVATE_KEY` is set to a deterministic unfunded key (`0x...1234`) — an address that has never held USDC on any testnet. Writes a PAID record to that stack's Redis. The cron runs, attempts `transferWithAuthorization`, the USDC contract reverts (insufficient balance), the exception is caught, and the record transitions to `REFUND_FAILED`.

---

### `concurrent-purchases.test.ts` — Concurrent Purchases (1 test)

Verifies that two clients purchasing simultaneously both succeed with distinct grants — no race condition on the gas wallet nonce.

Fires `purchaseAccess()` from two `E2eTestClient` instances (CLIENT and GAS wallets) simultaneously via `Promise.all`. Both payments arrive at the server at the same time. The server serializes the two gas wallet settlement calls using a Redis distributed lock (`agentgate:settle-lock:{walletPrefix}` with SET NX) — preventing both from reading the same pending nonce. Both settle successfully, return distinct `AccessGrant`s with distinct `txHash`es, and both challenge records end up in `DELIVERED` state.

---

### `concurrent-same-challenge.test.ts` — Concurrent Same-Challenge Proof (1 test)

Verifies the pre-settlement check prevents duplicate on-chain settlement when two clients race to submit proof for the **same** requestId.

Client A requests a challenge. Both Client A and Client B sign independent EIP-3009 authorizations and submit payment simultaneously via `Promise.all`. The first to settle creates PENDING → PAID → DELIVERED. The second hits the pre-settlement check, finds DELIVERED, and gets the cached grant WITHOUT burning USDC on-chain. Both get 200 — no fund loss, no 500 errors, challenge ends in DELIVERED.

---

### `already-redeemed.test.ts` — Already Redeemed (2 tests)

Verifies the `PROOF_ALREADY_REDEEMED` recovery paths — the middleware now returns the `AccessGrant` directly (not wrapped in an error envelope) for better client UX.

- **Re-submit payment after DELIVERED**: Completes a full purchase, then re-submits a payment with the same `requestId`. The pre-settlement check finds DELIVERED and returns the cached grant (200 with `type: "AccessGrant"`) without settling on-chain. Verifies the same `challengeId` and `accessToken` are returned.
- **Re-request access (no payment) after DELIVERED**: Same `requestId` → engine throws `PROOF_ALREADY_REDEEMED` → middleware returns the grant directly as 200 with `type: "AccessGrant"`.

---

### `expired-challenge-proof.test.ts` — Expired Challenge Proof (2 tests)

Verifies proof submission is rejected after a challenge expires (distinct from `expired-authorization.test.ts` which tests an expired EIP-3009 signature). The pre-settlement check rejects EXPIRED challenges before any on-chain settlement — no USDC is burned.

- **Proof after expiry**: Creates a challenge, sets state to `EXPIRED` in Redis, then submits a valid payment. The pre-settlement check rejects it (not 200, no on-chain settlement). State must remain `EXPIRED`.
- **Re-request after expiry**: Same `requestId` after expiry creates a new challenge with a different `challengeId`.

---

### `happy-path-state-verification.test.ts` — Happy Path State Verification (3 tests)

Extends the basic happy-path test with Redis state assertions at each lifecycle step.

- **PENDING → DELIVERED with fields**: After requesting access, verifies the Redis hash contains correct `requestId`, `tierId`, `resourceId`, `destination`, `asset`, `chainId`. After payment, verifies `DELIVERED` state with `txHash`, `paidAt`, and the stored `accessGrant` JSON matching the returned grant.
- **resourceEndpoint format**: Verifies the grant's `resourceEndpoint` contains the requested `resourceId`.
- **explorerUrl format**: Verifies the grant's `explorerUrl` contains `sepolia` (Base Sepolia) and the `txHash`.

---

### `cancel-challenge.test.ts` — Cancel Challenge (2 tests)

Verifies the `PENDING → CANCELLED` transition and its effects.

- **Proof after cancel**: Creates a challenge, atomically transitions it to `CANCELLED` via a Lua script (mimicking `engine.cancelChallenge()`), then submits a valid payment. Must be rejected.
- **Re-request after cancel**: Same `requestId` after cancellation creates a new `PENDING` challenge.

---

### `refund-batch.test.ts` — Refund Batch Processing (1 test)

Verifies the refund cron handles multiple PAID records in a single cycle.

Writes 3 PAID records to Redis (all past `REFUND_MIN_AGE_MS`), then polls until all have transitioned. All 3 must reach `REFUNDED` state, confirming the cron processes batches rather than one record per cycle.

USDC cost per run: ~$0.03 (3 x $0.01 refunds).

---

## Infrastructure Notes

**Refund cron timings** (configured in `docker-compose.e2e.yml` for speed):
- `REFUND_INTERVAL_MS=5000` — cron fires every 5 seconds
- `REFUND_MIN_AGE_MS=3000` — records must be at least 3 seconds old to be eligible
- `REFUND_POLL_TIMEOUT_MS=30_000` — test polls for up to 30 seconds

**Redis port:** Docker Redis is mapped to `localhost:6380` (not 6379) to avoid conflict with any locally running Redis.

**Gas wallet settlement lock:** When Redis is available, concurrent `settleViaGasWallet` calls are serialized via a Redis lock (`agentgate:settle-lock:{prefix}`, TTL 60s) — safe across multiple instances. Without Redis, falls back to an in-process promise queue (single instance only).

**Sorted set atomicity:** The `agentgate:paid` sorted set is updated inside the same Lua script as the state transition — both the hash write and the ZADD/ZREM are atomic. A process crash cannot leave a PAID record outside the sorted set where the refund cron would never find it.
