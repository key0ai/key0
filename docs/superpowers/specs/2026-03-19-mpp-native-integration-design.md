# MPP Native Integration — Design Spec

**Date:** 2026-03-19
**Branch:** feat/mpp
**Status:** Draft

---

## Problem Statement

Key0 today uses the x402 protocol for payment negotiation. x402 is a Coinbase-specific wire format that only accepts USDC on Base. This creates two hard blockers for API sellers:

1. **Interoperability:** Only agents that implement Key0's custom x402 flow can pay. Any agent built on `mppx` or another MPP-compliant SDK cannot pay a Key0-protected API without custom integration work.

2. **Single payment rail:** Sellers can only receive USDC on Base. Agents without a crypto wallet — paying via Stripe, card, or Lightning — cannot access Key0-protected APIs at all.

MPP (Machine Payments Protocol) is an IETF-proposed standard that generalises HTTP 402 payment negotiation to be payment-rail agnostic. It solves both problems simultaneously.

---

## Goals

- Any MPP-compliant agent can pay a Key0-protected API out of the box.
- Sellers can accept multiple payment methods (USDC on Base, Stripe, Lightning) from a single endpoint.
- Sellers explicitly declare which payment methods they accept at config time.
- Key0's internal value-add (state machine, JWT issuance, audit trail, replay protection, A2A discovery) is unaffected.
- The on-chain USDC/Base verification logic is preserved exactly as-is.

## Non-Goals

- Backward compatibility with x402 wire format (no existing sellers).
- Buyer/client SDK (out of scope per SPEC.md).
- Subscription/recurring billing.
- `StripeAdapter` and `LightningAdapter` implementations (architecture defined here; implementations are follow-on specs).
- Refund flows for non-USDC methods (refund path remains USDC-only for now; non-USDC challenges will be flagged as non-refundable in the audit log).

---

## Layer Architecture

MPP replaces x402 as the payment negotiation layer only. Everything above it is unchanged.

```
┌──────────────────────────────────────────────────────┐
│  KEY0 VALUE-ADD LAYER (no changes)                   │
│                                                      │
│  • Agent card / A2A discovery                        │
│  • Plan catalog (planId, unitAmount, description)    │
│  • State machine (PENDING→PAID→REFUND_PENDING→       │
│    REFUNDED|REFUND_FAILED|DELIVERED|EXPIRED|         │
│    CANCELLED)                                        │
│  • IChallengeStore / ISeenTxStore / IAuditStore      │
│  • JWT issuance (AccessTokenIssuer)                  │
│  • Replay protection (markUsed atomic SET NX)        │
│  • onPaymentReceived / onChallengeExpired hooks      │
└──────────────────────────────────────────────────────┘
                       ↑
              verified payment event
                       ↑
┌──────────────────────────────────────────────────────┐
│  MPP PAYMENT NEGOTIATION LAYER (replaces x402)       │
│                                                      │
│  • WWW-Authenticate: Payment … (challenge headers)   │
│  • Authorization: Payment … (credential parsing)     │
│  • Payment-Receipt: … (optional receipt header)      │
│  • RFC 9457 Problem Details on failures              │
│  • IPaymentAdapter per method, adapter registry      │
└──────────────────────────────────────────────────────┘
                       ↑
              on-chain / off-chain rails
                       ↑
┌──────────────────────────────────────────────────────┐
│  PAYMENT RAILS (no changes)                          │
│                                                      │
│  • USDC on Base — viem verification (today)          │
│  • Stripe API (new adapter, follow-on spec)          │
│  • Lightning (new adapter, follow-on spec)           │
└──────────────────────────────────────────────────────┘
```

---

## Core Types

These types are new or updated and must be defined before implementation begins.

### MppChallengeRequest

The `request` object returned by each adapter — encoded as base64url into the `WWW-Authenticate: Payment request="…"` parameter.

```typescript
// Each adapter returns its own method-specific request shape.
// The engine base64url-encodes it for the header.
type MppChallengeRequest = Record<string, unknown>;

// BaseUsdcAdapter example:
type BaseUsdcChallengeRequest = {
  amount: string;       // base units (e.g. "100000" for 0.10 USDC)
  currency: `0x${string}`; // token contract address
  recipient: `0x${string}`; // seller wallet
};
```

### MppCredentialPayload

The `payload` field inside the decoded `Authorization: Payment` credential. Method-specific.

```typescript
// Adapter receives this from the decoded credential.
// BaseUsdcAdapter uses:
type BaseUsdcCredentialPayload = {
  txHash: `0x${string}`;
};

// StripeAdapter would use (per MPP Stripe spec — Shared Payment Token):
// type StripeCredentialPayload = { spt: string };  // "spt_…"
```

### MppVerifyParams

Passed to `adapter.verifyCredential()`:

```typescript
type MppVerifyParams = {
  challenge: ChallengeRecord;           // server-authoritative stored record
  credential: {
    challengeId: string;
    source: string;                     // payer identity (address, DID, etc.)
    payload: MppCredentialPayload;      // method-specific proof
  };
};
```

### MppReceiptReference

Returned by `adapter.buildReceiptReference()` — the method-specific reference field only. The engine assembles the full receipt.

```typescript
type MppReceiptReference = {
  reference: string;   // "0xtx789…" for USDC, "spt_…" for Stripe, preimage for Lightning
};
```

### Updated ChallengeRecord

`ChallengeRecord` gains a `methodData` field to carry method-specific challenge data. Method-agnostic fields (amount in USD cents, planId, expiry, state) remain top-level.

```typescript
type ChallengeRecord = {
  // existing method-agnostic fields (unchanged)
  id: string;
  requestId: string;
  planId: string;
  resourceId: string;
  amountUsd: string;       // human-readable, e.g. "0.10"
  expiresAt: Date;
  state: ChallengeState;
  createdAt: Date;

  // new
  method: string;          // "base-usdc" | "stripe" | "lightning" | …
  methodData: Record<string, unknown>; // method-specific challenge data (raw request object)
};
```

The existing USDC-specific fields (`asset: "USDC"`, `chainId: number`, `amountRaw: bigint`) are removed from the top-level record and stored inside `methodData` by `BaseUsdcAdapter`.

### Updated ISeenTxStore

Key relaxed from `0x${string}` to `string` to support non-hex proof references (Stripe SPT, Lightning preimage).

```typescript
interface ISeenTxStore {
  get(reference: string): Promise<string | null>;  // returns challengeId that used this reference, or null
  markUsed(reference: string, challengeId: string): Promise<boolean>;
}
```

`get()` is kept (renamed from `get(txHash: \`0x${string}\`)`) so the engine can include the original `challengeId` in double-spend error messages. Existing Redis and Postgres implementations only change the key type annotation — the SET NX logic is identical.

### Adapter Registry

```typescript
type AdapterRegistry = Map<string, IPaymentAdapter>; // method → adapter

// Built in factory.ts from config.paymentMethods:
const registry: AdapterRegistry = new Map(
  config.paymentMethods.map(adapter => [adapter.method, adapter])
);
```

The engine receives the registry, not a single adapter.

---

## IPaymentAdapter — MPP Method Interface

Each adapter maps to one MPP payment method.

```typescript
interface IPaymentAdapter {
  readonly method: string;           // "base-usdc" | "stripe" | "lightning"
  readonly intent: "charge" | "session";

  // Returns the method-specific request object.
  // The engine base64url-encodes this into WWW-Authenticate: Payment request="…"
  buildChallengeRequest(params: IssueChallengeParams): Promise<MppChallengeRequest>;

  // Verifies the credential payload against the server-stored challenge.
  // Must check amount, recipient, and method-specific proof validity.
  verifyCredential(params: MppVerifyParams): Promise<VerificationResult>;

  // Returns the method-specific payment reference for the receipt.
  // Engine assembles the full receipt JSON around this.
  buildReceiptReference(result: VerificationResult): MppReceiptReference;
}
```

**Challenge ID generation is the engine's responsibility**, not the adapter's. The engine generates an HMAC-bound `id` over `(realm, method, intent, sha256(request), expires)` after calling `buildChallengeRequest()`.

**Receipt assembly is the engine's responsibility.** The engine calls `buildReceiptReference()` to get the `reference` string, then assembles the full receipt:

```typescript
const receipt = {
  challengeId: challenge.id,
  method: challenge.method,
  reference: adapter.buildReceiptReference(result).reference,
  settlement: { amount: challenge.amountUsd, currency: "usd" },
  status: "success",
  timestamp: new Date().toISOString(),
};
```

### BaseUsdcAdapter

Wraps the existing `X402Adapter` viem verification logic. On-chain verification code is unchanged.

```typescript
class BaseUsdcAdapter implements IPaymentAdapter {
  readonly method = "base-usdc";  // custom MPP method — Key0 publishes the spec
  readonly intent = "charge";

  buildChallengeRequest({ amount, destination }) {  // IssueChallengeParams fields: amount (USD string), destination (wallet address)
    return {
      amount: toUsdcBaseUnits(amount),  // e.g. "100000" for $0.10
      currency: USDC_ADDRESS,           // 0x833589f… on mainnet
      recipient: destination,
    };
  }

  verifyCredential({ challenge, credential }) {
    const { txHash } = credential.payload as BaseUsdcCredentialPayload;
    // identical viem ERC-20 Transfer verification as current X402Adapter
    return this.verifyTransfer(txHash, challenge.methodData);
  }

  buildReceiptReference({ txHash }) {
    return { reference: txHash };
  }
}
```

**Note on `base-usdc` as a custom method:**
`base-usdc` is not a defined MPP method. Key0 must publish a `base-usdc` method spec (request schema, payload schema, verification procedure) so external MPP clients can implement it. Ideally, Key0 contributes a `base-usdc` client handler to `mppx` so agents using that SDK can pay Key0 sellers automatically with zero custom code.

### StripeAdapter (architecture only — implementation is a follow-on spec)

**Important:** The MPP `stripe` method uses Shared Payment Tokens (SPT), not `clientSecret` or `paymentIntentId`. The MPP Stripe charge spec defines specific `request` fields (`amount`, `currency`, `decimals`, `methodDetails.networkId`, `methodDetails.paymentMethodTypes`) and a credential `payload` of `{ spt: string }`. Any `StripeAdapter` implementation must conform to that spec exactly. Do not implement Stripe until the follow-on spec is written against the actual MPP Stripe method schema.

### LightningAdapter (architecture only — implementation is a follow-on spec)

Similarly deferred. Lightning credential payload contains a preimage. Follow-on spec must define the full method schema.

---

## Challenge Engine Changes

### Updated constructor

```typescript
type ChallengeEngineConfig = {
  adapters: AdapterRegistry;   // replaces singular `adapter`
  store: IChallengeStore;
  seenTxStore: ISeenTxStore;
  auditStore?: IAuditStore;
  tokenIssuer: IAccessTokenIssuer;
  sellerConfig: SellerConfig;
};
```

### Issuing challenges (402 path)

```
Incoming request (no credential)
         ↓
for each adapter in adapters (plan's allowed methods if restricted):
  request = await adapter.buildChallengeRequest(params)
  id = hmac(realm, method, intent, sha256(request), expires)
  store challenge: { id, method, methodData: request, amountUsd, planId, … }
  build WWW-Authenticate header string
         ↓
HTTP/1.1 402 Payment Required
Cache-Control: no-store
Content-Type: application/problem+json
WWW-Authenticate: Payment id="abc", method="base-usdc", intent="charge", realm="<config.agentUrl>", expires="…", request="eyJ…"
WWW-Authenticate: Payment id="def", method="stripe",   intent="charge", realm="<config.agentUrl>", expires="…", request="eyJ…"

{ "type": "https://paymentauth.org/problems/payment-required", "status": 402 }
```

`realm` is always `config.agentUrl` (the seller's agent base URL).

### Verifying credentials (retry path)

```
Authorization: Payment <base64url>
         ↓
Decode → { challenge: { id, method, … }, source, payload }
Look up STORED challenge by challenge.id from IChallengeStore
Assert stored.method === credential.challenge.method    ← compare against server record, not credential claim
Assert stored.method maps to a registered adapter
Route to adapter = adapters.get(stored.method)
         ↓
result = await adapter.verifyCredential({ challenge: stored, credential })
         ↓
ISeenTxStore.markUsed(result.reference, stored.id)     ← reference is string (not 0x${string})
IChallengeStore.transition(stored.id, PENDING → PAID)
         ↓
fetchResourceCredentials() → JWT
         ↓
receipt = engine.assembleReceipt(stored, adapter.buildReceiptReference(result))
         ↓
HTTP/1.1 200 OK
Payment-Receipt: <base64url(receipt)>
Authorization: Bearer <jwt>
```

**Security note on method assertion:** The assertion is `stored.method === credential.challenge.method`, where `stored` is the authoritative server-side record. This prevents a client from submitting a credential for a cheap method (e.g., Stripe) against a challenge originally issued for an expensive method (e.g., USDC), because the stored record is the ground truth.

### Updated `processHttpPayment` signature

```typescript
// Before (USDC-specific)
processHttpPayment(requestId, planId, resourceId, txHash: `0x${string}`, fromAddress?)

// After (method-agnostic)
processHttpPayment(requestId: string, mppCredential: MppCredential): Promise<AccessGrant>

type MppCredential = {
  challenge: { id: string; method: string; intent: string; request: string; expires?: string };
  source: string;
  payload: Record<string, unknown>;
};
```

### What is unchanged in the engine

- All state transitions (`PENDING → PAID → DELIVERED`, `REFUND_PENDING → REFUNDED|REFUND_FAILED`, etc.)
- `IChallengeStore.transition()` atomic compare-and-swap
- `ISeenTxStore.markUsed()` logic (only key type broadened to `string`)
- `fetchResourceCredentials()` JWT issuance
- `onPaymentReceived` / `onChallengeExpired` hooks
- Expiry and idempotency logic
- Refund path remains USDC-only (non-USDC challenges are flagged `nonRefundable: true` in `methodData`)

---

## Seller Config API

`paymentMethods` is required. Sellers must be explicit — no defaults, no fallbacks.

```typescript
import { createKey0, baseUsdc, stripe, lightning } from "@key0ai/key0";

createKey0({
  walletAddress: "0x…",
  network: "mainnet",
  plans: [
    { planId: "basic",   unitAmount: "0.10" },
    { planId: "premium", unitAmount: "5.00", methods: ["base-usdc"] }, // crypto only
  ],
  paymentMethods: [
    baseUsdc(),
    stripe({ secretKey: "sk_live_…" }),
    lightning({ node: "…", macaroon: "…" }),
  ],
  fetchResourceCredentials: async ({ planId }) => { … },
});
```

Factory function signatures:

```typescript
baseUsdc(options?: {
  network?: "mainnet" | "testnet";  // inherits from SellerConfig if omitted
  mode?: "pull" | "push";
}): IPaymentAdapter

stripe(options: {
  secretKey: string;
  webhookSecret?: string;
}): IPaymentAdapter

lightning(options: {
  node: string;
  macaroon: string;
}): IPaymentAdapter
```

Each factory returns a configured `IPaymentAdapter`. Sellers never instantiate adapter classes directly. The `createKey0` factory builds the `AdapterRegistry` from `paymentMethods` and injects it into the engine.

**Plan-level method restriction (optional):**

When a plan specifies `methods: ["base-usdc"]`, the engine only iterates adapters whose `method` is in that list when issuing challenges for that plan.

---

## Integration Layer

### HTTP integrations (Express, Hono, Fastify)

Unified flow across all three frameworks:

```
Incoming request
      ↓
Authorization: Payment header present?
      ├── No  → engine.requestHttpAccess() → emit WWW-Authenticate headers → 402
      └── Yes → decode base64url → MppCredential
                 engine.processHttpPayment(requestId, mppCredential)
                 200 + Payment-Receipt header + JWT
```

**RFC 9457 error bodies on all 402 responses:**

| Condition | Problem type | Status |
|---|---|---|
| No credential | `payment-required` | 402 |
| Expired challenge | `payment-expired` | 402 |
| Already-used reference | `invalid-challenge` | 402 |
| Amount too low | `payment-insufficient` | 402 |
| Bad credential JSON | `malformed-credential` | 402 |
| On-chain verify failed | `verification-failed` | 402 |
| Method not in adapter registry | `method-unsupported` | 400 |

`method-unsupported` returns 400, not 402, because the client cannot retry with payment — the method is simply not accepted.

### MCP integration

Replaces Key0's custom `isError`/`structuredContent` signalling with the MPP standard.

**Challenge (server → agent):** JSON-RPC error code `-32042`

```json
{
  "code": -32042,
  "message": "Payment Required",
  "data": {
    "httpStatus": 402,
    "challenges": [
      { "id": "…", "method": "base-usdc", "intent": "charge", "request": { … } },
      { "id": "…", "method": "stripe",   "intent": "charge", "request": { … } }
    ]
  }
}
```

**Credential (agent → server):** `_meta["org.paymentauth/credential"]`

```json
{
  "method": "tools/call",
  "params": {
    "name": "…",
    "arguments": { … },
    "_meta": {
      "org.paymentauth/credential": {
        "challenge": { "id": "…", "method": "base-usdc", … },
        "source": "0x…",
        "payload": { "txHash": "0x…" }
      }
    }
  }
}
```

**Receipt (server → agent):** `_meta["org.paymentauth/receipt"]` — full structure including `reference` and `settlement`:

```json
{
  "result": {
    "content": [ … ],
    "_meta": {
      "org.paymentauth/receipt": {
        "challengeId": "…",
        "method": "base-usdc",
        "reference": "0xtx789…",
        "settlement": { "amount": "0.10", "currency": "usd" },
        "status": "success",
        "timestamp": "2026-03-19T12:00:00Z"
      }
    }
  }
}
```

---

## Security Invariants (unchanged)

| Invariant | MPP Requirement | Key0 Implementation |
|---|---|---|
| Single-use proofs | Credentials valid exactly once | `ISeenTxStore.markUsed()` atomic SET NX — key broadened to `string` |
| No side effects before payment | Servers must not modify state for unpaid requests | `preSettlementCheck()` guard |
| Challenge binding | `id` cryptographically bound to parameters | HMAC over `(realm, method, intent, sha256(request), expires)` |
| Method assertion | Credential method verified against server record | `stored.method === credential.challenge.method` — stored record is ground truth |
| TLS required | TLS 1.2+ for all payment flows | Standard HTTPS deployment |
| No credential logging | Credentials must not appear in logs | Key0 does not log raw credentials |

---

## Files Affected

| File | Change |
|---|---|
| `src/types/index.ts` | Add `MppChallengeRequest`, `MppVerifyParams`, `MppCredentialPayload`, `MppReceiptReference`, `MppCredential`, `AdapterRegistry`; update `IPaymentAdapter`; update `ISeenTxStore` key type to `string` (keep `get()`, rename from `get(txHash)`); update `ChallengeRecord` with `method` + `methodData`, remove top-level USDC fields |
| `src/types/adapter.ts` | `IssueChallengeParams` fields confirmed as `amount: string` (USD) and `destination: \`0x${string}\`` — no rename needed; verify these match `BaseUsdcAdapter.buildChallengeRequest` usage |
| `src/types/x402-extension.ts` | Delete — all x402-specific types removed |
| `src/adapter/index.ts` | Rename `X402Adapter` → `BaseUsdcAdapter`; conform to new `IPaymentAdapter` |
| `src/core/challenge-engine.ts` | Accept `AdapterRegistry` (not single adapter); multi-adapter iteration on 402 path; method routing + stored-record assertion on credential path; new `processHttpPayment(requestId, MppCredential)` signature; engine-assembled receipts |
| `src/integrations/settlement.ts` | Replace `buildHttpPaymentRequirements` with MPP `WWW-Authenticate` header builder; replace `decodePaymentSignature` with MPP credential decoder (`base64url` → `MppCredential`) |
| `src/integrations/express.ts` | Parse `Authorization: Payment`; emit `WWW-Authenticate: Payment`; RFC 9457 errors including `method-unsupported` (400) |
| `src/integrations/hono.ts` | Same as Express |
| `src/integrations/fastify.ts` | Same as Express |
| `src/integrations/mcp.ts` | Replace `isError`/`structuredContent` with `-32042` + `_meta`; full receipt structure in result `_meta` |
| `src/factory.ts` | `paymentMethods: IPaymentAdapter[]` required in `SellerConfig`; build `AdapterRegistry` and inject into engine |
| `src/executor.ts` | Review A2A path types (`X402Challenge`, `PaymentProof`) — update or isolate USDC-specific fields into `base-usdc` method; A2A path remains USDC-only for now |
| `src/index.ts` | Export `baseUsdc`, `stripe`, `lightning` factory functions; remove x402 exports |
| `src/storage/` | Update `ISeenTxStore` key type to `string` in Redis + Postgres implementations |

---

## Out of Scope for This Spec

- `StripeAdapter` implementation (must be written against actual MPP Stripe method spec — SPT-based, not `clientSecret`)
- `LightningAdapter` implementation
- Publishing `base-usdc` method spec to MPP ecosystem / contributing to `mppx`
- Refund flows for non-USDC payment methods
- Client SDK for paying Key0-protected APIs
