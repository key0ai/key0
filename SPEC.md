# AgentGate — Protocol Specification

**Version**: 0.2
**Status**: Implemented
**Date**: 2026-03-04
**Working Repo**: `agentgate`

---

## 1. Problem Statement

SaaS products today are designed for human users: browser signups, OAuth flows, credit-card checkouts. AI agents cannot navigate these flows autonomously.

As the agent economy grows, API providers need a way to:

1. **Expose** their services to autonomous agents without human-in-the-loop authentication.
2. **Monetize** agent access without credit-card processors, subscription billing portals, or KYC friction.
3. **Control** access at the resource level — per-call, per-album, per-report — not just per-account.

**AgentGate** is an open-source SDK that lets any API provider publish an A2A-compliant agent, define priced capabilities, and accept crypto payments from client agents — without changing their existing backend.

---

## 2. Vision & Scope

> **One Agent Card. Zero Signup. Instant Access.**

AgentGate provides:
- A **seller SDK** to publish a payment-gated A2A agent for any API or SaaS product.
- A **payment adapter interface** implemented with x402 (Base Chain USDC), extensible to any payment rail.
- A **challenge/access-token lifecycle** engine with idempotency, replay protection, and expiration handling.

Client agents are **out of scope** — any A2A-compatible agent that can discover an agent card, hold a USDC wallet, and submit a transaction hash can interact with AgentGate. No buyer SDK is provided or required.

**Out of scope**: Buyer SDKs, multi-tenant SaaS dashboards, refund UIs, subscription recurring billing, fiat rails.

---

## 3. Personas

| Persona | Role | Pain Today |
|---|---|---|
| **API Provider** | Owns the product, deploys AgentGate alongside their API | No way to monetize agent traffic; signup walls block autonomous clients |
| **Client Agent** (external, out of scope) | Any A2A agent that discovers the card, pays on-chain, consumes the service | Treated as a black-box caller — assumed capable of wallet management and payment |
| **Open Source Contributor** | Developer adding new payment adapters or integrating AgentGate | Needs clear adapter interfaces and well-typed contracts |

---

## 4. Core User Stories

```
As an API provider,
I want to publish an agent card that describes my priced services,
So that any client agent can discover and pay for access without human signup.
```

```
As an API provider,
I want to receive USDC payments on-chain for each access grant,
So that I get paid instantly without invoicing, chargebacks, or card processing fees.
```

```
As an API provider,
I want to define product tiers (e.g. single photo vs. full album),
So that agents pay the right price for the right level of access.
```

```
As an API provider,
I want payment challenges to be idempotent and replay-protected,
So that I never double-bill or accept payment from the wrong chain.
```

---

## 5. System Architecture

```
  ANY A2A-COMPATIBLE CLIENT AGENT
  (wallet + payment capability assumed — not AgentGate's concern)
         │
         │  ① GET /.well-known/agent.json  (discover)
         │  ② A2A tasks/send → request-access  (get challenge)
         │  ③ [client pays on-chain independently]
         │  ④ A2A tasks/send → submit-proof  (submit txHash)
         │  ⑤ HTTPS + Bearer token  (consume API)
         │
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        AGENTGATE RUNTIME                             │
│                      (deployed by seller)                            │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────────┐  ┌────────────────┐  │
│  │  Agent Card     │  │   Challenge Engine    │  │ AccessToken    │  │
│  │  /.well-known/  │  │  - Idempotency        │  │ Issuer (JWT)   │  │
│  │  agent.json     │  │  - Expiry tracking    │  │ HS256 / RS256  │  │
│  │  (auto-served)  │  │  - State machine      │  └────────────────┘  │
│  └─────────────────┘  └──────────┬───────────┘                      │
│                                  │                                   │
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │                    Payment Adapter Layer                       │  │
│  │                                                                │  │
│  │   interface IPaymentAdapter { issueChallenge, verifyProof }   │  │
│  │                                                                │  │
│  │   ┌──────────────────┐    ┌─────────────────────────────┐    │  │
│  │   │  X402Adapter ✓   │    │  Future adapters             │    │  │
│  │   │  Base USDC       │    │  (Stripe, Lightning, etc.)   │    │  │
│  │   └──────────────────┘    └─────────────────────────────┘    │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │                                   │
│  ┌───────────────────────────────▼───────────────────────────────┐  │
│  │              On-Chain Verification (X402Adapter)               │  │
│  │   viem publicClient.getTransactionReceipt(txHash)              │  │
│  │   Validates: to address, USDC amount, chainId, block.timestamp │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │
         │  validateAccessToken() middleware (one import)
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  SELLER'S EXISTING API                               │
│         Unchanged — AgentGate sits in front, injects token check     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Data Models

### 6.1 Agent Card (A2A Standard Extension)

Published at `GET /.well-known/agent.json` on the seller's domain. Auto-generated from `SellerConfig` by `buildAgentCard()`.

```typescript
type AgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: false;
    pushNotifications: false;
    stateTransitionHistory: false;
  };
  defaultInputModes: ["application/json"];
  defaultOutputModes: ["application/json"];
  skills: AgentSkill[];
  provider: {
    name: string;
    url: string;
  };
  extensions: AgentExtension[];
};

type AgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  pricing?: SkillPricing[];
};

type SkillPricing = {
  tierId: string;
  label: string;
  amount: string;          // "$0.10" (USD, settled as USDC)
  asset: "USDC";
  chainId: number;         // 8453 (Base mainnet) | 84532 (Base Sepolia)
  walletAddress: `0x${string}`;
};
```

### 6.2 Access Request (Client → Seller Agent)

Sent as an A2A task message.

```typescript
type AccessRequest = {
  requestId: string;      // UUID, client-generated, used for idempotency
  resourceId: string;     // e.g. albumId, reportId, datasetId
  tierId: string;         // must match a ProductTier.tierId
  clientAgentId: string;  // DID or URL identifying the client agent
  callbackUrl?: string;   // optional webhook for async fulfillment
};
```

### 6.3 X402 Challenge (Seller → Client)

Returned as the A2A task result when the resource is paywalled.

```typescript
type X402Challenge = {
  type: "X402Challenge";
  challengeId: string;       // server-generated UUID, stable for same requestId
  requestId: string;         // echoed from AccessRequest (idempotency key)
  tierId: string;
  amount: string;            // "$0.10"
  asset: "USDC";
  chainId: number;           // 8453 or 84532 — MUST be validated on submission
  destination: `0x${string}`; // seller's wallet
  expiresAt: string;         // ISO-8601, default: now + 15 minutes
  description: string;
  resourceVerified: boolean; // true = seller confirmed resource exists pre-flight
};
```

### 6.4 Payment Proof (Client → Seller Agent)

```typescript
type PaymentProof = {
  type: "PaymentProof";
  challengeId: string;
  requestId: string;
  chainId: number;           // must match challenge.chainId — replay guard
  txHash: `0x${string}`;
  amount: string;            // must match challenge.amount
  asset: "USDC";
  fromAgentId: string;
};
```

### 6.5 Access Grant (Seller → Client)

Returned after successful proof verification.

```typescript
type AccessGrant = {
  type: "AccessGrant";
  challengeId: string;
  requestId: string;
  accessToken: string;       // JWT or custom token from onIssueToken callback
  tokenType: "Bearer";
  expiresAt: string;         // ISO-8601
  resourceEndpoint: string;  // actual API endpoint to call
  resourceId: string;
  tierId: string;
  txHash: `0x${string}`;
  explorerUrl: string;
};
```

### 6.6 Challenge States (Internal)

```
PENDING   → challenge issued, awaiting payment
PAID      → proof submitted and verified on-chain
EXPIRED   → expiresAt passed without valid proof
CANCELLED → seller cancelled (resource unavailable)
```

All state changes go through `IChallengeStore.transition(id, fromState, toState, updates)` — never direct writes. This is the atomic compare-and-swap guard that prevents race conditions.

### 6.7 Seller Configuration

```typescript
type SellerConfig = {
  // Identity
  agentName: string;
  agentDescription: string;
  agentUrl: string;
  providerName: string;
  providerUrl: string;
  version?: string;           // default: "1.0.0"

  // Payment
  walletAddress: `0x${string}`;  // public receive address (in agent card)
  network: "mainnet" | "testnet";

  // Product catalog
  products: readonly ProductTier[];

  // Challenge
  challengeTTLSeconds?: number;         // default: 900 (15 min)

  // Callbacks (mandatory)
  onVerifyResource: (resourceId: string, tierId: string) => Promise<boolean>;
  onIssueToken: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;

  // Callbacks (optional)
  onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
  onChallengeExpired?: (challengeId: string) => Promise<void>;

  // Customization
  basePath?: string;                    // default: "/a2a"
  resourceEndpointTemplate?: string;    // use {resourceId} placeholder
  resourceVerifyTimeoutMs?: number;     // default: 5000

  // Settlement strategy
  gasWalletPrivateKey?: `0x${string}`; // enables gas wallet mode (no facilitator)
  facilitatorUrl?: string;             // override default CDP facilitator URL
};

type ProductTier = {
  tierId: string;
  label: string;
  amount: string;           // "$0.10"
  resourceType: string;     // "photo" | "report" | "api-call"
  accessDurationSeconds?: number;
};

type IssueTokenParams = {
  challengeId: string;      // use as JWT jti for replay prevention
  requestId: string;        // use as JWT sub
  resourceId: string;
  tierId: string;
  txHash: `0x${string}`;
  accessDurationSeconds: number;
  clientAgentId: string;
};

type TokenIssuanceResult = {
  token: string;
  expiresAt: Date;
  tokenType: "Bearer";
};
```

---

## 7. API Specification

### 7.1 A2A Endpoints

All A2A communication follows the A2A protocol JSON-RPC pattern.

---

#### `GET /.well-known/agent.json`

Returns the agent card. No auth required.

**Response**: `AgentCard`

---

#### Skill: `request-access`

**Input**: `AccessRequest`

**Output (no existing active challenge)**: `X402Challenge` — resource exists, challenge issued

**Output (active challenge exists for requestId)**: Same `X402Challenge` — idempotent, same `challengeId`

**Output (resource not found)**: `AgentGateError` with `code: "RESOURCE_NOT_FOUND"`

**Pre-flight checks**:
1. Validate `tierId` is a known product tier.
2. Verify `resourceId` exists via `onVerifyResource` (with timeout).
3. Check for active challenge for `requestId` → return it (idempotency).

---

#### Skill: `submit-proof`

**Input**: `PaymentProof`

**Output (success)**: `AccessGrant`

**Output (challenge not found)**: `AgentGateError` `CHALLENGE_NOT_FOUND`

**Output (challenge expired)**: `AgentGateError` `CHALLENGE_EXPIRED`

**Output (chain mismatch)**: `AgentGateError` `CHAIN_MISMATCH`

**Output (amount mismatch)**: `AgentGateError` `AMOUNT_MISMATCH`

**Output (tx not confirmed)**: `AgentGateError` `TX_UNCONFIRMED`

**Output (already redeemed)**: `AgentGateError` `TX_ALREADY_REDEEMED`

**On-chain verification steps** (all six must pass):
1. Transaction receipt `status === "success"` (not just existence).
2. ERC-20 Transfer event present in logs.
3. `to` address matches the seller's `walletAddress`.
4. `value >= challenge.amountRaw` (USDC micro-units, 6 decimals).
5. `chainId` matches the challenge's `chainId` (replay guard).
6. `block.timestamp <= challenge.expiresAt` (payment must land before expiry).

After verification: mark challenge as `PAID`, call `onIssueToken`, fire `onPaymentReceived`, return `AccessGrant`.

---

### 7.2 x402 HTTP Endpoint

In addition to A2A, AgentGate mounts a standard x402 HTTP endpoint at `POST /a2a/access`:

```
Client POST /a2a/access (no PAYMENT-SIGNATURE)
  → Server responds HTTP 402 with x402 PaymentRequirements
Client signs EIP-3009 authorization off-chain
Client POST /a2a/access (with PAYMENT-SIGNATURE header)
  → Server settles payment (facilitator or gas wallet)
  → Server responds 200 with AccessGrant
```

---

### 7.3 Access Token Validation

AgentGate provides middleware for protecting seller API routes:

```typescript
// Express
import { validateAccessToken } from "@riklr/agentgate/express";
app.use("/api/photos", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET }));

// Standalone (no framework dependency)
import { validateAgentGateToken } from "@riklr/agentgate";
const payload = await validateAgentGateToken(authHeader, { secret });
```

The JWT payload (when using `AccessTokenIssuer`):
```typescript
{
  sub: requestId,
  jti: challengeId,     // replay detection — each token redeemable once
  resourceId: string,
  tierId: string,
  txHash: string,
  iat: number,
  exp: number
}
```

---

## 8. Payment Adapter Interface

All payment adapters implement a single interface, making the system extensible beyond x402.

```typescript
interface IPaymentAdapter {
  readonly protocol: string;

  issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload>;

  verifyProof(params: VerifyProofParams): Promise<VerificationResult>;
}

type VerificationResult = {
  success: boolean;
  txHash?: `0x${string}`;
  confirmedAmount?: string;
  confirmedChainId?: number;
  confirmedAt?: Date;
  error?: string;
};
```

### X402Adapter (Implemented)

- **Chain**: Base Sepolia (84532) for testnet, Base (8453) for mainnet
- **Asset**: USDC only
- **Verification**: `viem` `getTransactionReceipt` + ERC-20 Transfer event decode
- **Settlement**: Coinbase CDP facilitator (default) or gas wallet (`gasWalletPrivateKey`)

---

## 9. Security & Edge Case Handling

### 9.1 Idempotency

- **Key**: `requestId` (client-generated UUID).
- Before issuing a challenge, query existing challenges by `requestId`.
- Active challenge exists → return it unchanged (same `challengeId`).
- Prevents double-billing when a client retries after a network timeout.
- Expired challenge → issue a new one with a new `challengeId`.

### 9.2 Replay Attack Prevention

- Every challenge stores `chainId` at issuance.
- `submit-proof` asserts `proof.chainId === challenge.chainId`.
- A testnet payment cannot satisfy a mainnet challenge.
- Verified `txHash` values are stored in `ISeenTxStore` (atomic `SET NX`) — the same tx cannot be redeemed for two different challenges.

### 9.3 Pre-flight Resource Check

Before issuing a challenge, `onVerifyResource` confirms the resource exists and the tier grants access. If it fails → return `RESOURCE_NOT_FOUND` (no challenge issued, no billing risk). The callback has a configurable timeout (default 5s) via `resourceVerifyTimeoutMs`.

### 9.4 Payment Expiration

- Challenge has `expiresAt` (default: 15 minutes from issuance).
- On `submit-proof`, if `challenge.expiresAt < now` → `CHALLENGE_EXPIRED`.
- The on-chain `block.timestamp` must also be ≤ `expiresAt`.
  - A tx mined after expiry is rejected even if broadcast before.
- No automatic refund — the `onChallengeExpired` hook fires so sellers can automate refund logic.

### 9.5 Amount Underpayment

- `verifyProof` decodes the ERC-20 Transfer log and asserts `value >= challenge.amountRaw`.
- Partial payments are rejected. Full amount must be in a single transaction.
- Overpayments are accepted (seller keeps the difference).

### 9.6 Access Token Security

- Tokens are issued by the seller's `onIssueToken` callback — full control over format and lifetime.
- The built-in `AccessTokenIssuer` issues HS256 JWTs. Secret must be ≥ 32 characters.
- `jti` = `challengeId` for replay detection in the token validation middleware.
- `verifyWithFallback()` supports zero-downtime secret rotation.
- RS256 (public/private key pair) is also supported for asymmetric verification.

### 9.7 Concurrency Safety

- `IChallengeStore.transition(id, fromState, toState)` is the only path to update state. It is a compare-and-swap: if the current state doesn't match `fromState`, it returns `false` and no write occurs.
- For Redis storage: uses a Lua script that atomically checks and sets in one round-trip.
- `ISeenTxStore.markUsed(txHash, challengeId)` is atomic `SET NX` — only the first caller succeeds.

---

## 10. Seller Onboarding Flow

```
Step 1: Install SDK
  bun add @riklr/agentgate

Step 2: Configure
  - Set walletAddress (public, goes in agent card)
  - Set ACCESS_TOKEN_SECRET in .env (minimum 32 chars)
  - Set NETWORK=mainnet|testnet

Step 3: Define product catalog
  products: [{ tierId, label, amount, resourceType, accessDurationSeconds }]

Step 4: Implement callbacks
  onVerifyResource(resourceId, tierId): Promise<boolean>
  onIssueToken(params): Promise<TokenIssuanceResult>
  onPaymentReceived?(grant): Promise<void>   // optional

Step 5: Set up Redis storage
  const redis = new Redis(process.env.REDIS_URL)
  const store = new RedisChallengeStore({ redis })
  const seenTxStore = new RedisSeenTxStore({ redis })

Step 6: Mount the agent router
  app.use(agentGateRouter({ config, adapter, store, seenTxStore }))
  // Auto-serves:
  //   GET  /.well-known/agent.json
  //   POST /a2a/jsonrpc  (A2A JSON-RPC)
  //   POST /a2a/rest     (A2A REST)
  //   POST /a2a/access   (x402 HTTP)

Step 7: Protect your API
  app.use("/api", validateAccessToken({ secret: ACCESS_TOKEN_SECRET }))

Step 8: For production — switch to mainnet
```

### No Platform Signup Required

AgentGate is a **self-hosted open-source SDK**. There is no central registry or SaaS dashboard. The seller runs the agent runtime inside their own infrastructure alongside their existing API.

---

## 11. Wallet Management for Sellers

| Concern | Recommendation |
|---|---|
| **Receive wallet** | Use a dedicated hot wallet. Address goes in the agent card (public). |
| **Gas wallet** | If using gas wallet mode, keep the private key in `.env` or a secrets manager. Never in code. |
| **Key rotation** | Update wallet address in config + re-deploy. Old challenges still point to old address (they complete normally). |
| **Funds management** | Implement an off-ramp sweep job: periodically move USDC from receive wallet to cold storage. |

---

## 12. Technical Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun (primary), Node.js 18+ | Fast, native TypeScript, auto-loads `.env` |
| Chain interaction | viem | Type-safe, tree-shakeable, best-in-class EVM client |
| A2A protocol | `@a2a-js/sdk` | Standard A2A agent SDK |
| Payment protocol | x402 (`@x402/evm`) | Fits A2A agent pattern naturally, EIP-3009 compatible |
| Chain | Base mainnet (8453) / Base Sepolia (84532) | Low fees, USDC native, x402 facilitator support |
| Token standard | USDC ERC-20 | Stable, widely held |
| Access tokens | `jose` (JWT, HS256/RS256) | Standards-compliant, supports both symmetric and asymmetric keys |
| Challenge store | Redis via ioredis (`RedisChallengeStore`, `RedisSeenTxStore`) | Atomic Lua transitions, TTL-based cleanup, multi-process safe |
| Package | Single package `@riklr/agentgate` with framework subpath exports | Simple install, tree-shakeable |

---

## 13. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Challenge issuance latency | < 200ms (no on-chain call needed) |
| Proof verification latency | < 5s (one RPC call + receipt decode) |
| Idempotency window | Lifetime of challenge (default 15 min) |
| Replay attack surface | Zero — txHash uniqueness enforced atomically |
| TypeScript | Strict mode, no `any`, exported types for all public contracts |
| Storage | Redis required — `RedisChallengeStore` + `RedisSeenTxStore` are mandatory fields |

---

## 14. Open Questions

| # | Question | Status |
|---|---|---|
| OQ-1 | Should `requestId` be scoped per `clientAgentId`? | Open |
| OQ-2 | Refund SLA for late-landed payments after challenge expiry? | Open — `onChallengeExpired` hook enables custom logic |
| OQ-3 | Shared challenge registry for multi-seller discovery? | Out of scope |
| OQ-4 | Bind access token to submitting wallet address to prevent bearer theft? | Open |
| OQ-5 | Multi-page resources: one payment per session or per page? | Open — left to seller's `onVerifyResource` logic |
| OQ-6 | `onVerifyResource` async timeout? | **Resolved** — `resourceVerifyTimeoutMs` (default 5s) |

---

*End of Specification v0.2*
