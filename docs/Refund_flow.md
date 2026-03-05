# Refund Flow

This document covers the refund system built into the SDK — what it tracks, how each state transition works, how a seller wires it up, and how to handle failures.

---

## The Core Idea

When a buyer pays for a resource, the SDK records the payment in a single `ChallengeRecord`. Both payment paths — A2A (`requestAccess` / `submitProof`) and HTTP x402 (`requestHttpAccess` / `processHttpPayment`) — follow the same lifecycle: `PENDING → PAID → DELIVERED`.

After payment is verified, the SDK automatically issues the access token and transitions the record to `DELIVERED` in the same request.

If `onIssueToken` throws or the server crashes between payment verification and token issuance, the record stays `PAID`. The refund cron picks it up after a configurable grace period and sends the USDC back to the buyer's wallet.

There is no separate delivery store. One store, one record, one lifecycle.

---

## State Machine

```
PENDING ──── payment verified on-chain ──────────────────────► PAID
PENDING ──── challenge TTL exceeded ─────────────────────────► EXPIRED
PENDING ──── seller cancels ─────────────────────────────────► CANCELLED

PAID ────── onIssueToken() succeeds (SDK auto-transitions) ──► DELIVERED      ← happy path, final
PAID ────── cron: paidAt + minAgeMs <= now ──────────────────► REFUND_PENDING
REFUND_PENDING ── sendUsdc() succeeds ───────────────────────► REFUNDED       ← refunded, final
REFUND_PENDING ── sendUsdc() throws ─────────────────────────► REFUND_FAILED  ← needs operator
```

`PAID` is transient in the normal path — it lasts milliseconds between payment verification and token issuance. The refund cron is a safety net for failures only (server crashes, `onIssueToken` errors). `DELIVERED` is set automatically by the SDK after token issuance.

---

## ChallengeRecord Fields

Each record carries the full lifecycle. Fields are written exactly once — at the transition that produces them.


| Field          | Type             | Written at                                                |
| -------------- | ---------------- | --------------------------------------------------------- |
| `challengeId`  | `string`         | creation                                                  |
| `state`        | `ChallengeState` | every transition                                          |
| `txHash`       | `0x${string}`    | `PENDING → PAID`                                          |
| `paidAt`       | `Date`           | `PENDING → PAID`                                          |
| `fromAddress`  | `0x${string}`    | `PENDING → PAID` (A2A: from on-chain Transfer event; HTTP x402: from settlement payer) |
| `accessGrant`  | `AccessGrant`    | `PAID → DELIVERED`                                        |
| `deliveredAt`  | `Date`           | `PAID → DELIVERED`                                        |
| `refundTxHash` | `0x${string}`    | `REFUND_PENDING → REFUNDED`                               |
| `refundedAt`   | `Date`           | `REFUND_PENDING → REFUNDED`                               |
| `refundError`  | `string`         | `REFUND_PENDING → REFUND_FAILED`                          |


`fromAddress` is the buyer's wallet address. In the A2A flow, the SDK extracts it from the `Transfer(from, to, value)` event log during on-chain verification. In the HTTP x402 flow, it comes from the `payer` field returned by the gas wallet or facilitator settlement response. In both cases, the seller never needs to pass it explicitly.

---

## Payment Paths

Both payment paths share the same `ChallengeRecord` lifecycle. The refund cron does not distinguish between them — it queries for `PAID` records with a `fromAddress` and `amountRaw`, regardless of origin.

### A2A Flow (Agent-to-Agent)

1. `requestAccess()` — validates tier, verifies resource, calls `adapter.issueChallenge()`, creates `PENDING` record, returns `X402Challenge`
2. `submitProof()` — looks up `PENDING` record, verifies on-chain via `adapter.verifyProof()`, transitions `PENDING → PAID` (with `txHash`, `paidAt`, `fromAddress` from Transfer event), calls `onIssueToken`, transitions `PAID → DELIVERED`

### HTTP x402 Flow (Gas Wallet / Facilitator)

1. `requestHttpAccess()` — validates tier, verifies resource, creates `PENDING` record (no adapter challenge needed — the 402 response carries x402 payment requirements instead), returns `challengeId`
2. `processHttpPayment()` — looks up `PENDING` record (auto-creates one if step 1 was skipped), transitions `PENDING → PAID` (with `txHash`, `paidAt`, `fromAddress` from settlement payer), calls `onIssueToken`, transitions `PAID → DELIVERED`

If `onIssueToken` throws in either path, the record stays `PAID` and the refund cron picks it up.

---

## API Reference

### `processRefunds(config)`

Scan for all `PAID` records older than `minAgeMs`, atomically claim each one, send USDC back to the buyer, and write the result. Designed to be called from a periodic job.

```typescript
import { processRefunds } from '@riklr/agentgate';

const results = await processRefunds({
  store,
  walletPrivateKey: '0x...',
  network: 'mainnet',       // 'mainnet' | 'testnet'
  minAgeMs: 5 * 60 * 1000, // 5-minute grace period (default)
});

// results: RefundResult[]
// [
//   { challengeId, originalTxHash, refundTxHash, amount, toAddress, success: true }
//   { challengeId, originalTxHash, amount, toAddress, success: false, error: '...' }
// ]
```

**Config options:**


| Option             | Type                    | Default           | Description                                   |
| ------------------ | ----------------------- | ----------------- | --------------------------------------------- |
| Option              | Type                    | Default           | Description                                   |
| ------------------- | ----------------------- | ----------------- | --------------------------------------------- |
| `store`             | `IChallengeStore`       | required          | The same store passed to `createAgentGate`    |
| `walletPrivateKey`  | `0x${string}`           | required          | Seller wallet used to send USDC back          |
| `network`           | `'mainnet' \| 'testnet'` | required         | Determines USDC contract and RPC endpoint     |
| `minAgeMs`          | `number`                | `300_000` (5 min) | Grace period before a PAID record is eligible |


---

## Store TTLs

Records are automatically cleaned up based on their final state. Redis is the only supported store — TTLs are managed via Redis key expiry.

### Redis Store


| Key                                      | TTL                                       |
| ---------------------------------------- | ----------------------------------------- |
| `agentgate:challenge:{id}` (hash)        | **7 days** (set at creation)              |
| `agentgate:request:{requestId}` (string) | `challengeTTLSeconds` (900s default)      |
| `agentgate:paid` (sorted set)            | no expiry — members removed on transition |


On `PAID → DELIVERED`, the SDK immediately calls `EXPIRE agentgate:challenge:{id} 43200` to shorten the hash key TTL to **12 hours**. No background job needed — the TTL reset happens inside the same transition call.

**Configuring TTLs on the Redis store:**

```typescript
new RedisChallengeStore({
  redis,
  recordTTLSeconds: 604_800,  // 7 days (default)
  deliveredTTLSeconds: 43_200, // 12 hours (default)
  challengeTTLSeconds: 900,    // 15 min — request index key only (default)
})
```

---

## Usage Examples

### Full setup — Redis and refund cron

```typescript
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import {
  createAgentGate,
  X402Adapter,
  RedisChallengeStore,
  RedisSeenTxStore,
  processRefunds,
} from '@riklr/agentgate';

const redis = new Redis(process.env.REDIS_URL);

const store = new RedisChallengeStore({
  redis,
  recordTTLSeconds: 604_800,   // 7 days — full lifecycle
  deliveredTTLSeconds: 43_200, // 12 hours — after delivery confirmed
});

const seenTxStore = new RedisSeenTxStore({ redis });

const { requestHandler } = createAgentGate({
  store,
  seenTxStore,
  adapter: new X402Adapter({ network: 'mainnet' }),
  config: {
    walletAddress: process.env.SELLER_ADDRESS,
    network: 'mainnet',
    products: [
      { tierId: 'report-v1', amount: '$2.00' },
    ],
    onVerifyResource: async (id) => db.resources.exists(id),
    onIssueToken: async ({ challengeId, resourceId, tierId }) => ({
      token: jwt.sign({ jti: challengeId, sub: resourceId, tier: tierId }, SECRET, { expiresIn: '2h' }),
      expiresAt: new Date(Date.now() + 7200_000),
    }),
  },
});

// Protected resource endpoint — no extra call needed, SDK handles DELIVERED automatically
app.get('/api/reports/:id', validateToken, async (req, res) => {
  const report = await db.reports.findById(req.params.id);
  res.json(report);
});

// Refund cron — runs every minute, safety net for onIssueToken failures or server crashes
const refundQueue = new Queue('refunds', { connection: redis });

new Worker('refunds', async () => {
  const results = await processRefunds({
    store,
    walletPrivateKey: process.env.SELLER_PRIVATE_KEY,
    network: 'mainnet',
    minAgeMs: 5 * 60 * 1000, // 5-minute grace period
  });

  for (const result of results) {
    if (result.success) {
      console.log(`Refunded ${result.amount} to ${result.toAddress} — tx ${result.refundTxHash}`);
    } else {
      console.error(`Refund FAILED for ${result.challengeId}: ${result.error}`);
      await alerting.send(`Refund failed — challengeId: ${result.challengeId}, error: ${result.error}`);
    }
  }
}, { connection: redis });

// Schedule the cron
await refundQueue.add('process', {}, { repeat: { every: 60_000 } });
```

---

## How the Cron Prevents Double-Refunds

The transition `PAID → REFUND_PENDING` is atomic. A Lua script runs atomically on the Redis server:

```lua
local current = redis.call('HGET', KEYS[1], 'state')
if current ~= ARGV[1] then
  return 0  -- state mismatch — another worker claimed it first
end
redis.call('HSET', KEYS[1], 'state', ARGV[2])
-- write any additional field/value pairs
return 1
```

If two cron workers fire at exactly the same time, both read `PAID`. The first Lua call succeeds and returns `1`. The second Lua call sees `REFUND_PENDING` and returns `0`. The second worker calls `continue` and moves on. Only one USDC transfer is ever broadcast.

---

## How findPendingForRefund Works

Uses a sorted set `agentgate:paid` (member = `challengeId`, score = `paidAt` epoch ms) maintained alongside the hash:

- On `PENDING → PAID`: `ZADD agentgate:paid <paidAt_ms> <challengeId>`
- On `PAID → anything`: `ZREM agentgate:paid <challengeId>`

Query:

```
ZRANGEBYSCORE agentgate:paid 0 <(now - minAgeMs)>
```

Returns all challengeIds whose `paidAt` is older than the grace period in O(log N + M) time. Each result is fetched and verified (`state === "PAID"`, `fromAddress` present) before being returned.

---

## REFUND_FAILED — What To Do

`REFUND_FAILED` is a terminal state. The cron will not pick it up again (`findPendingForRefund` only returns `PAID` records). Common causes:

- Seller wallet has insufficient ETH for gas
- RPC endpoint is down or rate-limited
- `sendUsdc` threw an unexpected error

The `refundError` string is written to the record. The `RefundResult` returned by `processRefunds` has `success: false` and `error` set. Recommended handling:

1. Log and alert immediately — `results.filter(r => !r.success)`.
2. Inspect the record via `store.get(challengeId)` — `refundError` has the raw message.
3. Retry manually once the underlying cause is resolved: top up ETH, restore RPC, then call `processRefunds` again after manually resetting the state, or build a dedicated `retryFailedRefunds` utility that transitions `REFUND_FAILED → PAID` and lets the cron pick it up naturally.

---

## Timing Diagrams

### A2A Flow

```
t=0:00   requestAccess() called
         store: create PENDING record
         X402Challenge returned to buyer agent

t=?      Buyer pays on-chain, calls submitProof()
         SDK verifies Transfer event, extracts fromAddress
         store: PENDING → PAID  { txHash, paidAt, fromAddress }
         onIssueToken() → JWT issued
         store: PAID → DELIVERED  { accessGrant, deliveredAt }
         Redis TTL reset from 7 days → 12 hours
         AccessGrant returned to buyer
         Record deleted after 12 hours
```

### HTTP x402 Flow

```
t=0:00   Client sends AccessRequest without PAYMENT-SIGNATURE
         requestHttpAccess() called
         store: create PENDING record (clientAgentId = "x402-http")
         HTTP 402 returned with payment requirements + challengeId

t=?      Client sends AccessRequest with PAYMENT-SIGNATURE
         Gas wallet / facilitator settles payment on-chain
         processHttpPayment() called with requestId + payer
         store: look up PENDING record via requestId
         store: PENDING → PAID  { txHash, paidAt, fromAddress (= payer) }
         onIssueToken() → JWT issued
         store: PAID → DELIVERED  { accessGrant, deliveredAt }
         Redis TTL reset from 7 days → 12 hours
         AccessGrant returned to client
         Record deleted after 12 hours
```

### Refund (both paths)

```
         ── if onIssueToken throws or server crashes between PAID and DELIVERED ──

t=5:00   Grace period expires (minAgeMs = 300_000)
         Cron runs processRefunds()
         findPendingForRefund finds the record (still PAID)
         store: PAID → REFUND_PENDING  (atomic claim)
         sendUsdc(to: fromAddress, amount: amountRaw)
         ├── success:  REFUND_PENDING → REFUNDED  { refundTxHash, refundedAt }
         └── failure:  REFUND_PENDING → REFUND_FAILED  { refundError }
         Record retained for 7 days from createdAt, then deleted
```

