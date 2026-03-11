# Key0 Payment Flow — Complete Lifecycle

This document is the source of truth for the full payment lifecycle, state machine, Redis schema, HTTP request/response structures, settlement strategies, and security checks.

---

## Table of Contents

1. [Overview](#overview)
2. [State Machine](#state-machine)
3. [Redis Schema](#redis-schema)
4. [Payment Flow](#payment-flow)
5. [Transports (Entry Points)](#transports-entry-points)
6. [Settlement Strategies](#settlement-strategies)
7. [Token Issuance & Validation](#token-issuance--validation)
8. [Refund Lifecycle](#refund-lifecycle)
9. [Error Codes Reference](#error-codes-reference)
10. [Security Checks Summary](#security-checks-summary)

---

## Overview

Key0 uses a **two-phase payment flow**: the client first requests access (receiving a payment challenge), then signs an EIP-3009 authorization off-chain. The server (or a facilitator) settles on-chain. The client never sends a transaction directly.

```
┌─────────────────────────────────────────────────────────────┐
│                     ChallengeEngine                         │
│                                                             │
│    requestAccess() / requestHttpAccess()   ← Phase 1       │
│         → settlePayment() (transport layer)                 │
│              → processHttpPayment()        ← Phase 2       │
└─────────────────────────────────────────────────────────────┘
              ▲               ▲               ▲
              │               │               │
     ┌────────┴──┐   ┌───────┴──────┐   ┌────┴──────────┐
     │ /x402/    │   │ {basePath}/  │   │ {basePath}/   │
     │ access    │   │ jsonrpc      │   │ jsonrpc       │
     │ (REST)    │   │ (middleware) │   │ (A2A executor)│
     └───────────┘   └──────────────┘   └───────────────┘
```

Three transports share the same `ChallengeEngine`, Redis stores, state machine, and settlement logic. They differ only in how the HTTP request arrives and how the response is formatted.

### Key Files


| Component                   | File                                            |
| --------------------------- | ----------------------------------------------- |
| Challenge Engine            | `src/core/challenge-engine.ts`                  |
| Types & State               | `src/types/challenge.ts`, `src/types/errors.ts` |
| Redis Storage               | `src/core/storage/redis.ts`                     |
| Access Token                | `src/core/access-token.ts`                      |
| Settlement                  | `src/integrations/settlement.ts`                |
| x402 HTTP Middleware        | `src/integrations/x402-http-middleware.ts`      |
| Express Integration         | `src/integrations/express.ts`                   |
| A2A Executor                | `src/executor.ts`                               |
| Factory                     | `src/factory.ts`                                |
| Auth Helpers                | `src/helpers/auth.ts`, `src/helpers/remote.ts`  |
| Token Validation Middleware | `src/middleware.ts`                             |
| USDC Send (Refunds)         | `src/adapter/send-usdc.ts`                      |


---

## State Machine

```
                    requestAccess / requestHttpAccess
                              |
                              v
                         +---------+
                         | PENDING |
                         +---------+
                        /    |      \
                       /     |       \
              expired /  processHttp  \ cancelChallenge
                     /       |         \
                    v        |          v
              +---------+   |     +-----------+
              | EXPIRED |   |     | CANCELLED |
              +---------+   |     +-----------+
                            v
                         +------+
                         | PAID |
                         +------+
                        /        \
            onIssueToken          \  refund cron (minAgeMs elapsed)
              success              \
                  |                 v
                  v           +----------------+
            +-----------+     | REFUND_PENDING |
            | DELIVERED |     +----------------+
            +-----------+      /             \
                              v               v
                       +----------+    +---------------+
                       | REFUNDED |    | REFUND_FAILED |
                       +----------+    +---------------+
```

### States


| State            | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `PENDING`        | Awaiting payment                                               |
| `PAID`           | Payment verified on-chain, awaiting token issuance and delivery |
| `DELIVERED`      | Final success state — resource served                          |
| `EXPIRED`        | Challenge timed out                                            |
| `CANCELLED`      | Manually cancelled                                             |
| `REFUND_PENDING` | Cron claimed record, refund tx being broadcast                 |
| `REFUNDED`       | Refund sent on-chain — final state                             |
| `REFUND_FAILED`  | Refund tx threw — needs operator attention                     |


### Allowed Transitions

| From           | To             | Trigger                                     | Fields Written                           |
| -------------- | -------------- | ------------------------------------------- | ---------------------------------------- |
| *(new)*        | PENDING        | `create()`                                  | All base fields                          |
| PENDING        | PAID           | `processHttpPayment()`                      | `txHash`, `paidAt`, `fromAddress`        |
| PENDING        | EXPIRED        | Expiry check on access                      | —                                        |
| PENDING        | CANCELLED      | `cancelChallenge()`                         | —                                        |
| PAID           | PAID           | Grant persisted (outbox)                    | `accessGrant` (full JSON)                |
| PAID           | DELIVERED      | Token issued successfully                   | `accessGrant` (full JSON), `deliveredAt` |
| PAID           | PENDING        | `markUsed()` race rollback (extremely rare) | —                                        |
| PAID           | REFUND_PENDING | Refund cron claims record                   | —                                        |
| REFUND_PENDING | REFUNDED       | Refund tx confirmed                         | `refundTxHash`, `refundedAt`             |
| REFUND_PENDING | REFUND_FAILED  | Refund tx failed                            | `refundError`                            |

All transitions use **atomic Lua scripts** — if `currentState != expectedFromState`, the transition returns `false` and no fields are written.

---

## Redis Schema

### Health Check

`RedisChallengeStore` exposes a `healthCheck()` method that sends a `PING` to Redis and throws if the response is not `PONG`. This is **not called automatically** by `createKey0()` — callers should invoke it at startup for fail-fast behavior:

```ts
const { engine, store } = createKey0(config);
await store.healthCheck(); // throws if Redis is unreachable
```

### Key Naming Convention

All keys use the prefix `key0` (configurable via `keyPrefix`).

### 1. Challenge Record Hash — `key0:challenge:{challengeId}`

Stored as a Redis Hash (`HSET`/`HGETALL`). Each field is a string.


| Hash Field      | Type            | Set When                       | Example                                       |
| --------------- | --------------- | ------------------------------ | --------------------------------------------- |
| `challengeId`   | string          | CREATE                         | `"http-a1b2c3d4-..."` or UUID                 |
| `requestId`     | string          | CREATE                         | `"550e8400-e29b-..."` (client-generated UUID) |
| `clientAgentId` | string          | CREATE                         | `"did:web:agent.example"` or `"x402-http"`    |
| `resourceId`    | string          | CREATE                         | `"photo-123"` or `"default"`                  |
| `tierId`        | string          | CREATE                         | `"basic"`                                     |
| `amount`        | string          | CREATE                         | `"$0.10"`                                     |
| `amountRaw`     | string (bigint) | CREATE                         | `"100000"` (USDC 6-decimal micro-units)       |
| `asset`         | string          | CREATE                         | `"USDC"`                                      |
| `chainId`       | string (number) | CREATE                         | `"84532"` (Base Sepolia) or `"8453"` (Base)   |
| `destination`   | string (0x)     | CREATE                         | `"0xAbCd..."` (seller wallet)                 |
| `state`         | string          | CREATE, updated on transitions | `"PENDING"` / `"PAID"` / `"DELIVERED"` / etc. |
| `expiresAt`     | ISO-8601 string | CREATE                         | `"2025-03-05T12:30:00.000Z"`                  |
| `createdAt`     | ISO-8601 string | CREATE                         | `"2025-03-05T12:15:00.000Z"`                  |
| `txHash`        | string (0x)     | PENDING→PAID                   | `"0x1234..."`                                 |
| `paidAt`        | ISO-8601 string | PENDING→PAID                   | `"2025-03-05T12:16:00.000Z"`                  |
| `fromAddress`   | string (0x)     | PENDING→PAID                   | `"0xBuyer..."` (payer wallet)                 |
| `accessGrant`   | JSON string     | PAID→DELIVERED                 | Full `AccessGrant` object                     |
| `deliveredAt`   | ISO-8601 string | PAID→DELIVERED                 | `"2025-03-05T12:16:05.000Z"`                  |
| `refundTxHash`  | string (0x)     | REFUND_PENDING→REFUNDED        | `"0xRefund..."`                               |
| `refundedAt`    | ISO-8601 string | REFUND_PENDING→REFUNDED        | `"2025-03-05T12:21:00.000Z"`                  |
| `refundError`   | string          | REFUND_PENDING→REFUND_FAILED   | `"insufficient gas"`                          |


**TTL**: 7 days (`recordTTLSeconds`, default 604,800s). Shortened to 12 hours (`deliveredTTLSeconds`, default 43,200s) when state reaches DELIVERED.

### 2. Request Index — `key0:request:{requestId}`

A simple `SET` key mapping `requestId -> challengeId`. Used for **idempotency**: if the same `requestId` is submitted again, the existing challenge is returned instead of creating a new one.

```
KEY:   key0:request:550e8400-e29b-...
VALUE: http-a1b2c3d4-...
TTL:   900s (challengeTTLSeconds)
```

### 3. Seen Transaction Set — `key0:seentx:{txHash}`

A simple `SET NX` key for **double-spend prevention**. Maps `txHash -> challengeId`.

```
KEY:   key0:seentx:0x1234abcd...
VALUE: http-a1b2c3d4-...
TTL:   7 days (604,800s)
```

### 4. Paid Set (Sorted Set) — `key0:paid`

A Redis Sorted Set tracking PAID records for the refund cron.

```
ZADD key0:paid <paidAt_epoch_ms> <challengeId>
```


| Operation                  | When                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `ZADD`                     | State transitions to PAID (score = `paidAt` epoch ms)            |
| `ZREM`                     | State transitions FROM PAID (to DELIVERED, REFUND_PENDING, etc.) |
| `ZRANGEBYSCORE 0 <cutoff>` | Refund cron queries records older than `minAgeMs`                |


### Redis Commands Per Operation

| Operation                 | Redis Commands                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **create**                | Pipeline: `EXISTS` (guard) + `HSET` (challenge hash) + `EXPIRE` (7d) + `SET EX` (request index, 900s)            |
| **get**                   | `HGETALL`                                                                                                         |
| **findActiveByRequestId** | `GET` (request index) → `HGETALL` (challenge hash)                                                                |
| **transition**            | `EVAL` (Lua: check state + `HSET` + conditional `ZADD`/`ZREM`) + conditional `EXPIRE` (if DELIVERED)              |
| **markUsed**              | `SET NX EX` (7d)                                                                                                  |
| **findPendingForRefund**  | `ZRANGEBYSCORE` → N x (`HGETALL` + conditional `ZREM` for ghost entries)                                          |
| **healthCheck**           | `PING`                                                                                                            |

### Lua Script (Atomic Transition)

```lua
local current = redis.call('HGET', KEYS[1], 'state')
if current ~= ARGV[1] then
  return 0  -- state mismatch, transition rejected
end
local fromState = ARGV[1]
local toState = ARGV[2]
local challengeId = ARGV[3]
local score = ARGV[4]
redis.call('HSET', KEYS[1], 'state', toState)
for i = 5, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
end
if toState == 'PAID' and score ~= '' then
  redis.call('ZADD', KEYS[2], score, challengeId)
elseif fromState == 'PAID' then
  redis.call('ZREM', KEYS[2], challengeId)
end
return 1
```

- `KEYS[1]` = `key0:challenge:{challengeId}`
- `KEYS[2]` = `key0:paid`
- `ARGV[1]` = fromState, `ARGV[2]` = toState, `ARGV[3]` = challengeId, `ARGV[4]` = paidAt epoch ms (or ""), `ARGV[5..N]` = field/value pairs.

The `EXPIRE` call that shortens TTL to 12 hours on DELIVERED is done **outside** the Lua script (TTL adjustment is not a correctness invariant).

---

## Payment Flow

The client signs an EIP-3009 `transferWithAuthorization` off-chain. The server (or a facilitator) settles on-chain. The client never sends a transaction directly.

### Phase 1 — Challenge

Engine method: `requestAccess()` or `requestHttpAccess()`

1. Validate `requestId` (UUID format)
2. Extract/default `resourceId` (`"default"`) and `clientAgentId` (`"anonymous"` or `"x402-http"`)
3. Look up `tierId` in `SellerConfig.products` — throw `TIER_NOT_FOUND` (400) if missing
4. Call `onVerifyResource(resourceId, tierId)` with timeout (default 5s, configurable via `resourceVerifyTimeoutMs`)
  - Timeout → `RESOURCE_VERIFY_TIMEOUT` (504)
  - Returns false → `RESOURCE_NOT_FOUND` (404)
5. **Idempotency check**: `store.findActiveByRequestId(requestId)`
  - If PENDING and not expired → return existing challenge
  - If DELIVERED with grant → throw `PROOF_ALREADY_REDEEMED` (200, includes grant in details)
  - If EXPIRED/CANCELLED → fall through to create new
6. Generate `challengeId` (UUID via adapter for A2A, `http-{uuid}` for HTTP)
7. Create PENDING `ChallengeRecord`, store via `store.create()`
8. Return `X402Challenge` (A2A) or `{ challengeId }` (HTTP)

### Phase 2 — Settlement + Token Issuance

The transport layer first verifies the resource via `engine.verifyResource()`, then calls `settlePayment()` to settle the EIP-3009 signature on-chain, then passes the result to `engine.processHttpPayment()`.

**Important**: Resource verification happens BEFORE settlement to avoid money-at-risk (if a resource disappears between challenge and payment, the client is not charged).

Engine method: `processHttpPayment(requestId, tierId, resourceId, txHash, fromAddress?)`

1. Look up tier (resource verification is NOT done here — callers must verify before settlement)
2. **Double-spend guard**: `seenTxStore.get(txHash)` — throw `TX_ALREADY_REDEEMED` (409)
3. Find PENDING record by `requestId` — or auto-create one if challenge phase was skipped or expired
4. **Atomic transition**: PENDING → PAID (with `txHash`, `paidAt`, `fromAddress`)
5. **Mark txHash**: `seenTxStore.markUsed(txHash, challengeId)` — SET NX
   - If returns `false` → rollback PAID→PENDING, throw `TX_ALREADY_REDEEMED` (409)
6. **Issue token**: call `config.onIssueToken({ requestId, challengeId, resourceId, tierId, txHash })` with timeout (`tokenIssueTimeoutMs`, default 15s) and retry (`tokenIssueRetries`, default 2 attempts with exponential backoff)
7. Build `AccessGrant` object
8. **Persist grant (outbox pattern)**: PAID → PAID write with `accessGrant` stored — ensures grant is durable before returning to client
9. **Mark DELIVERED (best-effort)**: PAID → DELIVERED (with `deliveredAt`) — if this fails, the record stays PAID with `accessGrant` set; the refund cron skips records that already have `accessGrant`
10. Fire `onPaymentReceived` hook (async, non-blocking, logs `challengeId` on error)
11. Return `AccessGrant`

### Phase 3 — Access Protected Resource

```
POST /api/photos/photo-123
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Middleware (`validateAccessToken`) verifies JWT, attaches decoded claims to request as `req.key0Token`.

### Redis Example (End to End)

**After Phase 1 (challenge created):**

```
key0:challenge:http-a1b2c3d4-...  (HASH, TTL 7d)
  challengeId = http-a1b2c3d4-...
  requestId   = 550e8400-...
  state       = PENDING
  amount      = $0.10
  amountRaw   = 100000
  asset       = USDC
  chainId     = 84532
  destination = 0xSeller...
  expiresAt   = 2025-03-05T12:30:00.000Z
  createdAt   = 2025-03-05T12:15:00.000Z
  clientAgentId = x402-http

key0:request:550e8400-...  (STRING, TTL 900s)
  = http-a1b2c3d4-...
```

**After Phase 2 (payment settled, token issued):**

```
key0:challenge:http-a1b2c3d4-...  (HASH, TTL reset to 12h)
  state       = DELIVERED
  txHash      = 0xabcdef...
  paidAt      = 2025-03-05T12:16:00.000Z
  fromAddress = 0xBuyer...
  accessGrant = {"type":"AccessGrant",...}
  deliveredAt = 2025-03-05T12:16:05.000Z
  ... (all original fields unchanged)

key0:seentx:0xabcdef...  (STRING, TTL 7d)
  = http-a1b2c3d4-...

key0:paid  (SORTED SET)
  (challengeId was added then removed -- net empty for this challenge)
```

---

## Transports (Entry Points)

Three "front doors" feed into the same payment flow. They differ only in how the HTTP request arrives and how the response is formatted.

### Transport 1: `/x402/access` (Simple REST)

A plain REST endpoint — no JSON-RPC wrapping. Mounted at `POST /x402/access` by the Express integration.

**Three cases based on request shape:**

#### Case 1: Discovery (no `tierId`) → HTTP 402

```
POST /x402/access
Content-Type: application/json

{}
```

Returns all available product tiers. No PENDING record is created.

```
HTTP/1.1 402 Payment Required
payment-required: eyJ4NDAyVm... (base64)
www-authenticate: Payment realm="https://api.example.com", accept="exact"

{
  "x402Version": 2,
  "resource": { "url": "...", "method": "POST", ... },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "100000",
      "payTo": "0xSellerWallet...",
      "maxTimeoutSeconds": 900,
      "extra": { "name": "USDC", "version": "2", "description": "Basic tier - $0.10 USDC" }
    }
  ],
  "error": "Payment required"
}
```

#### Case 2: Challenge (`tierId`, no `payment-signature`) → HTTP 402

```
POST /x402/access
Content-Type: application/json

{ "tierId": "basic", "requestId": "550e8400-...", "resourceId": "photo-123" }
```

`requestId` is auto-generated (`http-{uuid}`) if not provided. Creates PENDING record via `engine.requestHttpAccess()`.

```
HTTP/1.1 402 Payment Required
payment-required: eyJ4NDAyVm... (base64)
www-authenticate: Payment realm="...", accept="exact", challenge="http-a1b2c3d4-..."

{
  "x402Version": 2,
  "accepts": [ ... ],
  "extensions": {
    "key0": { "inputSchema": { ... }, "outputSchema": { ... }, "description": "..." }
  },
  "challengeId": "http-a1b2c3d4-...",
  "error": "Payment required"
}
```

#### Case 3: Settlement (`tierId` + `payment-signature` header) → HTTP 200

```
POST /x402/access
Content-Type: application/json
payment-signature: eyJ4NDAyVm... (base64-encoded X402PaymentPayload)

{ "tierId": "basic", "requestId": "550e8400-...", "resourceId": "photo-123" }
```

Server decodes header → `engine.verifyResource()` → `settlePayment()` → `engine.processHttpPayment()` → returns `AccessGrant`.

```
HTTP/1.1 200 OK
payment-response: eyJzdWNjZXNz... (base64-encoded X402SettleResponse)

{
  "type": "AccessGrant",
  "challengeId": "http-a1b2c3d4-...",
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "expiresAt": "2025-03-05T13:15:00.000Z",
  "resourceEndpoint": "https://api.example.com/photos/photo-123",
  "resourceId": "photo-123",
  "tierId": "basic",
  "txHash": "0xSettledTx...",
  "explorerUrl": "https://sepolia.basescan.org/tx/0xSettledTx..."
}
```

### Transport 2: `{basePath}/jsonrpc` with x402 Middleware

The same JSON-RPC endpoint (`POST {basePath}/jsonrpc`) serves both A2A-native agents and plain HTTP clients. The `createX402HttpMiddleware` sits in front of the A2A handler and routes based on headers:

```
POST {basePath}/jsonrpc
        │
        ▼
 x402HttpMiddleware
        │
        ├── Has X-A2A-Extensions header?
        │       YES → pass through to A2A SDK → Key0Executor (Transport 3)
        │
        ├── Not a message/send call?
        │       → pass through
        │
        ├── No AccessRequest in parts?
        │       → pass through
        │
        ├── No payment-signature header?
        │       → engine.requestHttpAccess() → HTTP 402 + payment-required header
        │
        └── Has payment-signature header?
                → engine.verifyResource() → settlePayment() → engine.processHttpPayment() → HTTP 200 + AccessGrant
```

The middleware extracts `AccessRequest` from `params.message.parts` — either a `data` part with `type: "AccessRequest"` or a `text` part containing JSON.

Same settlement logic as Transport 1, just wrapped in JSON-RPC framing.

### Transport 3: A2A Executor (via A2A SDK)

When a native A2A client sends `X-A2A-Extensions` header, the middleware passes through to the A2A SDK, which routes to `Key0Executor`.

**Phase 1 — AccessRequest → Task (`input-required`)**

Client sends A2A `message/send` with `AccessRequest` in message parts.

```json
{
  "method": "message/send",
  "params": {
    "message": {
      "parts": [{ "kind": "data", "data": { "type": "AccessRequest", "tierId": "basic", "requestId": "...", "resourceId": "photo-123", "clientAgentId": "did:web:buyer" } }]
    }
  }
}
```

Executor calls `engine.requestAccess(req)` and publishes a Task:

- State: `input-required`
- Metadata: `x402.payment.status: "payment-required"`, `x402.payment.required: <PaymentRequirements>`
- Parts: challenge description (text) + X402Challenge (data)

**Phase 2 — Payment → Task (`completed`)**

Client sends A2A `message/send` with payment payload in metadata:

```json
{
  "method": "message/send",
  "params": {
    "message": {
      "metadata": {
        "x402.payment.status": "payment-submitted",
        "x402.payment.payload": { "x402Version": 2, "payload": { "signature": "0x..." }, "accepted": { "extra": { "challengeId": "..." }, ... } }
      },
      "parts": [{ "kind": "text", "text": "Payment submitted" }]
    }
  }
}
```

Executor processes through intermediate working states:

1. Extracts `challengeId` from `payload.accepted.extra.challengeId`
2. Publishes working Task: `x402.payment.status: "payment-submitted"`
3. Calls `settlePayment()` → verify + settle on-chain
4. Publishes working Task: `x402.payment.status: "payment-verified"`
5. Calls `engine.processHttpPayment()` → PENDING → PAID → DELIVERED
6. Publishes final Task:
  - State: `completed`
  - Metadata: `x402.payment.status: "payment-completed"`, `x402.payment.receipts: [receipt]`
  - Parts: confirmation text + AccessGrant data
  - Artifacts: access-grant data part

**x402 Metadata Keys**


| Key                     | Value                                                                                                            | Direction       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| `x402.payment.status`   | `"payment-required"` / `"payment-submitted"` / `"payment-verified"` / `"payment-completed"` / `"payment-failed"` | Server → Client |
| `x402.payment.required` | `PaymentRequirements` object                                                                                     | Server → Client |
| `x402.payment.payload`  | `X402PaymentPayload` object                                                                                      | Client → Server |
| `x402.payment.receipts` | Array of `X402SettleResponse`                                                                                    | Server → Client |
| `x402.payment.error`    | Error code string                                                                                                | Server → Client |


### HTTP Headers Reference


| Header              | Direction             | Format                                               | Purpose                                      |
| ------------------- | --------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `payment-required`  | Server → Client (402) | base64 JSON                                          | PaymentRequirements / Discovery              |
| `www-authenticate`  | Server → Client (402) | `Payment realm=..., accept="exact"[, challenge=...]` | HTTP spec compliance                         |
| `payment-signature` | Client → Server       | base64 JSON                                          | X402PaymentPayload with EIP-3009 signature   |
| `payment-response`  | Server → Client (200) | base64 JSON                                          | X402SettleResponse with txHash               |
| `x-a2a-extensions`  | Client → Server       | presence check                                       | Routes to A2A handler, skips x402 middleware |


### Message Types

**X402Challenge** (server → client, Phase 1):

```json
{
  "type": "X402Challenge",
  "challengeId": "a1b2c3d4-...",
  "requestId": "550e8400-...",
  "tierId": "basic",
  "amount": "$0.10",
  "asset": "USDC",
  "chainId": 84532,
  "destination": "0xSellerWallet...",
  "expiresAt": "2025-03-05T12:30:00.000Z",
  "description": "Send $0.10 USDC to 0xSeller... on chain 84532.",
  "resourceVerified": true
}
```

**AccessGrant** (server → client, Phase 2):

```json
{
  "type": "AccessGrant",
  "challengeId": "a1b2c3d4-...",
  "requestId": "550e8400-...",
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "expiresAt": "2025-03-05T13:15:00.000Z",
  "resourceEndpoint": "https://api.example.com/photos/photo-123",
  "resourceId": "photo-123",
  "tierId": "basic",
  "txHash": "0xabcdef1234567890...",
  "explorerUrl": "https://sepolia.basescan.org/tx/0xabcdef..."
}
```

`**payment-signature` header** (decoded X402PaymentPayload):

```json
{
  "x402Version": 2,
  "network": "eip155:84532",
  "scheme": "exact",
  "payload": {
    "signature": "0xSignedEIP3009...",
    "authorization": {
      "from": "0xBuyer...",
      "to": "0xSeller...",
      "value": "100000",
      "validAfter": "0",
      "validBefore": "1741180560",
      "nonce": "0xRandomNonce..."
    }
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD...",
    "amount": "100000",
    "payTo": "0xSeller...",
    "maxTimeoutSeconds": 900,
    "extra": { "name": "USDC", "version": "2" }
  }
}
```

---

## Settlement Strategies

The `settlePayment()` function is called by all three transports. It routes based on config.

### Gas Wallet Mode (`config.gasWalletPrivateKey` set)

Self-contained settlement using `@x402/evm`:

1. Create viem wallet client with gas wallet account
2. Instantiate `ExactEvmScheme` from `@x402/evm/exact/facilitator`
3. Call `scheme.verify()` to validate the EIP-3009 signature
4. Call `scheme.settle()` to broadcast `transferWithAuthorization` on-chain (gas wallet pays gas)
5. Return `{ txHash, settleResponse, payer }`

**Nonce serialization** prevents concurrent settlement from causing nonce conflicts:

| Strategy                   | When                    | How                                                                                                                                              |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Redis distributed lock** | `config.redis` provided | `SET NX` with 60s TTL, Lua-script atomic release. Poll interval: 200ms. Max wait: 30s (throws 503 on timeout). Lock key uses gas wallet address. |
| **In-process queue**       | No Redis                | Promise-based serial queue. Single-instance only.                                                                                                |

### Facilitator Mode (default)

Routes to an external facilitator service:

1. `POST {facilitatorUrl}/verify` with `X402PaymentPayload` + payment requirements
2. Check `isValid` in response
3. `POST {facilitatorUrl}/settle` to complete on-chain settlement
4. Return `{ txHash, settleResponse, payer }`

Default facilitator URLs (from `CHAIN_CONFIGS`):

- **Testnet**: `https://api.cdp.coinbase.com/platform/v2/x402`
- **Mainnet**: `https://api.cdp.coinbase.com/platform/v2/x402`

Overridable via `config.facilitatorUrl`.

---

## Token Issuance & Validation

### Issuance

Token issuance is **fully delegated** to the seller via `config.onIssueToken()`. The callback receives:

```typescript
{
  requestId: string;
  challengeId: string;
  resourceId: string;
  tierId: string;
  txHash: string;
}
```

And must return:

```typescript
{
  token: string;       // The access token (JWT, API key, etc.)
  expiresAt: Date;     // When the token expires
  tokenType?: string;  // Default "Bearer"
}
```

### Built-in `AccessTokenIssuer`

Supports HS256 (shared secret, min 32 chars) and RS256 (PEM private key) JWTs.

**Constructor accepts**:

- `string` — treated as HS256 shared secret (legacy)
- `{ secret?, privateKey?, algorithm? }` — full config

**JWT Claims**:


| Claim        | Value                               |
| ------------ | ----------------------------------- |
| `sub`        | requestId                           |
| `jti`        | challengeId                         |
| `resourceId` | Resource identifier                 |
| `tierId`     | Product tier                        |
| `txHash`     | On-chain transaction hash           |
| `iat`        | Issued-at timestamp (unix seconds)  |
| `exp`        | Expiration timestamp (unix seconds) |


**Methods**:

- `sign(claims, ttlSeconds)` → `{ token, expiresAt }`
- `verify(token)` → decoded claims (HS256 only)
- `verifyWithFallback(token, fallbackSecrets[])` → tries primary then each fallback for zero-downtime rotation

### Validation Middleware

`validateToken(authHeader, config)` in `src/middleware.ts`:

1. Check `Bearer {token}` format
2. Verify JWT with `jose.jwtVerify(token, secret)`
3. If expired → `CHALLENGE_EXPIRED` (401)
4. If invalid → `INVALID_REQUEST` (401)
5. Return decoded payload

Framework-specific wrappers attach decoded token to the request:

- **Express**: `req.key0Token`
- **Hono**: `c.set("key0Token", payload)`
- **Fastify**: `request.key0Token`

---

## Refund Lifecycle

The refund cron handles PAID records that were never DELIVERED (e.g., `onIssueToken` failed or the client disappeared). The cron is **not built into Key0** — the `IChallengeStore.findPendingForRefund()` method and state transitions are provided for external cron implementations.

### How It Works

1. **Query**: `store.findPendingForRefund(minAgeMs)` runs `ZRANGEBYSCORE key0:paid 0 <cutoff>` to find PAID records older than `minAgeMs`, filtering for state=PAID, `fromAddress` set, and `accessGrant` NOT set (records with `accessGrant` were successfully issued but the DELIVERED transition failed — they should not be refunded). Ghost entries (sorted set member but expired hash) are cleaned up via `ZREM`. Records without `fromAddress` trigger a warning log for manual intervention.
2. **Batch limit**: Only `batchSize` records (default 50, configurable via `RefundConfig.batchSize`) are processed per cron run to avoid long-running jobs.
3. **Claim**: For each record, atomically transition PAID → REFUND_PENDING (prevents double-refund from concurrent cron workers)
4. **Send**: Call `sendUsdc()` to transfer USDC back to `record.fromAddress`
5. **Success**: Transition REFUND_PENDING → REFUNDED with `refundTxHash` and `refundedAt`
6. **Failure**: Transition REFUND_PENDING → REFUND_FAILED with `refundError` — the transition itself is wrapped in try/catch so a Redis failure here won't crash the loop. Cron does NOT retry automatically.
7. **Manual retry**: `retryFailedRefunds(store, challengeIds)` can re-queue REFUND_FAILED records back to PAID for the next cron run. Intended for operator use (admin API, manual scripts).

### Refund Settlement (`sendUsdc()`)


| Strategy                        | How                                                                                         | Gas Payer  |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ---------- |
| **With gasWalletPrivateKey**    | USDC owner signs EIP-3009 off-chain. Gas wallet calls `transferWithAuthorization` on-chain. | Gas wallet |
| **Without gasWalletPrivateKey** | Direct ERC-20 `transfer()` call.                                                            | USDC owner |


Both wait for `waitForTransactionReceipt` before returning.

### Redis During Refund

```
# After PAID -> REFUND_PENDING claim:
key0:paid (SORTED SET)
  (challengeId removed via ZREM -- inside Lua script)

key0:challenge:{challengeId}
  state = REFUND_PENDING

# After successful refund:
key0:challenge:{challengeId}
  state        = REFUNDED
  refundTxHash = 0xRefund...
  refundedAt   = 2025-03-05T12:21:00.000Z
```

---

## Error Codes Reference

### Key0ErrorCode (thrown by ChallengeEngine)


| Code                      | HTTP    | When                                                   |
| ------------------------- | ------- | ------------------------------------------------------ |
| `RESOURCE_NOT_FOUND`      | 404     | `onVerifyResource()` returns false                     |
| `TIER_NOT_FOUND`          | 400     | `tierId` not in `SellerConfig.products`                |
| `CHALLENGE_NOT_FOUND`     | 404     | `store.get(challengeId)` returns null                  |
| `CHALLENGE_EXPIRED`       | 410     | Challenge `expiresAt <= now` or state not PENDING      |
| `CHAIN_MISMATCH`          | 400     | Proof `chainId` doesn't match challenge `chainId`      |
| `AMOUNT_MISMATCH`         | 400     | Proof `amount` doesn't match challenge `amount`        |
| `TX_UNCONFIRMED`          | 202     | Transaction not found on-chain (may still be pending)  |
| `INVALID_PROOF`           | 400     | On-chain verification failed (wrong recipient, amount, etc.) |
| `TX_ALREADY_REDEEMED`     | 409     | `txHash` already in `seenTxStore`                      |
| `PROOF_ALREADY_REDEEMED`  | 200     | Challenge already DELIVERED (returns grant in details) |
| `INVALID_REQUEST`         | 400/401 | Malformed input or invalid JWT                         |
| `PAYMENT_FAILED`          | 400     | Settlement failed                                      |
| `ADAPTER_ERROR`           | 500     | Payment adapter threw                                  |
| `RESOURCE_VERIFY_TIMEOUT` | 504     | `onVerifyResource()` timed out                         |
| `TOKEN_ISSUE_FAILED`      | 500     | `onIssueToken()` threw                                 |
| `TOKEN_ISSUE_TIMEOUT`     | 504     | `onIssueToken()` timed out                             |
| `INTERNAL_ERROR`          | 500     | Unexpected failure                                     |


### Error Shape

```json
{
  "type": "Error",
  "code": "CHALLENGE_EXPIRED",
  "message": "Challenge has expired",
  "details": {}
}
```

---

## Security Checks Summary

### Per-Request Checks (in order of execution)


| #   | Check                          | Where                             | Prevents                               |
| --- | ------------------------------ | --------------------------------- | -------------------------------------- |
| 1   | UUID format validation         | `validateUUID()`                  | Malformed requestId                    |
| 2   | Tier exists in product catalog | `findTier()`                      | Invalid tier requests                  |
| 3   | Resource verification          | `onVerifyResource()` with timeout | Access to nonexistent resources        |
| 4   | Idempotency (requestId lookup) | `store.findActiveByRequestId()`   | Duplicate challenge creation           |
| 5   | State check (PENDING required) | `challenge.state` check           | Acting on expired/cancelled challenges |
| 6   | Double-spend pre-check         | `seenTxStore.get(txHash)`         | Reusing a txHash                       |
| 7   | Atomic state transition        | Lua `HGET + HSET`                 | Concurrent double-redemption           |
| 8   | Atomic txHash claim            | `SET NX`                          | Race condition double-spend            |


### Invariants

1. **State transitions are atomic** — Lua script checks current state before writing; concurrent transitions are rejected
2. **Double-spend is impossible** — `SET NX` on `key0:seentx:{txHash}` ensures one txHash maps to exactly one challenge; if `markUsed` fails, the PAID state is rolled back to PENDING
3. **JWT security** — minimum 32-char secret, supports HS256/RS256, fallback secrets for rotation
4. **Refunds cannot double-fire** — atomic PAID→REFUND_PENDING transition ensures only one cron worker processes each record
5. **Nonce serialization for gas wallet** — Redis distributed lock (with 30s max-wait timeout) or in-process queue prevents nonce conflicts during settlement
6. **Resource verified before settlement** — transports call `engine.verifyResource()` before `settlePayment()` to prevent charging for nonexistent resources
7. **Outbox pattern for grant delivery** — `accessGrant` is persisted to the PAID record before returning to the client, so a failure in the DELIVERED transition doesn't lose the grant; refund cron skips records with `accessGrant` set

---

## Network Configuration


| Field           | Testnet (Base Sepolia)                          | Mainnet (Base)                                  |
| --------------- | ----------------------------------------------- | ----------------------------------------------- |
| Chain ID        | 84532                                           | 8453                                            |
| RPC URL         | `https://sepolia.base.org`                      | `https://mainnet.base.org`                      |
| USDC Address    | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`    | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`    |
| Facilitator URL | `https://api.cdp.coinbase.com/platform/v2/x402` | `https://api.cdp.coinbase.com/platform/v2/x402` |
| Explorer        | `https://sepolia.basescan.org`                  | `https://basescan.org`                          |
| USDC Domain     | `{ name: "USDC", version: "2" }`                | `{ name: "USDC", version: "2" }`                |
| USDC Decimals   | 6                                               | 6                                               |


---

## Validation Patterns


| Pattern       | Regex                                                                               | Used For              |
| ------------- | ----------------------------------------------------------------------------------- | --------------------- |
| UUID          | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive) | `requestId`           |
| Tx Hash       | `^0x[0-9a-fA-F]{64}$`                                                               | `txHash`              |
| Address       | `^0x[0-9a-fA-F]{40}$`                                                               | Wallet addresses      |
| Dollar Amount | `^\$\d+(\.\d{1,6})?$`                                                               | Product tier `amount` |


