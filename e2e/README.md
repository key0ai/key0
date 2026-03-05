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
        1. POST /a2a/access (no payment)     → HTTP 402 + challengeId
        2. signTypedData(TransferWithAuth)   → off-chain EIP-3009 signature
        3. POST /a2a/access (payment-signature header) → gas wallet settles → AccessGrant (JWT)
        4. GET  /api/resource/:id (Bearer)   → protected backend API
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
1. `POST /a2a/access` with no payment → server returns HTTP 402 with `challengeId` and payment requirements in a base64-encoded `payment-required` header.
2. Client signs an EIP-3009 `TransferWithAuthorization` off-chain — authorizes the gas wallet to move USDC from the client's address to the AgentGate wallet.
3. `POST /a2a/access` with `payment-signature` header containing the EIP-3009 signature → gas wallet executes the on-chain transfer → server issues an `AccessGrant` (JWT).
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

### `invalid-tier.test.ts` — Invalid Tier (1 test)

Verifies that requesting an unknown tier fails immediately — before any payment requirements are issued.

Calls `requestAccess` with `tierId: "nonexistent-tier"`. The server returns an error during challenge creation (`TIER_NOT_FOUND`). No payment is required and no challenge record is written.

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

## Infrastructure Notes

**Refund cron timings** (configured in `docker-compose.e2e.yml` for speed):
- `REFUND_INTERVAL_MS=5000` — cron fires every 5 seconds
- `REFUND_MIN_AGE_MS=3000` — records must be at least 3 seconds old to be eligible
- `REFUND_POLL_TIMEOUT_MS=30_000` — test polls for up to 30 seconds

**Redis port:** Docker Redis is mapped to `localhost:6380` (not 6379) to avoid conflict with any locally running Redis.

**Gas wallet settlement lock:** When Redis is available, concurrent `settleViaGasWallet` calls are serialized via a Redis lock (`agentgate:settle-lock:{prefix}`, TTL 60s) — safe across multiple instances. Without Redis, falls back to an in-process promise queue (single instance only).

**Sorted set atomicity:** The `agentgate:paid` sorted set is updated inside the same Lua script as the state transition — both the hash write and the ZADD/ZREM are atomic. A process crash cannot leave a PAID record outside the sorted set where the refund cron would never find it.
