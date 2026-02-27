# AgentGate — Product Requirements Specification

**Version**: 0.1 (Draft)
**Status**: Open for Review
**Date**: 2026-02-28
**Working Repo**: `api-agentic-commerce`

---

## 1. Problem Statement

SaaS products today are designed for human users: they require browser-based signups, OAuth flows, password managers, and credit-card checkout pages. AI agents cannot navigate these flows autonomously.

As the agent economy grows, SaaS companies need a way to:

1. **Expose** their services to autonomous agents without requiring human-in-the-loop authentication.
2. **Monetize** agent access without credit-card processors, subscription billing portals, or KYC friction.
3. **Control** access at the resource level — per-call, per-album, per-report — not just per-account.

**AgentGate** is an open-source framework that lets any SaaS company publish an A2A-compliant agent, define its priced capabilities, and accept crypto payments from client agents — all without changing their existing product backend.

---

## 2. Vision & Scope

> **One Agent Card. Zero Signup. Instant Access.**

AgentGate provides:
- A **seller SDK** to publish a payment-gated A2A agent for any SaaS product.
- A **buyer SDK** to discover, pay, and consume those services from a client agent.
- A **payment adapter interface** starting with x402 (Base Chain USDC), extensible to any payment rail.
- A **challenge/access-token lifecycle** engine with idempotency, replay protection, and expiration handling.

**Out of scope v0.1**: Multi-tenant SaaS dashboards, refund UIs, subscription recurring billing, fiat rails.

---

## 3. Personas

| Persona | Role | Pain Today |
|---|---|---|
| **SaaS Provider** (e.g. Riklr) | Owns the product, wants to sell access to agents | No way to monetize agent traffic; signup walls block autonomous clients |
| **Client Agent** | Autonomous AI agent that needs a service | Cannot create accounts, enter credit cards, or pass CAPTCHAs |
| **End User / Operator** | Human who owns the client agent | Wants their agent to work autonomously without constant approval prompts |
| **Open Source Contributor** | Developer extending AgentGate | Needs clear adapter interfaces and well-typed contracts |

---

## 4. Core User Stories

### 4.1 Provider (Seller) Journey

```
As a SaaS provider,
I want to publish an agent card that describes my priced services,
So that any client agent can discover and pay for access without human signup.
```

```
As a SaaS provider,
I want to receive USDC payments on-chain for each access grant,
So that I get paid instantly without invoicing, chargebacks, or card processing fees.
```

```
As a SaaS provider,
I want to define product tiers (e.g. single photo access vs. full album),
So that agents pay the right price for the right level of access.
```

```
As a SaaS provider,
I want payment challenges to be idempotent and replay-protected,
So that I never double-bill or accept underpayment from a different chain.
```

### 4.2 Client Agent Journey

```
As a client agent,
I want to discover a seller's capabilities from their agent card URL,
So that I know what services are available and at what price.
```

```
As a client agent,
I want to pay for access using my on-chain wallet (USDC on Base),
So that I can complete the transaction without human intervention.
```

```
As a client agent,
I want to receive a short-lived access token after payment,
So that I can call the seller's actual API without re-paying.
```

```
As a client agent,
I want clear error responses when a challenge has expired,
So that I can request a new challenge and retry rather than hanging.
```

---

## 5. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT AGENT                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌───────────────────┐  │
│  │ A2A Discovery│   │  Payment Adapter │   │  Access Token Use │  │
│  │ (Agent Card) │   │  (x402 / future) │   │  (Bearer Token)   │  │
│  └──────┬───────┘   └────────┬─────────┘   └────────┬──────────┘  │
└─────────┼────────────────────┼─────────────────────┼───────────────┘
          │  A2A (JSON-RPC)    │  On-chain USDC       │  HTTPS
          ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AGENTGATE RUNTIME                            │
│                                                                     │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────────┐ │
│  │  Agent Card    │  │ Challenge Engine │  │  Access Token Store  │ │
│  │  Registry      │  │ (Idempotency +  │  │  (JWT / opaque,      │ │
│  │  /.well-known/ │  │  Expiry +       │  │   short-lived)       │ │
│  │  agent.json    │  │  Replay Guard)  │  └──────────────────────┘ │
│  └────────────────┘  └────────┬────────┘                           │
│                               │                                    │
│  ┌────────────────────────────▼────────────────────────────────┐   │
│  │                  Payment Adapter Layer                       │   │
│  │  ┌──────────────────┐    ┌──────────────────────────────┐  │   │
│  │  │  x402Adapter     │    │  (Future) VisaAdapter / ...  │  │   │
│  │  │  - issueChallenge│    │  implements IPaymentAdapter  │  │   │
│  │  │  - verifyProof   │    └──────────────────────────────┘  │   │
│  │  └──────────────────┘                                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                               │                                    │
│  ┌────────────────────────────▼────────────────────────────────┐   │
│  │               On-Chain Verification Layer                    │   │
│  │  viem publicClient → waitForTransactionReceipt              │   │
│  │  Validates: txHash, amount, recipient, chainId, block time  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SELLER BACKEND (e.g. Riklr API)                  │
│  Receives access token → validates via AgentGate SDK → serves data  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Data Models

### 6.1 Agent Card (A2A Standard Extension)

Published at `GET /.well-known/agent.json` on the seller's domain.

```typescript
type AgentCard = {
  name: string;                    // "Riklr Agent"
  description: string;
  url: string;                     // Base URL of this agent
  version: string;                 // "1.0.0"
  capabilities: {
    a2a: true;
    paymentProtocols: PaymentProtocol[];   // ["x402"]
  };
  defaultInputModes: string[];     // ["application/json"]
  defaultOutputModes: string[];    // ["application/json"]
  skills: AgentSkill[];
  provider: {
    name: string;                  // "Riklr Inc."
    url: string;                   // "https://riklr.com"
  };
};

type PaymentProtocol = "x402" | "stripe" | "lightning";  // extensible

type AgentSkill = {
  id: string;                      // "request-access"
  name: string;                    // "Request Photo Access"
  description: string;
  tags: string[];
  inputSchema: JSONSchema;         // defines expected request body
  outputSchema: JSONSchema;        // defines response shape
  pricing?: SkillPricing[];       // optional — some skills are free
};

type SkillPricing = {
  tierId: string;                  // "single-photo" | "full-album"
  label: string;
  amount: string;                  // "$0.10" (USD, settled as USDC)
  asset: "USDC";
  chainId: number;                 // 8453 (Base mainnet) | 84532 (testnet)
  walletAddress: `0x${string}`;   // seller's receive wallet
};
```

### 6.2 Access Request (Client → Seller Agent)

Sent via A2A `tasks/send` to skill `request-access`.

```typescript
type AccessRequest = {
  requestId: string;      // UUID, client-generated, used for idempotency
  resourceId: string;     // e.g. albumId, reportId, datasetId
  tierId: string;         // "single-photo" | "full-album"
  clientAgentId: string;  // DID or URL identifying the client agent
  callbackUrl?: string;   // optional webhook for async fulfillment
};
```

### 6.3 X402 Challenge (Seller → Client)

Returned as the A2A task result when the resource is paywalled.

```typescript
type X402Challenge = {
  type: "X402Challenge";
  challengeId: string;      // server-generated UUID, stable for same requestId
  requestId: string;        // echoed from AccessRequest (idempotency key)
  tierId: string;
  amount: string;           // "$0.10"
  asset: "USDC";
  chainId: number;          // 8453 or 84532 — MUST be validated on submission
  destination: `0x${string}`;  // seller's wallet
  expiresAt: string;        // ISO-8601, default: now + 15 minutes
  description: string;      // human-readable e.g. "Access to Album #42"
  resourceVerified: boolean; // true = seller confirmed resource exists pre-flight
};
```

### 6.4 Payment Proof (Client → Seller Agent)

Sent via A2A `tasks/send` to skill `submit-proof`.

```typescript
type PaymentProof = {
  type: "PaymentProof";
  challengeId: string;
  requestId: string;
  chainId: number;           // must match challenge.chainId — replay guard
  txHash: `0x${string}`;
  amount: string;            // must match challenge.amount
  asset: "USDC";
  fromAgentId: string;       // client agent DID / URL
};
```

### 6.5 Access Grant (Seller → Client)

Returned after successful proof verification.

```typescript
type AccessGrant = {
  type: "AccessGrant";
  challengeId: string;
  requestId: string;
  accessToken: string;         // short-lived JWT or opaque token
  tokenType: "Bearer";
  expiresAt: string;           // ISO-8601, default: now + 1 hour
  resourceEndpoint: string;    // actual API endpoint to call
  resourceId: string;
  tierId: string;
  txHash: `0x${string}`;       // on-chain receipt reference
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

### 6.7 Seller Configuration (Environment / Config File)

```typescript
type SellerConfig = {
  // Identity
  agentName: string;
  agentUrl: string;            // public URL of this agent

  // Payment
  walletAddress: `0x${string}`;  // public receive address (in agent card)
  // SELLER_PRIVATE_KEY in .env — NEVER in config file

  // Network
  network: "mainnet" | "testnet";

  // Product catalog
  products: ProductTier[];

  // Access token
  accessTokenTTLSeconds: number;    // default: 3600
  accessTokenSecret: string;        // in .env

  // Challenge
  challengeTTLSeconds: number;      // default: 900 (15 min)

  // Callbacks
  onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
  onChallengeExpired?: (challengeId: string) => Promise<void>;
};

type ProductTier = {
  tierId: string;
  label: string;
  amount: string;           // "$0.10"
  resourceType: string;     // "photo" | "report" | "api-call"
  accessDurationSeconds?: number;  // null = single-use
};
```

---

## 7. API Specification

### 7.1 A2A Endpoints (Seller Agent)

All endpoints follow the [A2A protocol](https://google.github.io/A2A/) `tasks/send` pattern.

---

#### `GET /.well-known/agent.json`

Returns the agent card. No auth required.

**Response**: `AgentCard`

---

#### Skill: `request-access`

**Input**: `AccessRequest`
**Output (no existing active challenge)**: `X402Challenge` — resource exists, challenge issued
**Output (active challenge exists for requestId)**: Same `X402Challenge` — idempotent, same `challengeId` returned
**Output (resource not found)**: `{ type: "Error", code: "RESOURCE_NOT_FOUND", message: "..." }`

**Pre-flight checks before issuing challenge**:
1. Validate `tierId` is a known product tier.
2. Verify `resourceId` actually exists and is deliverable (preflight).
3. Check if an active (non-expired, non-paid) challenge already exists for `requestId` → return it (idempotency).
4. Validate `clientAgentId` format.

---

#### Skill: `submit-proof`

**Input**: `PaymentProof`
**Output (success)**: `AccessGrant`
**Output (challenge not found)**: `{ type: "Error", code: "CHALLENGE_NOT_FOUND" }`
**Output (challenge expired)**: `{ type: "Error", code: "CHALLENGE_EXPIRED", message: "Re-request access to get a new challenge." }`
**Output (chain mismatch)**: `{ type: "Error", code: "CHAIN_MISMATCH", message: "Payment was on wrong chain." }`
**Output (amount mismatch)**: `{ type: "Error", code: "AMOUNT_MISMATCH" }`
**Output (tx not confirmed)**: `{ type: "Error", code: "TX_UNCONFIRMED", message: "Transaction not yet confirmed. Retry in 30s." }`
**Output (already redeemed)**: `{ type: "Error", code: "PROOF_ALREADY_REDEEMED", grant: AccessGrant }`

**On-chain verification steps**:
1. Look up challenge by `challengeId`. Assert it exists and is `PENDING`.
2. Assert `proof.chainId === challenge.chainId` (replay attack guard).
3. Assert `proof.amount === challenge.amount` (underpayment guard).
4. Call `publicClient.getTransactionReceipt(txHash)`.
5. Decode ERC-20 `Transfer` event: assert `to === challenge.destination`.
6. Assert `value >= challenge.amountRaw` (USDC units with decimals).
7. Assert `block.timestamp <= challenge.expiresAt` (payment must land before expiry).
8. Mark challenge as `PAID`. Issue `AccessGrant`. Store txHash to prevent double-spend.

---

### 7.2 Access Token Validation (Seller Backend Middleware)

AgentGate provides a middleware helper for the seller's existing API:

```typescript
import { validateAccessToken } from "@agentgate/sdk";

app.use("/api/photos", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET }));
```

The JWT payload contains:
```typescript
{
  sub: requestId,
  jti: challengeId,
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
  readonly protocol: string;           // "x402" | "stripe" | "lightning"

  /**
   * Issue a payment challenge/invoice for a given access request.
   * Returns adapter-specific challenge data.
   */
  issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload>;

  /**
   * Verify a submitted payment proof.
   * Returns verified amount, sender, and on-chain receipt if applicable.
   */
  verifyProof(params: VerifyProofParams): Promise<VerificationResult>;
}

type IssueChallengeParams = {
  requestId: string;
  resourceId: string;
  tierId: string;
  amount: string;            // "$0.10"
  destination: string;       // wallet address, IBAN, or payment identifier
  expiresAt: Date;
  metadata: Record<string, unknown>;
};

type ChallengePayload = {
  challengeId: string;
  protocol: string;
  raw: unknown;              // protocol-specific fields exposed to client
  expiresAt: Date;
};

type VerifyProofParams = {
  challengeId: string;
  proof: unknown;            // protocol-specific proof object
};

type VerificationResult = {
  success: boolean;
  txHash?: string;
  confirmedAmount?: string;
  confirmedChainId?: number;
  confirmedAt?: Date;
  error?: string;
};
```

### 8.1 x402Adapter (v0.1 — implemented)

- Uses `viem` + Base Chain (mainnet or testnet based on `NETWORK` env).
- Challenge: issues `X402Challenge` with USDC amount, destination wallet, chainId.
- Verify: calls `publicClient.getTransactionReceipt`, decodes ERC-20 `Transfer` event, validates recipient and amount.
- Chain: Base Sepolia (84532) for testnet, Base (8453) for mainnet.
- Asset: USDC only.

### 8.2 Future Adapters (Interface Contract Only)

| Adapter | Protocol | Notes |
|---|---|---|
| `StripeAdapter` | Stripe Payment Intents | For fiat-paying agents with Stripe delegation |
| `LightningAdapter` | BOLT11 invoices | Micropayments over Lightning Network |
| `SolanaAdapter` | SPL USDC on Solana | Cross-chain expansion |

---

## 9. Security & Edge Case Handling

### 9.1 Idempotency

- **Key**: `requestId` (client-generated UUID).
- Before issuing a challenge, query existing challenges by `requestId`.
- If an active (non-expired) challenge exists → return it unchanged with the original `challengeId`.
- This prevents double-billing when a client retries after a network timeout.
- If the existing challenge is `PAID` → return `PROOF_ALREADY_REDEEMED` with the existing `AccessGrant`.
- If expired → issue a new challenge with a new `challengeId`.

### 9.2 Replay Attack Prevention

- Every challenge stores `chainId` at issuance.
- `submit-proof` asserts `proof.chainId === challenge.chainId`.
- A payment on Base Sepolia (testnet, cheap) cannot satisfy a challenge issued for Base mainnet.
- Verified `txHash` values are stored in a seen-set to prevent the same tx being redeemed for two different challenges.

### 9.3 Pre-flight Resource Check

- Before issuing a challenge (the invoice), the seller agent MUST verify:
  - The `resourceId` exists.
  - The `tierId` grants access to that resource.
  - The resource is not deleted or paused.
- If the check fails → return `RESOURCE_NOT_FOUND` (no challenge issued, no billing risk).

### 9.4 Payment Expiration

- Challenge has `expiresAt` (default: 15 minutes from issuance).
- On `submit-proof`, if `challenge.expiresAt < now` → return `CHALLENGE_EXPIRED`.
- The on-chain `block.timestamp` of the payment tx must also be ≤ `expiresAt`.
  - A tx mined after expiry is rejected even if it was broadcast before.
- **No automatic refund in v0.1** — the on-chain transfer already happened. Handling:
  - Return `CHALLENGE_EXPIRED` with a message: "Your payment landed after the challenge expired. Please contact [seller support URL] with txHash [0x...] for a manual refund."
  - The seller config `onChallengeExpired` hook fires so they can automate refund logic.
- **v0.2 roadmap**: Escrow pattern using EIP-3009 `transferWithAuthorization` — funds only settle after seller countersigns. Expired = authorization never used = no transfer.

### 9.5 Amount Underpayment

- `verifyProof` decodes the ERC-20 `Transfer` log and asserts `value >= challenge.amountRaw`.
- Partial payments are rejected. The client must pay the full amount in a single transaction.
- Overpayments are accepted (seller keeps the difference — no auto-refund in v0.1).

### 9.6 Access Token Security

- Tokens are short-lived JWTs (default 1 hour, configurable per tier).
- Signed with `ACCESS_TOKEN_SECRET` from `.env` — never in the agent card or config file.
- Token payload includes `txHash` and `challengeId` for audit trails.
- Seller middleware validates expiry and signature on every request.

---

## 10. Seller Onboarding Flow

### 10.1 Steps to Go Live

```
Step 1: Install SDK
  npm install @agentgate/sdk

Step 2: Configure
  - Set SELLER_WALLET_ADDRESS (public, goes in agent card)
  - Set SELLER_PRIVATE_KEY in .env (signs nothing in v0.1 — reserved for escrow)
  - Set ACCESS_TOKEN_SECRET in .env
  - Set NETWORK=mainnet|testnet

Step 3: Define product catalog
  - List product tiers (tierId, label, price, resourceType)

Step 4: Implement resource callbacks
  - onVerifyResource(resourceId, tierId): Promise<boolean>
  - onGrantAccess(grant: AccessGrant): Promise<void>

Step 5: Mount the agent router
  app.use("/agent", agentGateRouter(config))
  // This auto-serves:
  //   GET  /.well-known/agent.json
  //   POST /agent (A2A tasks/send)

Step 6: Protect your API
  app.use("/api", validateAccessToken({ secret: ... }))

Step 7: Publish your agent card URL
  - Submit to A2A agent registries
  - Add to README / developer docs
```

### 10.2 No Platform Signup Required

AgentGate is a **self-hosted open-source SDK**. There is no central registry or SaaS dashboard in v0.1. The seller runs the agent runtime inside their own infrastructure alongside their existing API.

---

## 11. Client Agent Onboarding Flow

### 11.1 Steps to Consume a Service

```
Step 1: Install buyer SDK
  npm install @agentgate/buyer-sdk

Step 2: Configure wallet
  - Set CLIENT_WALLET_PRIVATE_KEY in .env
  - Ensure wallet has sufficient USDC on Base

Step 3: Discover service
  const card = await fetchAgentCard("https://riklr.com/.well-known/agent.json")

Step 4: Request access
  const challenge = await requestAccess(card, {
    requestId: uuidv4(),          // store this for retry idempotency
    resourceId: "album-42",
    tierId: "single-photo",
    clientAgentId: myAgent.id,
  })

Step 5: Pay
  const proof = await payChallenge(challenge, {
    privateKey: process.env.CLIENT_WALLET_PRIVATE_KEY,
  })

Step 6: Submit proof
  const grant = await submitProof(card, proof)

Step 7: Use the service
  const photos = await fetch(grant.resourceEndpoint, {
    headers: { Authorization: `Bearer ${grant.accessToken}` },
  })
```

---

## 12. Wallet Management for Sellers

| Concern | Recommendation |
|---|---|
| **Receive wallet** | Use a dedicated hot wallet per product. Address goes in the agent card (public). |
| **Private key** | Store in `.env` or a secrets manager (Vault, AWS Secrets Manager). Never in code or config files. |
| **Key rotation** | Update wallet address in agent card + re-deploy. Old challenges still point to old address (they complete normally). |
| **Funds management** | Implement an off-ramp sweep job: periodically move USDC from receive wallet to cold storage. |
| **Multi-product** | Each product tier can have a separate `walletAddress` in its `SkillPricing` entry. |

---

## 13. Technical Stack (Reference Implementation)

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun | Fast, native TypeScript, auto-loads `.env` |
| Chain interaction | viem | Type-safe, tree-shakeable, best-in-class |
| A2A transport | Express + JSON-RPC | Minimal, widely understood |
| Payment protocol v1 | x402 (`@x402/express`, `@x402/fetch`) | Fits A2A agent pattern naturally |
| Chain | Base (mainnet) / Base Sepolia (testnet) | Low fees, USDC native, x402 facilitator support |
| Token standard | USDC ERC-20 | Stable, widely held, facilitator-settled |
| Access tokens | JWT (jsonwebtoken) | Stateless, standard, short-lived |
| Challenge store | In-memory Map (v0.1) → Redis (v0.2) | Simple to start, swap for production |

---

## 14. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Challenge issuance latency | < 200ms (no on-chain call needed) |
| Proof verification latency | < 5s (one RPC call + receipt decode) |
| Idempotency window | Lifetime of challenge (default 15 min) |
| Access token TTL | 1 hour default, configurable per tier |
| Replay attack surface | Zero — txHash + chainId double-key uniqueness |
| Test coverage | ≥ 80% for core challenge/verify pipeline |
| TypeScript | Strict mode, exported types for all public contracts |
| Zero external state dependencies | In-memory store works out of the box |

---

## 15. Open Questions & v0.2 Roadmap

### Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Should `requestId` be scoped per `clientAgentId` to prevent one agent using another's idempotency key? | Protocol design |
| OQ-2 | What is the refund SLA expectation for expired challenges? Manual vs automated? | Product |
| OQ-3 | Do we need a challenge registry (central lookup) or is peer-to-peer (seller holds all state) sufficient for v0.1? | Architecture |
| OQ-4 | Should access tokens be tied to the client's wallet address to prevent token theft? | Security |
| OQ-5 | How do we handle multi-step resources (e.g. paginated album) — single token covers all pages? | Product |

### v0.2 Roadmap

- **Escrow model**: EIP-3009 `transferWithAuthorization` — payment only settles on delivery, expired challenges cost nothing on-chain.
- **Redis-backed challenge store**: Replace in-memory Map for multi-instance deployments.
- **Webhook delivery**: `callbackUrl` support — push `AccessGrant` asynchronously for slow-to-verify resources.
- **Stripe adapter**: Fiat payments via Stripe Payment Intents for agents with delegated card access.
- **Rate limiting**: Per-`clientAgentId` request throttling.
- **Dashboard**: Read-only web UI for sellers to view payment history and active grants.
- **A2A agent registry integration**: Auto-register agent card with public registries on startup.

---

## 16. Example: Riklr End-to-End Flow

```
[Riklr Agent Card at https://riklr.com/.well-known/agent.json]
  skills: [request-access, submit-proof]
  pricing: { tierId: "single-photo", amount: "$0.10", chainId: 8453, destination: "0xRIKLR..." }

[Client Agent wants photo from album-42]

1. Client → Riklr Agent (request-access)
   { requestId: "uuid-1", resourceId: "album-42", tierId: "single-photo" }

   [AgentGate checks: album-42 exists? YES. Active challenge for uuid-1? NO.]

2. Riklr Agent → Client (X402Challenge)
   { challengeId: "chall-abc", amount: "$0.10", chainId: 8453,
     destination: "0xRIKLR...", expiresAt: "2026-02-28T10:15:00Z" }

3. Client pays 0.10 USDC on Base mainnet → gets txHash "0xTX..."

4. Client → Riklr Agent (submit-proof)
   { challengeId: "chall-abc", txHash: "0xTX...", chainId: 8453, amount: "$0.10" }

   [AgentGate: getTransactionReceipt("0xTX...") → Transfer log:
    to=0xRIKLR, value=100000 (0.10 USDC), block.timestamp < expiresAt ✓]

5. Riklr Agent → Client (AccessGrant)
   { accessToken: "eyJ...", resourceEndpoint: "https://api.riklr.com/photos/album-42/photo-1",
     expiresAt: "2026-02-28T11:00:00Z" }

6. Client → Riklr API
   GET /photos/album-42/photo-1
   Authorization: Bearer eyJ...
   → 200 OK { photoUrl: "..." }
```

---

*End of Specification v0.1*
