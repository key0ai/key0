# AgentGate — Technical Implementation Document

**Version**: 1.0
**Status**: Implementation Blueprint
**Date**: 2026-02-28
**Spec Reference**: `SPEC.md` v0.1
**Target**: Production-grade open-source SDK, self-hosted by any SaaS provider

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Core Type System](#3-core-type-system)
4. [Package: `@agentgate/types`](#4-package-agentgatetypes)
5. [Package: `@agentgate/core`](#5-package-agentgatecore)
6. [Package: `@agentgate/x402-adapter`](#6-package-agentgatex402-adapter)
7. [Package: `@agentgate/sdk`](#7-package-agentgatesdk)
8. [Challenge Engine](#8-challenge-engine)
9. [Access Token System](#9-access-token-system)
10. [Agent Card Generator](#10-agent-card-generator)
11. [A2A Protocol Handler](#11-a2a-protocol-handler)
12. [Storage Layer](#12-storage-layer)
13. [On-Chain Verification (x402Adapter)](#13-on-chain-verification-x402adapter)
14. [Configuration System](#14-configuration-system)
15. [Security Model](#15-security-model)
16. [Error System](#16-error-system)
17. [Middleware & Router](#17-middleware--router)
18. [Testing Strategy](#18-testing-strategy)
19. [Build, Publish & CI](#19-build-publish--ci)
20. [Deployment Guide](#20-deployment-guide)
21. [Open Questions Resolution](#21-open-questions-resolution)
22. [Implementation Order](#22-implementation-order)

---

## 1. Executive Summary

AgentGate is a self-hosted, open-source TypeScript SDK that lets any SaaS company expose payment-gated A2A (Agent-to-Agent) endpoints. A seller installs AgentGate, defines their product tiers and prices, and mounts a single router. Client agents discover the agent card, request access (receive a payment challenge), pay on-chain, submit proof, and receive a short-lived JWT to call the seller's existing API.

**What we ship:**

| Package | Purpose | Size Target |
|---|---|---|
| `@agentgate/types` | All shared TypeScript types and interfaces | Zero runtime, types only |
| `@agentgate/core` | Challenge engine, access token issuer, agent card builder, storage interfaces | ~15 KB min |
| `@agentgate/x402-adapter` | x402 payment adapter (Base Chain USDC via viem) | ~10 KB min |
| `@agentgate/sdk` | Express/Hono/Fastify router + `validateAccessToken` middleware | ~8 KB min |

**What we do NOT ship:**

- Buyer SDKs (any A2A-compatible agent works)
- SaaS dashboards or admin UIs
- Centralized registries or hosted services
- Fiat payment rails (v0.2 roadmap)
- Refund automation (v0.2 roadmap)

**Runtime**: Bun (primary) and Node.js 20+ (compatible)
**Language**: TypeScript 5.x, strict mode, no `any`
**Chain**: Base (mainnet, chain ID 8453) and Base Sepolia (testnet, chain ID 84532)
**Asset**: USDC (ERC-20, 6 decimals)

---

## 2. Monorepo Structure

```
agentgate/
├── package.json                    # Root workspace config (Bun workspaces)
├── tsconfig.base.json              # Shared TS config (strict, ESM)
├── turbo.json                      # Turborepo pipeline config
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Lint + type-check + test on every PR
│       ├── release.yml             # Publish to npm on tag push
│       └── canary.yml              # Publish canary on every merge to main
├── packages/
│   ├── types/                      # @agentgate/types
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # Re-exports everything
│   │       ├── agent-card.ts       # AgentCard, AgentSkill, SkillPricing
│   │       ├── challenge.ts        # AccessRequest, X402Challenge, PaymentProof, AccessGrant
│   │       ├── config.ts           # SellerConfig, ProductTier, NetworkConfig
│   │       ├── adapter.ts          # IPaymentAdapter, IssueChallengeParams, VerifyProofParams, VerificationResult
│   │       ├── storage.ts          # IChallengeStore, ISeenTxStore
│   │       ├── errors.ts           # AgentGateError, error code enum
│   │       └── a2a.ts              # A2A protocol message types (tasks/send, task result)
│   │
│   ├── core/                       # @agentgate/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # Re-exports public API
│   │       ├── challenge-engine.ts # Challenge lifecycle state machine
│   │       ├── access-token.ts     # JWT sign + verify (HS256)
│   │       ├── agent-card.ts       # Agent card builder from SellerConfig
│   │       ├── storage/
│   │       │   ├── memory.ts       # InMemoryChallengeStore + InMemorySeenTxStore
│   │       │   └── redis.ts        # RedisChallengeStore + RedisSeenTxStore
│   │       ├── validation.ts       # Input validation functions
│   │       └── clock.ts            # Injectable clock for testing (Date.now wrapper)
│   │
│   ├── x402-adapter/               # @agentgate/x402-adapter
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # Re-exports adapter
│   │       ├── adapter.ts          # x402Adapter implements IPaymentAdapter
│   │       ├── chain-config.ts     # Network constants (RPC, USDC address, explorer, facilitator)
│   │       ├── verify-transfer.ts  # getTransactionReceipt + Transfer event decode
│   │       └── usdc.ts             # USDC ABI subset, decimal constants
│   │
│   ├── sdk/                        # @agentgate/sdk
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # Re-exports: agentGateRouter, validateAccessToken
│   │       ├── router.ts           # Framework-agnostic request handler
│   │       ├── middleware.ts        # validateAccessToken middleware
│   │       ├── express.ts          # Express adapter (agentGateRouter for Express)
│   │       ├── hono.ts             # Hono adapter
│   │       └── fastify.ts          # Fastify plugin adapter
│   │
│   └── test-utils/                 # @agentgate/test-utils (NOT published)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── mock-adapter.ts     # MockPaymentAdapter for unit tests
│           ├── mock-store.ts       # Pre-seeded InMemoryStore helpers
│           └── fixtures.ts         # Typed test data factories
│
├── examples/
│   ├── express-seller/             # Full Express example with product tiers
│   │   ├── package.json
│   │   ├── server.ts
│   │   └── .env.example
│   ├── hono-seller/                # Hono on Cloudflare Workers example
│   │   ├── package.json
│   │   ├── worker.ts
│   │   └── wrangler.toml.example
│   └── client-agent/               # Minimal client agent showing full flow
│       ├── package.json
│       └── agent.ts
│
└── x402-poc/                       # Existing POC (kept for reference, not published)
    └── ...
```

### Workspace Configuration

**Root `package.json`:**

```json
{
  "name": "agentgate",
  "private": true,
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "clean": "turbo run clean"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
    "@biomejs/biome": "^1.9.0"
  }
}
```

**`tsconfig.base.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

### Build Tooling

| Tool | Purpose |
|---|---|
| **Turborepo** | Monorepo orchestration, caching, task graph |
| **tsup** | TypeScript bundling (ESM + CJS dual output per package) |
| **Biome** | Linting + formatting (single tool, replaces ESLint + Prettier) |
| **Bun test** | Test runner (Bun-native, compatible with Vitest API surface) |
| **changesets** | Version management and changelog generation for npm publishing |

Each package builds with `tsup`:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "biome check src/"
  }
}
```

---

## 3. Core Type System

All types live in `@agentgate/types`. Every other package imports from here. No package defines its own domain types.

### Design Principles

1. **Branded types for on-chain values**: `0x${string}` for addresses and tx hashes — prevents passing raw strings where hex is expected.
2. **Dollar amounts as strings**: Prices are `"$0.10"` strings in user-facing APIs, converted to `bigint` (USDC micro-units) only at the adapter boundary.
3. **Strict union types**: Challenge states, error codes, and payment protocols are string literal unions, never raw strings.
4. **No `any`**: Every type is fully specified. Adapter-specific payloads use generic type parameters, not `unknown`.
5. **ISO-8601 strings for dates**: All timestamps in API payloads are ISO-8601 strings. Internal engine uses `Date` objects.

---

## 4. Package: `@agentgate/types`

### `src/agent-card.ts`

```typescript
export type PaymentProtocol = "x402" | "stripe" | "lightning";

export type SkillPricing = {
  readonly tierId: string;
  readonly label: string;
  readonly amount: string;           // "$0.10" — human-readable USD, settled as USDC
  readonly asset: "USDC";
  readonly chainId: number;          // 8453 (Base) or 84532 (Base Sepolia)
  readonly walletAddress: `0x${string}`;
};

export type AgentSkillInputSchema = {
  readonly type: "object";
  readonly properties: Record<string, {
    readonly type: string;
    readonly description?: string;
  }>;
  readonly required?: readonly string[];
};

export type AgentSkill = {
  readonly id: string;               // "request-access" | "submit-proof"
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputSchema: AgentSkillInputSchema;
  readonly outputSchema: AgentSkillInputSchema;
  readonly pricing?: readonly SkillPricing[];
};

export type AgentCard = {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly version: string;
  readonly capabilities: {
    readonly a2a: true;
    readonly paymentProtocols: readonly PaymentProtocol[];
  };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly AgentSkill[];
  readonly provider: {
    readonly name: string;
    readonly url: string;
  };
};
```

### `src/challenge.ts`

```typescript
export type ChallengeState = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

export type AccessRequest = {
  readonly requestId: string;        // UUID, client-generated, idempotency key
  readonly resourceId: string;       // seller-defined resource identifier
  readonly tierId: string;           // must match a ProductTier.tierId
  readonly clientAgentId: string;    // DID or URL of client agent
  readonly callbackUrl?: string;     // optional async webhook
};

export type X402Challenge = {
  readonly type: "X402Challenge";
  readonly challengeId: string;      // server-generated UUID
  readonly requestId: string;        // echoed from AccessRequest
  readonly tierId: string;
  readonly amount: string;           // "$0.10"
  readonly asset: "USDC";
  readonly chainId: number;
  readonly destination: `0x${string}`;
  readonly expiresAt: string;        // ISO-8601
  readonly description: string;
  readonly resourceVerified: boolean;
};

export type PaymentProof = {
  readonly type: "PaymentProof";
  readonly challengeId: string;
  readonly requestId: string;
  readonly chainId: number;
  readonly txHash: `0x${string}`;
  readonly amount: string;
  readonly asset: "USDC";
  readonly fromAgentId: string;
};

export type AccessGrant = {
  readonly type: "AccessGrant";
  readonly challengeId: string;
  readonly requestId: string;
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresAt: string;        // ISO-8601
  readonly resourceEndpoint: string;
  readonly resourceId: string;
  readonly tierId: string;
  readonly txHash: `0x${string}`;
  readonly explorerUrl: string;
};

// Internal challenge record (stored in IChallengeStore)
export type ChallengeRecord = {
  readonly challengeId: string;
  readonly requestId: string;
  readonly clientAgentId: string;
  readonly resourceId: string;
  readonly tierId: string;
  readonly amount: string;           // "$0.10"
  readonly amountRaw: bigint;        // 100000n (USDC micro-units)
  readonly asset: "USDC";
  readonly chainId: number;
  readonly destination: `0x${string}`;
  readonly state: ChallengeState;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly paidAt?: Date;
  readonly txHash?: `0x${string}`;
  readonly accessGrant?: AccessGrant;
};
```

### `src/config.ts`

```typescript
import type { AccessGrant } from "./challenge.js";

export type NetworkName = "mainnet" | "testnet";

export type NetworkConfig = {
  readonly name: NetworkName;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly usdcAddress: `0x${string}`;
  readonly facilitatorUrl: string;
  readonly explorerBaseUrl: string;
};

export type ProductTier = {
  readonly tierId: string;
  readonly label: string;
  readonly amount: string;           // "$0.10"
  readonly resourceType: string;     // "photo" | "report" | "api-call"
  readonly accessDurationSeconds?: number;  // undefined = single-use
};

export type ResourceVerifier = (
  resourceId: string,
  tierId: string
) => Promise<boolean>;

export type SellerConfig = {
  // Identity
  readonly agentName: string;
  readonly agentDescription: string;
  readonly agentUrl: string;
  readonly providerName: string;
  readonly providerUrl: string;
  readonly version?: string;         // defaults to "1.0.0"

  // Payment
  readonly walletAddress: `0x${string}`;
  readonly network: NetworkName;

  // Product catalog
  readonly products: readonly ProductTier[];

  // Access token
  readonly accessTokenSecret: string;
  readonly accessTokenTTLSeconds?: number;   // defaults to 3600

  // Challenge
  readonly challengeTTLSeconds?: number;     // defaults to 900

  // Resource verification callback
  readonly onVerifyResource: ResourceVerifier;

  // Lifecycle hooks (optional)
  readonly onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
  readonly onChallengeExpired?: (challengeId: string) => Promise<void>;

  // Customization
  readonly basePath?: string;        // defaults to "/agent" — where A2A router mounts
  readonly resourceEndpointTemplate?: string;  // e.g. "https://api.example.com/photos/{resourceId}"
};
```

### `src/adapter.ts`

```typescript
export type IssueChallengeParams = {
  readonly requestId: string;
  readonly resourceId: string;
  readonly tierId: string;
  readonly amount: string;           // "$0.10"
  readonly destination: `0x${string}`;
  readonly expiresAt: Date;
  readonly metadata: Record<string, unknown>;
};

export type ChallengePayload = {
  readonly challengeId: string;
  readonly protocol: string;
  readonly raw: Record<string, unknown>;  // protocol-specific, exposed to client
  readonly expiresAt: Date;
};

export type VerifyProofParams = {
  readonly challengeId: string;
  readonly proof: {
    readonly txHash: `0x${string}`;
    readonly chainId: number;
    readonly amount: string;
    readonly asset: string;
  };
  readonly expected: {
    readonly destination: `0x${string}`;
    readonly amountRaw: bigint;
    readonly chainId: number;
    readonly expiresAt: Date;
  };
};

export type VerificationResult = {
  readonly verified: boolean;
  readonly txHash?: `0x${string}`;
  readonly confirmedAmount?: bigint;
  readonly confirmedChainId?: number;
  readonly confirmedAt?: Date;
  readonly blockNumber?: bigint;
  readonly error?: string;
  readonly errorCode?: VerificationErrorCode;
};

export type VerificationErrorCode =
  | "TX_NOT_FOUND"
  | "TX_REVERTED"
  | "WRONG_RECIPIENT"
  | "AMOUNT_INSUFFICIENT"
  | "CHAIN_MISMATCH"
  | "TX_AFTER_EXPIRY"
  | "NO_TRANSFER_EVENT"
  | "RPC_ERROR";

export interface IPaymentAdapter {
  readonly protocol: string;

  issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload>;

  verifyProof(params: VerifyProofParams): Promise<VerificationResult>;
}
```

### `src/storage.ts`

```typescript
import type { ChallengeRecord, ChallengeState } from "./challenge.js";

export interface IChallengeStore {
  /**
   * Get a challenge by its challengeId.
   * Returns null if not found.
   */
  get(challengeId: string): Promise<ChallengeRecord | null>;

  /**
   * Find an active (non-expired, state=PENDING) challenge by requestId.
   * Used for idempotency — same requestId returns the same challenge.
   * Returns null if no active challenge exists for that requestId.
   */
  findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null>;

  /**
   * Store a new challenge record.
   * Must reject if challengeId already exists (no overwrites).
   */
  create(record: ChallengeRecord): Promise<void>;

  /**
   * Atomically update a challenge's state and optional fields.
   * Must reject if the current state does not match `fromState` (optimistic concurrency).
   * Returns true if updated, false if state mismatch (someone else transitioned it).
   */
  transition(
    challengeId: string,
    fromState: ChallengeState,
    toState: ChallengeState,
    updates?: Partial<Pick<ChallengeRecord, "txHash" | "paidAt" | "accessGrant">>
  ): Promise<boolean>;
}

export interface ISeenTxStore {
  /**
   * Check if a txHash has already been used for any challenge.
   * Returns the challengeId it was used for, or null.
   */
  get(txHash: `0x${string}`): Promise<string | null>;

  /**
   * Mark a txHash as used for a given challengeId.
   * Must reject if txHash already exists (double-spend guard).
   * Returns true if stored, false if already existed.
   */
  markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean>;
}
```

### `src/errors.ts`

```typescript
export type AgentGateErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "TIER_NOT_FOUND"
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_EXPIRED"
  | "CHAIN_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "TX_UNCONFIRMED"
  | "TX_ALREADY_REDEEMED"
  | "PROOF_ALREADY_REDEEMED"
  | "INVALID_REQUEST"
  | "INVALID_PROOF"
  | "ADAPTER_ERROR"
  | "INTERNAL_ERROR";

export class AgentGateError extends Error {
  readonly code: AgentGateErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentGateErrorCode,
    message: string,
    httpStatus: number = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AgentGateError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  toJSON() {
    return {
      type: "Error" as const,
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
```

### `src/a2a.ts`

```typescript
/**
 * A2A protocol types for tasks/send.
 * Reference: https://google.github.io/A2A/
 */

export type A2ATaskSendRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: "tasks/send";
  readonly params: {
    readonly id: string;           // task ID
    readonly message: {
      readonly role: "user";
      readonly parts: readonly A2AMessagePart[];
    };
    readonly metadata?: Record<string, unknown>;
  };
};

export type A2AMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "data"; readonly data: Record<string, unknown>; readonly mimeType: "application/json" };

export type A2ATaskStatus = "submitted" | "working" | "input-required" | "completed" | "failed";

export type A2ATaskSendResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: {
    readonly id: string;
    readonly status: {
      readonly state: A2ATaskStatus;
      readonly message?: {
        readonly role: "agent";
        readonly parts: readonly A2AMessagePart[];
      };
    };
    readonly artifacts?: readonly {
      readonly name: string;
      readonly parts: readonly A2AMessagePart[];
    }[];
  };
};
```

---

## 5. Package: `@agentgate/core`

The core runtime. Framework-agnostic. No HTTP dependency. Operates on plain objects.

### Dependencies

```json
{
  "dependencies": {
    "@agentgate/types": "workspace:*",
    "jose": "^6.0.0"
  }
}
```

**Why `jose`**: Pure-JS JWT library. Works in Bun, Node.js, Deno, and edge runtimes (Cloudflare Workers). No native bindings. Supports HS256 (symmetric) for v0.1 and RS256 (asymmetric) for future multi-service deployments.

### Module: `challenge-engine.ts`

This is the heart of AgentGate. It manages the challenge lifecycle as a state machine.

```
                 ┌───────────┐
                 │  (start)  │
                 └─────┬─────┘
                       │ requestAccess()
                       ▼
                 ┌───────────┐
            ┌───►│  PENDING   │◄──── idempotent re-request
            │    └─────┬─────┘      (same requestId, non-expired)
            │          │
            │          ├─────── submitProof() ──────► ┌────────┐
            │          │                               │  PAID  │
            │          │                               └────────┘
            │          │
            │          ├─────── time passes ──────────► ┌─────────┐
            │          │                                │ EXPIRED │
            │          │                                └─────────┘
            │          │
            │          └─────── cancelChallenge() ───► ┌───────────┐
            │                                          │ CANCELLED │
            │                                          └───────────┘
            │
            └── expired challenge + new requestAccess() → new PENDING
```

**Public API:**

```typescript
import type {
  AccessRequest,
  X402Challenge,
  PaymentProof,
  AccessGrant,
  ChallengeRecord,
  IChallengeStore,
  ISeenTxStore,
  IPaymentAdapter,
  SellerConfig,
  ProductTier,
} from "@agentgate/types";

export type ChallengeEngineConfig = {
  readonly config: SellerConfig;
  readonly store: IChallengeStore;
  readonly seenTxStore: ISeenTxStore;
  readonly adapter: IPaymentAdapter;
  readonly tokenIssuer: AccessTokenIssuer;
  readonly clock?: () => number;     // injectable, defaults to Date.now
};

export class ChallengeEngine {
  constructor(opts: ChallengeEngineConfig);

  /**
   * Handle an access request. Returns an X402Challenge.
   *
   * Idempotency: if a PENDING challenge exists for the same requestId,
   * return it unchanged. If a PAID challenge exists, throw PROOF_ALREADY_REDEEMED
   * with the existing AccessGrant. If EXPIRED, issue a new challenge.
   *
   * Pre-flight: calls config.onVerifyResource() before issuing any challenge.
   */
  requestAccess(req: AccessRequest): Promise<X402Challenge>;

  /**
   * Handle a payment proof submission. Returns an AccessGrant.
   *
   * Verification steps (in order):
   *  1. Look up challenge by challengeId — must exist and be PENDING
   *  2. Check challenge not expired
   *  3. Check proof.chainId === challenge.chainId (replay guard)
   *  4. Check proof.amount === challenge.amount (underpayment guard)
   *  5. Check txHash not already redeemed (seen-tx store)
   *  6. Call adapter.verifyProof() — on-chain verification
   *  7. Transition challenge state PENDING → PAID
   *  8. Mark txHash as used in seen-tx store
   *  9. Issue access token via tokenIssuer
   * 10. Store AccessGrant on challenge record
   * 11. Fire config.onPaymentReceived hook
   */
  submitProof(proof: PaymentProof): Promise<AccessGrant>;

  /**
   * Cancel a challenge (e.g., resource became unavailable).
   * Only works for PENDING challenges.
   */
  cancelChallenge(challengeId: string): Promise<void>;

  /**
   * Get a challenge record by ID (for inspection/debugging).
   */
  getChallenge(challengeId: string): Promise<ChallengeRecord | null>;
}
```

**Implementation details:**

```typescript
// requestAccess — pseudocode

async requestAccess(req: AccessRequest): Promise<X402Challenge> {
  // 1. Validate input
  validateUUID(req.requestId, "requestId");
  validateNonEmpty(req.resourceId, "resourceId");
  validateNonEmpty(req.clientAgentId, "clientAgentId");

  // 2. Validate tier
  const tier = this.findTier(req.tierId);
  if (!tier) throw new AgentGateError("TIER_NOT_FOUND", ...);

  // 3. Pre-flight resource check
  const exists = await this.config.onVerifyResource(req.resourceId, req.tierId);
  if (!exists) throw new AgentGateError("RESOURCE_NOT_FOUND", ...);

  // 4. Idempotency check
  const existing = await this.store.findActiveByRequestId(req.requestId);
  if (existing) {
    if (existing.state === "PENDING" && existing.expiresAt > this.now()) {
      return this.challengeToResponse(existing);
    }
    if (existing.state === "PAID" && existing.accessGrant) {
      throw new AgentGateError("PROOF_ALREADY_REDEEMED", ..., 200, {
        grant: existing.accessGrant
      });
    }
    // EXPIRED or CANCELLED → fall through to issue new challenge
  }

  // 5. Issue challenge via adapter
  const expiresAt = new Date(this.now() + this.challengeTTL);
  const payload = await this.adapter.issueChallenge({
    requestId: req.requestId,
    resourceId: req.resourceId,
    tierId: req.tierId,
    amount: tier.amount,
    destination: this.config.walletAddress,
    expiresAt,
    metadata: { clientAgentId: req.clientAgentId },
  });

  // 6. Create challenge record
  const record: ChallengeRecord = {
    challengeId: payload.challengeId,
    requestId: req.requestId,
    clientAgentId: req.clientAgentId,
    resourceId: req.resourceId,
    tierId: req.tierId,
    amount: tier.amount,
    amountRaw: parseDollarToUsdcMicro(tier.amount),
    asset: "USDC",
    chainId: this.networkConfig.chainId,
    destination: this.config.walletAddress,
    state: "PENDING",
    expiresAt,
    createdAt: new Date(this.now()),
  };

  await this.store.create(record);

  // 7. Return challenge response
  return this.challengeToResponse(record);
}
```

```typescript
// submitProof — pseudocode

async submitProof(proof: PaymentProof): Promise<AccessGrant> {
  // 1. Validate input
  validateNonEmpty(proof.challengeId, "challengeId");
  validateTxHash(proof.txHash);

  // 2. Look up challenge
  const challenge = await this.store.get(proof.challengeId);
  if (!challenge) throw new AgentGateError("CHALLENGE_NOT_FOUND", ...);

  // 3. Check state
  if (challenge.state === "PAID" && challenge.accessGrant) {
    throw new AgentGateError("PROOF_ALREADY_REDEEMED", ..., 200, {
      grant: challenge.accessGrant
    });
  }
  if (challenge.state !== "PENDING") {
    throw new AgentGateError("CHALLENGE_EXPIRED", ...);
  }

  // 4. Check expiry
  if (challenge.expiresAt <= new Date(this.now())) {
    // Transition to EXPIRED and throw
    await this.store.transition(challenge.challengeId, "PENDING", "EXPIRED");
    throw new AgentGateError("CHALLENGE_EXPIRED", ...);
  }

  // 5. Chain mismatch guard
  if (proof.chainId !== challenge.chainId) {
    throw new AgentGateError("CHAIN_MISMATCH", ...);
  }

  // 6. Amount guard (compare dollar strings)
  if (proof.amount !== challenge.amount) {
    throw new AgentGateError("AMOUNT_MISMATCH", ...);
  }

  // 7. Double-spend guard
  const alreadyUsed = await this.seenTxStore.get(proof.txHash);
  if (alreadyUsed) {
    throw new AgentGateError("TX_ALREADY_REDEEMED", ..., 400, {
      existingChallengeId: alreadyUsed
    });
  }

  // 8. On-chain verification
  const result = await this.adapter.verifyProof({
    challengeId: challenge.challengeId,
    proof: {
      txHash: proof.txHash,
      chainId: proof.chainId,
      amount: proof.amount,
      asset: proof.asset,
    },
    expected: {
      destination: challenge.destination,
      amountRaw: challenge.amountRaw,
      chainId: challenge.chainId,
      expiresAt: challenge.expiresAt,
    },
  });

  if (!result.verified) {
    throw new AgentGateError(
      result.errorCode === "TX_NOT_FOUND" ? "TX_UNCONFIRMED" : "INVALID_PROOF",
      result.error ?? "On-chain verification failed",
      400,
      { verificationError: result.errorCode }
    );
  }

  // 9. Transition state — atomic, prevents concurrent double-redemption
  const transitioned = await this.store.transition(
    challenge.challengeId,
    "PENDING",
    "PAID",
    { txHash: proof.txHash, paidAt: new Date(this.now()) }
  );
  if (!transitioned) {
    // Another concurrent request already transitioned — reload and return
    const updated = await this.store.get(challenge.challengeId);
    if (updated?.accessGrant) {
      throw new AgentGateError("PROOF_ALREADY_REDEEMED", ..., 200, {
        grant: updated.accessGrant
      });
    }
    throw new AgentGateError("INTERNAL_ERROR", "Concurrent state transition", 500);
  }

  // 10. Mark txHash as used
  const marked = await this.seenTxStore.markUsed(proof.txHash, challenge.challengeId);
  if (!marked) {
    // Extremely unlikely race — another challenge claimed it between check and mark
    // Roll back challenge state
    await this.store.transition(challenge.challengeId, "PAID", "PENDING", {
      txHash: undefined,
      paidAt: undefined,
    });
    throw new AgentGateError("TX_ALREADY_REDEEMED", ...);
  }

  // 11. Issue access token
  const resourceEndpoint = this.buildResourceEndpoint(challenge.resourceId);
  const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${proof.txHash}`;

  const tokenTTL = this.findTier(challenge.tierId)?.accessDurationSeconds
    ?? this.config.accessTokenTTLSeconds
    ?? 3600;

  const tokenResult = await this.tokenIssuer.sign({
    sub: challenge.requestId,
    jti: challenge.challengeId,
    resourceId: challenge.resourceId,
    tierId: challenge.tierId,
    txHash: proof.txHash,
  }, tokenTTL);

  const grant: AccessGrant = {
    type: "AccessGrant",
    challengeId: challenge.challengeId,
    requestId: challenge.requestId,
    accessToken: tokenResult.token,
    tokenType: "Bearer",
    expiresAt: tokenResult.expiresAt.toISOString(),
    resourceEndpoint,
    resourceId: challenge.resourceId,
    tierId: challenge.tierId,
    txHash: proof.txHash,
    explorerUrl,
  };

  // 12. Store grant on challenge record
  await this.store.transition(challenge.challengeId, "PAID", "PAID", {
    accessGrant: grant,
  });

  // 13. Fire hook
  if (this.config.onPaymentReceived) {
    // Fire-and-forget — don't block the response on a seller hook
    this.config.onPaymentReceived(grant).catch((err) => {
      console.error("[AgentGate] onPaymentReceived hook error:", err);
    });
  }

  return grant;
}
```

---

## 6. Package: `@agentgate/x402-adapter`

### Dependencies

```json
{
  "dependencies": {
    "@agentgate/types": "workspace:*",
    "viem": "^2.21.0"
  }
}
```

**No `@x402/*` dependencies** in the adapter itself. The x402 protocol libraries (`@x402/express`, `@x402/fetch`) are used for the automated off-chain signing flow in the POC, but the AgentGate adapter only needs on-chain verification. Clients pay directly on-chain and submit the txHash. The adapter verifies the receipt.

### `src/chain-config.ts`

```typescript
import type { NetworkConfig, NetworkName } from "@agentgate/types";

export const CHAIN_CONFIGS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    facilitatorUrl: "https://x402.org/facilitator",
    explorerBaseUrl: "https://sepolia.basescan.org",
  },
  mainnet: {
    name: "mainnet",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
    explorerBaseUrl: "https://basescan.org",
  },
} as const;
```

### `src/usdc.ts`

```typescript
export const USDC_DECIMALS = 6;

export const USDC_TRANSFER_EVENT_SIGNATURE =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

// Minimal ABI: only Transfer event + balanceOf for balance checks
export const USDC_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Convert a "$X.XX" string to USDC micro-units (bigint).
 * "$0.10" → 100000n
 * "$1.00" → 1000000n
 */
export function parseDollarToUsdcMicro(amount: string): bigint {
  const cleaned = amount.replace("$", "").trim();
  const parts = cleaned.split(".");
  const whole = BigInt(parts[0] ?? "0");
  const fracStr = (parts[1] ?? "").padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  const frac = BigInt(fracStr);
  return whole * BigInt(10 ** USDC_DECIMALS) + frac;
}
```

### `src/verify-transfer.ts`

```typescript
import { createPublicClient, http, decodeEventLog, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { NetworkConfig, VerificationResult } from "@agentgate/types";
import { USDC_ABI, USDC_TRANSFER_EVENT_SIGNATURE } from "./usdc.js";

export type VerifyTransferParams = {
  readonly txHash: `0x${string}`;
  readonly expectedTo: `0x${string}`;
  readonly expectedAmountRaw: bigint;
  readonly expectedChainId: number;
  readonly challengeExpiresAt: Date;
  readonly networkConfig: NetworkConfig;
  readonly client: PublicClient;
};

export async function verifyTransfer(
  params: VerifyTransferParams
): Promise<VerificationResult> {
  const {
    txHash,
    expectedTo,
    expectedAmountRaw,
    challengeExpiresAt,
    networkConfig,
    client,
  } = params;

  // 1. Fetch transaction receipt
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Distinguish "tx not found" (pending/doesn't exist) from RPC errors
    if (message.includes("could not be found") || message.includes("not found")) {
      return {
        verified: false,
        error: "Transaction not found. It may be pending or the hash is invalid.",
        errorCode: "TX_NOT_FOUND",
      };
    }
    return {
      verified: false,
      error: `RPC error: ${message}`,
      errorCode: "RPC_ERROR",
    };
  }

  // 2. Check receipt status
  if (receipt.status === "reverted") {
    return {
      verified: false,
      txHash,
      error: "Transaction reverted on-chain.",
      errorCode: "TX_REVERTED",
    };
  }

  // 3. Find USDC Transfer event(s) to the expected destination
  const usdcAddress = networkConfig.usdcAddress.toLowerCase();
  let totalTransferred = 0n;
  let blockNumber = receipt.blockNumber;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress) continue;
    if (log.topics[0] !== USDC_TRANSFER_EVENT_SIGNATURE) continue;

    try {
      const decoded = decodeEventLog({
        abi: USDC_ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "Transfer") continue;

      const to = (decoded.args as { to: string }).to.toLowerCase();
      const value = (decoded.args as { value: bigint }).value;

      if (to === expectedTo.toLowerCase()) {
        totalTransferred += value;
      }
    } catch {
      // Skip logs that don't decode as Transfer
      continue;
    }
  }

  // 4. Check any transfer was found
  if (totalTransferred === 0n) {
    return {
      verified: false,
      txHash,
      blockNumber,
      error: `No USDC transfer to ${expectedTo} found in transaction.`,
      errorCode: "WRONG_RECIPIENT",
    };
  }

  // 5. Check amount
  if (totalTransferred < expectedAmountRaw) {
    return {
      verified: false,
      txHash,
      confirmedAmount: totalTransferred,
      blockNumber,
      error: `Transferred ${totalTransferred} but expected >= ${expectedAmountRaw} USDC micro-units.`,
      errorCode: "AMOUNT_INSUFFICIENT",
    };
  }

  // 6. Check block timestamp vs challenge expiry
  const block = await client.getBlock({ blockNumber });
  const blockTime = new Date(Number(block.timestamp) * 1000);
  if (blockTime > challengeExpiresAt) {
    return {
      verified: false,
      txHash,
      confirmedAmount: totalTransferred,
      confirmedAt: blockTime,
      blockNumber,
      error: "Payment transaction was mined after the challenge expired.",
      errorCode: "TX_AFTER_EXPIRY",
    };
  }

  // 7. Success
  return {
    verified: true,
    txHash,
    confirmedAmount: totalTransferred,
    confirmedChainId: networkConfig.chainId,
    confirmedAt: blockTime,
    blockNumber,
  };
}
```

### `src/adapter.ts`

```typescript
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type {
  IPaymentAdapter,
  IssueChallengeParams,
  ChallengePayload,
  VerifyProofParams,
  VerificationResult,
  NetworkName,
  NetworkConfig,
} from "@agentgate/types";
import { CHAIN_CONFIGS } from "./chain-config.js";
import { verifyTransfer } from "./verify-transfer.js";

export type X402AdapterConfig = {
  readonly network: NetworkName;
  readonly rpcUrl?: string;          // override default RPC
};

export class X402Adapter implements IPaymentAdapter {
  readonly protocol = "x402" as const;
  private readonly networkConfig: NetworkConfig;
  private readonly client: PublicClient;

  constructor(config: X402AdapterConfig) {
    this.networkConfig = {
      ...CHAIN_CONFIGS[config.network],
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    };

    const chain = config.network === "mainnet" ? base : baseSepolia;
    this.client = createPublicClient({
      chain,
      transport: http(this.networkConfig.rpcUrl),
    });
  }

  async issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload> {
    // x402 challenge issuance is purely local — no on-chain call needed.
    // Generate a unique challengeId, package the payment instructions.
    const challengeId = crypto.randomUUID();

    return {
      challengeId,
      protocol: this.protocol,
      raw: {
        type: "X402Challenge",
        chainId: this.networkConfig.chainId,
        asset: "USDC",
        usdcAddress: this.networkConfig.usdcAddress,
        facilitatorUrl: this.networkConfig.facilitatorUrl,
      },
      expiresAt: params.expiresAt,
    };
  }

  async verifyProof(params: VerifyProofParams): Promise<VerificationResult> {
    const { proof, expected } = params;

    // Chain mismatch is caught at the engine level, but double-check here
    if (proof.chainId !== expected.chainId) {
      return {
        verified: false,
        error: `Chain mismatch: proof=${proof.chainId}, expected=${expected.chainId}`,
        errorCode: "CHAIN_MISMATCH",
      };
    }

    return verifyTransfer({
      txHash: proof.txHash,
      expectedTo: expected.destination,
      expectedAmountRaw: expected.amountRaw,
      expectedChainId: expected.chainId,
      challengeExpiresAt: expected.expiresAt,
      networkConfig: this.networkConfig,
      client: this.client,
    });
  }

  getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }
}
```

---

## 7. Package: `@agentgate/sdk`

### Dependencies

```json
{
  "dependencies": {
    "@agentgate/types": "workspace:*",
    "@agentgate/core": "workspace:*",
    "jose": "^6.0.0"
  }
}
```

Peer dependencies for framework adapters:

```json
{
  "peerDependencies": {
    "express": ">=4.0.0",
    "hono": ">=4.0.0",
    "@fastify/plugin": ">=4.0.0"
  },
  "peerDependenciesMeta": {
    "express": { "optional": true },
    "hono": { "optional": true },
    "@fastify/plugin": { "optional": true }
  }
}
```

### Exports Map

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./express": "./dist/express.js",
    "./hono": "./dist/hono.js",
    "./fastify": "./dist/fastify.js"
  }
}
```

### `src/router.ts` — Framework-Agnostic Handler

The core router operates on a generic `Request` / `Response` abstraction. Framework-specific adapters convert to and from this abstraction.

```typescript
import {
  ChallengeEngine,
  AccessTokenVerifier,
  buildAgentCard,
} from "@agentgate/core";
import type {
  SellerConfig,
  AccessRequest,
  PaymentProof,
  A2ATaskSendRequest,
  AgentGateError,
} from "@agentgate/types";

export type AgentGateRouterDeps = {
  readonly engine: ChallengeEngine;
  readonly config: SellerConfig;
};

export type RouteResult = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

export class AgentGateRouter {
  private readonly engine: ChallengeEngine;
  private readonly config: SellerConfig;
  private readonly agentCard: ReturnType<typeof buildAgentCard>;

  constructor(deps: AgentGateRouterDeps) {
    this.engine = deps.engine;
    this.config = deps.config;
    this.agentCard = buildAgentCard(deps.config);
  }

  /**
   * Handle GET /.well-known/agent.json
   */
  async handleAgentCard(): Promise<RouteResult> {
    return {
      status: 200,
      body: this.agentCard,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    };
  }

  /**
   * Handle POST /agent (A2A tasks/send)
   * Dispatches to the correct skill based on message content.
   */
  async handleA2ATask(request: A2ATaskSendRequest): Promise<RouteResult> {
    const taskId = request.params.id;
    const parts = request.params.message.parts;

    // Extract the data part
    const dataPart = parts.find(
      (p): p is Extract<typeof p, { type: "data" }> => p.type === "data"
    );

    if (!dataPart) {
      return {
        status: 400,
        body: this.errorResponse(request.id, taskId, "No data part in message"),
      };
    }

    const payload = dataPart.data;

    try {
      // Route by type field
      if (payload["type"] === "AccessRequest" || this.isAccessRequest(payload)) {
        const challenge = await this.engine.requestAccess(payload as unknown as AccessRequest);
        return {
          status: 200,
          body: this.taskResponse(request.id, taskId, "completed", challenge),
        };
      }

      if (payload["type"] === "PaymentProof" || this.isPaymentProof(payload)) {
        const grant = await this.engine.submitProof(payload as unknown as PaymentProof);
        return {
          status: 200,
          body: this.taskResponse(request.id, taskId, "completed", grant),
        };
      }

      return {
        status: 400,
        body: this.errorResponse(request.id, taskId, "Unknown message type"),
      };
    } catch (err) {
      if (err instanceof AgentGateError) {
        // PROOF_ALREADY_REDEEMED with grant is a "success" response
        if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.grant) {
          return {
            status: 200,
            body: this.taskResponse(request.id, taskId, "completed", err.details.grant),
          };
        }

        return {
          status: err.httpStatus,
          body: this.errorTaskResponse(request.id, taskId, err),
        };
      }

      return {
        status: 500,
        body: this.errorResponse(request.id, taskId, "Internal error"),
      };
    }
  }

  // ... helper methods for A2A JSON-RPC response formatting
}
```

### `src/middleware.ts` — `validateAccessToken`

```typescript
import { jwtVerify, type JWTPayload } from "jose";

export type AccessTokenPayload = JWTPayload & {
  readonly sub: string;           // requestId
  readonly jti: string;           // challengeId
  readonly resourceId: string;
  readonly tierId: string;
  readonly txHash: string;
};

export type ValidateAccessTokenConfig = {
  readonly secret: string;
};

/**
 * Framework-agnostic token validation.
 * Returns decoded payload or throws.
 */
export async function validateToken(
  authHeader: string | undefined,
  config: ValidateAccessTokenConfig
): Promise<AccessTokenPayload> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AgentGateError("INVALID_REQUEST", "Missing or malformed Authorization header", 401);
  }

  const token = authHeader.slice(7);
  const secret = new TextEncoder().encode(config.secret);

  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as AccessTokenPayload;
  } catch (err) {
    if (err instanceof Error && err.message.includes("expired")) {
      throw new AgentGateError("CHALLENGE_EXPIRED", "Access token expired", 401);
    }
    throw new AgentGateError("INVALID_REQUEST", "Invalid access token", 401);
  }
}
```

### `src/express.ts` — Express Adapter

```typescript
import { Router, type Request, type Response, type NextFunction } from "express";
import type { SellerConfig, IPaymentAdapter, IChallengeStore, ISeenTxStore } from "@agentgate/types";
import { ChallengeEngine, AccessTokenIssuer, InMemoryChallengeStore, InMemorySeenTxStore } from "@agentgate/core";
import { AgentGateRouter } from "./router.js";
import { validateToken, type ValidateAccessTokenConfig } from "./middleware.js";

export type AgentGateExpressConfig = {
  readonly config: SellerConfig;
  readonly adapter: IPaymentAdapter;
  readonly store?: IChallengeStore;       // defaults to InMemoryChallengeStore
  readonly seenTxStore?: ISeenTxStore;    // defaults to InMemorySeenTxStore
};

/**
 * Create an Express router that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   app.use(agentGateRouter({ config, adapter }));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json
 *   POST {config.basePath} (A2A tasks/send)
 */
export function agentGateRouter(opts: AgentGateExpressConfig): Router {
  const store = opts.store ?? new InMemoryChallengeStore();
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore();
  const tokenIssuer = new AccessTokenIssuer(opts.config.accessTokenSecret);

  const engine = new ChallengeEngine({
    config: opts.config,
    store,
    seenTxStore,
    adapter: opts.adapter,
    tokenIssuer,
  });

  const handler = new AgentGateRouter({ engine, config: opts.config });
  const router = Router();

  // Agent Card
  router.get("/.well-known/agent.json", async (_req: Request, res: Response) => {
    const result = await handler.handleAgentCard();
    res.status(result.status);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        res.setHeader(k, v);
      }
    }
    res.json(result.body);
  });

  // A2A endpoint
  const basePath = opts.config.basePath ?? "/agent";
  router.post(basePath, async (req: Request, res: Response) => {
    const result = await handler.handleA2ATask(req.body);
    res.status(result.status).json(result.body);
  });

  return router;
}

/**
 * Express middleware to validate access tokens.
 *
 * Usage:
 *   app.use("/api/photos", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET }));
 */
export function validateAccessToken(config: ValidateAccessTokenConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await validateToken(req.headers.authorization, config);
      (req as any).agentGateToken = payload;
      next();
    } catch (err) {
      if (err instanceof AgentGateError) {
        res.status(err.httpStatus).json(err.toJSON());
      } else {
        res.status(500).json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
      }
    }
  };
}
```

### `src/hono.ts` — Hono Adapter

```typescript
import { Hono } from "hono";
import type { SellerConfig, IPaymentAdapter, IChallengeStore, ISeenTxStore } from "@agentgate/types";
import { ChallengeEngine, AccessTokenIssuer, InMemoryChallengeStore, InMemorySeenTxStore } from "@agentgate/core";
import { AgentGateRouter } from "./router.js";
import { validateToken, type ValidateAccessTokenConfig } from "./middleware.js";

export type AgentGateHonoConfig = {
  readonly config: SellerConfig;
  readonly adapter: IPaymentAdapter;
  readonly store?: IChallengeStore;
  readonly seenTxStore?: ISeenTxStore;
};

/**
 * Create a Hono app that serves the agent card and A2A endpoint.
 * Mount it as a sub-app: mainApp.route("/", agentGateApp(opts));
 */
export function agentGateApp(opts: AgentGateHonoConfig): Hono {
  const store = opts.store ?? new InMemoryChallengeStore();
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore();
  const tokenIssuer = new AccessTokenIssuer(opts.config.accessTokenSecret);

  const engine = new ChallengeEngine({
    config: opts.config,
    store,
    seenTxStore,
    adapter: opts.adapter,
    tokenIssuer,
  });

  const handler = new AgentGateRouter({ engine, config: opts.config });
  const app = new Hono();

  app.get("/.well-known/agent.json", async (c) => {
    const result = await handler.handleAgentCard();
    return c.json(result.body, result.status as any);
  });

  const basePath = opts.config.basePath ?? "/agent";
  app.post(basePath, async (c) => {
    const body = await c.req.json();
    const result = await handler.handleA2ATask(body);
    return c.json(result.body, result.status as any);
  });

  return app;
}

/**
 * Hono middleware to validate access tokens.
 */
export function honoValidateAccessToken(config: ValidateAccessTokenConfig) {
  return async (c: any, next: any) => {
    try {
      const payload = await validateToken(c.req.header("authorization"), config);
      c.set("agentGateToken", payload);
      await next();
    } catch (err) {
      if (err instanceof AgentGateError) {
        return c.json(err.toJSON(), err.httpStatus);
      }
      return c.json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" }, 500);
    }
  };
}
```

---

## 8. Challenge Engine

### State Machine (Formal)

```
States: { PENDING, PAID, EXPIRED, CANCELLED }
Initial: PENDING

Transitions:
  PENDING  → PAID       trigger: submitProof() succeeds
  PENDING  → EXPIRED    trigger: submitProof() when expiresAt < now
                         trigger: background sweep (optional)
  PENDING  → CANCELLED  trigger: cancelChallenge()

Terminal states: PAID, EXPIRED, CANCELLED (no transitions out)

Invariants:
  - A challenge's state can only move forward (no PAID → PENDING)
  - A txHash can only be associated with exactly one challenge (global uniqueness)
  - A requestId maps to at most one PENDING challenge at any time
  - Once PAID, the challenge record contains an AccessGrant that never changes
```

### Concurrency Safety

The challenge engine must be safe under concurrent requests (e.g., a client retries `submitProof` twice). Safety is guaranteed by:

1. **Optimistic concurrency on `store.transition()`**: The transition only succeeds if the current state matches `fromState`. If two concurrent `submitProof` calls both read `PENDING`, only one transition to `PAID` will succeed. The other gets `false` and returns `PROOF_ALREADY_REDEEMED`.

2. **Atomic `seenTxStore.markUsed()`**: Returns `false` if the txHash was already stored by another call. This prevents the same transaction hash from being used for two different challenges.

3. **No background expiration required**: Expiration is checked lazily on `submitProof` and `requestAccess`. A background sweep is optional (for metrics/cleanup) but not required for correctness.

### Dollar Amount Parsing

All prices flow through the system as `"$X.XX"` strings until the on-chain verification boundary, where they become `bigint` micro-units. The conversion is centralized in `parseDollarToUsdcMicro()`:

```
Input:    "$0.10"
Step 1:   Remove "$" → "0.10"
Step 2:   Split on "." → ["0", "10"]
Step 3:   Pad fractional to 6 digits → "100000"
Step 4:   whole * 10^6 + frac → 0 + 100000 = 100000n
Output:   100000n
```

Edge cases handled:
- `"$1"` → `1000000n` (no decimal)
- `"$0.000001"` → `1n` (smallest USDC unit)
- `"$0.1"` → `100000n` (single decimal digit)

---

## 9. Access Token System

### Token Format (v0.1)

**Algorithm**: HS256 (HMAC-SHA256, symmetric key)

**Rationale for HS256 over RS256 in v0.1**: AgentGate is self-hosted. The same process that signs the token also validates it. There is no separate "seller SDK that needs a public key" — the `validateAccessToken` middleware runs in the same deployment. HS256 is simpler, faster, and requires only a single secret. When future versions support multi-service token validation (one AgentGate instance issues tokens validated by multiple separate services), upgrade to RS256 with asymmetric keys.

**Payload:**

```json
{
  "sub": "request-id-uuid",
  "jti": "challenge-id-uuid",
  "resourceId": "album-42",
  "tierId": "single-photo",
  "txHash": "0x7f3a...",
  "iat": 1740564000,
  "exp": 1740567600
}
```

### `AccessTokenIssuer` (in `@agentgate/core`)

```typescript
import { SignJWT, jwtVerify } from "jose";

export type TokenClaims = {
  readonly sub: string;           // requestId
  readonly jti: string;           // challengeId
  readonly resourceId: string;
  readonly tierId: string;
  readonly txHash: string;
};

export type TokenResult = {
  readonly token: string;
  readonly expiresAt: Date;
};

export class AccessTokenIssuer {
  private readonly secret: Uint8Array;

  constructor(secretString: string) {
    if (secretString.length < 32) {
      throw new Error("ACCESS_TOKEN_SECRET must be at least 32 characters");
    }
    this.secret = new TextEncoder().encode(secretString);
  }

  async sign(claims: TokenClaims, ttlSeconds: number): Promise<TokenResult> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;

    const token = await new SignJWT({
      ...claims,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .sign(this.secret);

    return {
      token,
      expiresAt: new Date(exp * 1000),
    };
  }

  async verify(token: string): Promise<TokenClaims & { iat: number; exp: number }> {
    const { payload } = await jwtVerify(token, this.secret);
    return payload as TokenClaims & { iat: number; exp: number };
  }
}
```

### Secret Rotation Strategy

When rotating `ACCESS_TOKEN_SECRET`:

1. Deploy with both old and new secrets (new `AccessTokenIssuer` with new secret).
2. The `validateAccessToken` middleware attempts verification with the new secret first, falls back to the old secret.
3. After `accessTokenTTLSeconds` has passed (default 1 hour), remove the old secret.
4. All tokens issued with the old secret have expired by then.

This zero-downtime rotation requires a minor extension to the verify function:

```typescript
async verifyWithFallback(token: string, fallbackSecret?: string): Promise<TokenClaims> {
  try {
    return await this.verify(token);
  } catch {
    if (fallbackSecret) {
      const fallback = new TextEncoder().encode(fallbackSecret);
      const { payload } = await jwtVerify(token, fallback);
      return payload as TokenClaims;
    }
    throw;
  }
}
```

---

## 10. Agent Card Generator

The agent card is built from `SellerConfig` at startup and cached. It is regenerated only when configuration changes (no runtime database lookups).

### `buildAgentCard()` (in `@agentgate/core`)

```typescript
import type { AgentCard, SellerConfig, AgentSkill, SkillPricing, NetworkName } from "@agentgate/types";
import { CHAIN_CONFIGS } from "@agentgate/x402-adapter";

export function buildAgentCard(config: SellerConfig): AgentCard {
  const networkConfig = CHAIN_CONFIGS[config.network];

  // Build pricing entries for each product tier
  const pricingEntries: SkillPricing[] = config.products.map((tier) => ({
    tierId: tier.tierId,
    label: tier.label,
    amount: tier.amount,
    asset: "USDC" as const,
    chainId: networkConfig.chainId,
    walletAddress: config.walletAddress,
  }));

  // Define the two standard skills
  const skills: AgentSkill[] = [
    {
      id: "request-access",
      name: "Request Resource Access",
      description: "Submit an access request to receive a payment challenge. Pay the challenge to get an access token.",
      tags: ["payment", "access", "x402"],
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "Client-generated UUID for idempotency" },
          resourceId: { type: "string", description: "Identifier of the resource to access" },
          tierId: { type: "string", description: "Product tier to purchase" },
          clientAgentId: { type: "string", description: "DID or URL of the requesting agent" },
          callbackUrl: { type: "string", description: "Optional webhook URL for async fulfillment" },
        },
        required: ["requestId", "resourceId", "tierId", "clientAgentId"],
      },
      outputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "X402Challenge" },
          challengeId: { type: "string" },
          amount: { type: "string" },
          chainId: { type: "number" },
          destination: { type: "string" },
          expiresAt: { type: "string" },
        },
      },
      pricing: pricingEntries,
    },
    {
      id: "submit-proof",
      name: "Submit Payment Proof",
      description: "Submit on-chain payment proof (txHash) for a challenge. Returns an access token on success.",
      tags: ["payment", "proof", "verification"],
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "PaymentProof" },
          challengeId: { type: "string" },
          requestId: { type: "string" },
          chainId: { type: "number" },
          txHash: { type: "string" },
          amount: { type: "string" },
          asset: { type: "string" },
          fromAgentId: { type: "string" },
        },
        required: ["challengeId", "requestId", "chainId", "txHash", "amount", "asset", "fromAgentId"],
      },
      outputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "AccessGrant" },
          accessToken: { type: "string" },
          tokenType: { type: "string" },
          expiresAt: { type: "string" },
          resourceEndpoint: { type: "string" },
        },
      },
    },
  ];

  return {
    name: config.agentName,
    description: config.agentDescription,
    url: config.agentUrl,
    version: config.version ?? "1.0.0",
    capabilities: {
      a2a: true,
      paymentProtocols: ["x402"],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills,
    provider: {
      name: config.providerName,
      url: config.providerUrl,
    },
  };
}
```

---

## 11. A2A Protocol Handler

### Message Routing

The A2A protocol uses JSON-RPC 2.0 with a `tasks/send` method. AgentGate distinguishes between `request-access` and `submit-proof` by inspecting the message payload:

```
Incoming POST /agent
  └── JSON-RPC body
        └── params.message.parts[]
              └── find part where type === "data"
                    └── inspect data.type field
                          ├── "AccessRequest" or has (requestId + resourceId + tierId)
                          │     → ChallengeEngine.requestAccess()
                          │
                          └── "PaymentProof" or has (challengeId + txHash)
                                → ChallengeEngine.submitProof()
```

### Response Formatting

All A2A responses follow the JSON-RPC 2.0 format with task status and artifacts:

**Success (X402Challenge issued):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-id",
    "status": {
      "state": "completed",
      "message": {
        "role": "agent",
        "parts": [
          { "type": "text", "text": "Payment challenge issued. Send $0.10 USDC to 0x... on Base." }
        ]
      }
    },
    "artifacts": [
      {
        "name": "challenge",
        "parts": [
          {
            "type": "data",
            "data": { "type": "X402Challenge", "challengeId": "...", "amount": "$0.10", ... },
            "mimeType": "application/json"
          }
        ]
      }
    ]
  }
}
```

**Success (AccessGrant issued):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-id",
    "status": { "state": "completed" },
    "artifacts": [
      {
        "name": "grant",
        "parts": [
          {
            "type": "data",
            "data": { "type": "AccessGrant", "accessToken": "eyJ...", ... },
            "mimeType": "application/json"
          }
        ]
      }
    ]
  }
}
```

**Error:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-id",
    "status": {
      "state": "failed",
      "message": {
        "role": "agent",
        "parts": [
          {
            "type": "data",
            "data": { "type": "Error", "code": "CHALLENGE_EXPIRED", "message": "..." },
            "mimeType": "application/json"
          }
        ]
      }
    }
  }
}
```

---

## 12. Storage Layer

### In-Memory Implementation (Default)

Ships with `@agentgate/core`. Zero dependencies. Suitable for single-instance deployments.

```typescript
export class InMemoryChallengeStore implements IChallengeStore {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly requestIndex = new Map<string, string>(); // requestId → challengeId

  async get(challengeId: string): Promise<ChallengeRecord | null> {
    return this.challenges.get(challengeId) ?? null;
  }

  async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
    const challengeId = this.requestIndex.get(requestId);
    if (!challengeId) return null;
    const record = this.challenges.get(challengeId);
    if (!record) return null;
    // Return regardless of state — engine decides what to do
    return record;
  }

  async create(record: ChallengeRecord): Promise<void> {
    if (this.challenges.has(record.challengeId)) {
      throw new Error(`Challenge ${record.challengeId} already exists`);
    }
    this.challenges.set(record.challengeId, record);
    this.requestIndex.set(record.requestId, record.challengeId);
  }

  async transition(
    challengeId: string,
    fromState: ChallengeState,
    toState: ChallengeState,
    updates?: Partial<Pick<ChallengeRecord, "txHash" | "paidAt" | "accessGrant">>
  ): Promise<boolean> {
    const record = this.challenges.get(challengeId);
    if (!record || record.state !== fromState) return false;

    // In-memory is single-threaded in JS — this is inherently atomic
    this.challenges.set(challengeId, {
      ...record,
      state: toState,
      ...updates,
    });
    return true;
  }
}

export class InMemorySeenTxStore implements ISeenTxStore {
  private readonly seen = new Map<`0x${string}`, string>(); // txHash → challengeId

  async get(txHash: `0x${string}`): Promise<string | null> {
    return this.seen.get(txHash) ?? null;
  }

  async markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean> {
    if (this.seen.has(txHash)) return false;
    this.seen.set(txHash, challengeId);
    return true;
  }
}
```

### Memory Management

The in-memory store grows unboundedly. For production:

1. **Automatic cleanup**: A background interval (configurable, default 5 minutes) removes EXPIRED and CANCELLED challenges older than 1 hour, and PAID challenges older than 24 hours.

2. **Size guard**: If the store exceeds 100,000 entries (configurable), reject new challenge creation with a 503 (overloaded). This prevents OOM in long-running single-instance deployments.

```typescript
export type InMemoryStoreConfig = {
  readonly cleanupIntervalMs?: number;    // default: 300_000 (5 min)
  readonly maxEntries?: number;           // default: 100_000
  readonly expiredRetentionMs?: number;   // default: 3_600_000 (1 hour)
  readonly paidRetentionMs?: number;      // default: 86_400_000 (24 hours)
};
```

### Redis Implementation

Ships with `@agentgate/core` but requires `ioredis` as a peer dependency. Uses Redis hashes for challenge records and simple keys for the seen-tx store.

**Key schema:**

```
agentgate:challenge:{challengeId}        → Hash (all ChallengeRecord fields)
agentgate:request:{requestId}            → String (challengeId)
agentgate:seentx:{txHash}                → String (challengeId)
```

**TTL strategy:**

- `challenge:{challengeId}` TTL = `challengeTTLSeconds + 3600` (challenge lifetime + 1 hour buffer for post-expiry lookups)
- `request:{requestId}` TTL = same as its challenge
- `seentx:{txHash}` TTL = 7 days (long enough to catch any replay attempts)

**Atomic transitions via Lua script:**

```lua
-- KEYS[1] = challenge hash key
-- ARGV[1] = expected fromState
-- ARGV[2] = new toState
-- ARGV[3..N] = field/value pairs for updates

local current = redis.call('HGET', KEYS[1], 'state')
if current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
end
return 1
```

**Atomic markUsed via `SET NX`:**

```typescript
async markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean> {
  const key = `agentgate:seentx:${txHash}`;
  const result = await this.redis.set(key, challengeId, "EX", 604800, "NX");
  return result === "OK";
}
```

---

## 13. On-Chain Verification (x402Adapter)

### Verification Flow

```
submitProof(txHash)
       │
       ▼
getTransactionReceipt(txHash) via viem publicClient
       │
       ├── Not found? → TX_NOT_FOUND (client should retry in 30s)
       ├── Status reverted? → TX_REVERTED
       │
       ▼
Iterate receipt.logs
       │
       ├── Filter: log.address === USDC contract
       ├── Filter: log.topics[0] === Transfer event signature
       ├── Decode: from, to, value
       ├── Filter: to === challenge.destination (seller wallet)
       ├── Sum matching transfer values
       │
       ▼
Check total >= challenge.amountRaw
       │
       ├── Insufficient? → AMOUNT_INSUFFICIENT
       │
       ▼
getBlock(receipt.blockNumber) → block.timestamp
       │
       ├── block.timestamp > challenge.expiresAt? → TX_AFTER_EXPIRY
       │
       ▼
✓ VERIFIED
```

### RPC Reliability

The adapter accepts a custom `rpcUrl` to allow sellers to use their own RPC provider (Alchemy, QuickNode, Infura) instead of the default public RPC. This is strongly recommended for production:

```typescript
const adapter = new X402Adapter({
  network: "mainnet",
  rpcUrl: "https://base-mainnet.g.alchemy.com/v2/YOUR_KEY",
});
```

**Retry strategy**: The `viem` `publicClient` handles basic transport retries. AgentGate does NOT add its own retry logic on top — if the RPC call fails, the error propagates to the client as `TX_UNCONFIRMED` with a retry instruction. The client can retry `submitProof` (idempotent — if the challenge was already paid, it returns `PROOF_ALREADY_REDEEMED` with the existing grant).

### Transfer Event Signature

The ERC-20 Transfer event has a fixed topic hash (keccak256 of the event signature). This is the same for every ERC-20 token on every EVM chain:

```
Transfer(address,address,uint256)
→ keccak256 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```

This is a constant — it never changes. No need to compute it at runtime.

---

## 14. Configuration System

### Environment Variables

```env
# Required
AGENTGATE_WALLET_ADDRESS=0x...               # Seller's receive wallet (public, goes in agent card)
AGENTGATE_ACCESS_TOKEN_SECRET=your-secret-at-least-32-chars  # JWT signing secret
AGENTGATE_NETWORK=mainnet                     # "mainnet" or "testnet"

# Optional
AGENTGATE_CHALLENGE_TTL_SECONDS=900           # Default: 900 (15 min)
AGENTGATE_ACCESS_TOKEN_TTL_SECONDS=3600       # Default: 3600 (1 hour)
AGENTGATE_RPC_URL=https://...                 # Custom RPC endpoint (recommended for production)
AGENTGATE_BASE_PATH=/agent                    # A2A endpoint mount path
```

### Programmatic Config

Environment variables provide defaults. The `SellerConfig` object passed to `agentGateRouter()` takes precedence:

```typescript
import { agentGateRouter } from "@agentgate/sdk/express";
import { X402Adapter } from "@agentgate/x402-adapter";

const adapter = new X402Adapter({
  network: process.env.AGENTGATE_NETWORK as "mainnet" | "testnet",
  rpcUrl: process.env.AGENTGATE_RPC_URL,
});

app.use(agentGateRouter({
  config: {
    agentName: "Riklr Agent",
    agentDescription: "Access premium photo albums",
    agentUrl: "https://riklr.com",
    providerName: "Riklr Inc.",
    providerUrl: "https://riklr.com",
    walletAddress: process.env.AGENTGATE_WALLET_ADDRESS as `0x${string}`,
    network: process.env.AGENTGATE_NETWORK as "mainnet" | "testnet",
    accessTokenSecret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
    products: [
      {
        tierId: "single-photo",
        label: "Single Photo Access",
        amount: "$0.10",
        resourceType: "photo",
        accessDurationSeconds: 3600,
      },
      {
        tierId: "full-album",
        label: "Full Album Access",
        amount: "$1.00",
        resourceType: "album",
        accessDurationSeconds: 86400,
      },
    ],
    onVerifyResource: async (resourceId, tierId) => {
      // Seller implements: check if resource exists in their system
      const album = await db.albums.findById(resourceId);
      return album !== null && album.status === "active";
    },
    resourceEndpointTemplate: "https://api.riklr.com/photos/{resourceId}",
  },
  adapter,
}));
```

### Config Validation

At startup, `agentGateRouter()` validates:

1. `walletAddress` is a valid `0x`-prefixed 40-hex-char address
2. `accessTokenSecret` is at least 32 characters
3. `products` array is non-empty
4. Every `tierId` is unique across products
5. Every `amount` parses to a valid positive `bigint` via `parseDollarToUsdcMicro()`
6. `network` is "mainnet" or "testnet"
7. `onVerifyResource` is a function

Validation failures throw at startup with clear messages (fail fast).

---

## 15. Security Model

### Threat Model

| Threat | Mitigation |
|---|---|
| **Replay attack**: Reuse a txHash for multiple challenges | `ISeenTxStore` enforces global txHash uniqueness. `markUsed()` is atomic. |
| **Cross-chain replay**: Pay on testnet, claim on mainnet | Challenge records store `chainId`. `submitProof` asserts `proof.chainId === challenge.chainId`. |
| **Double-spend**: Submit proof twice for the same challenge | `store.transition()` uses optimistic concurrency. Only one `PENDING → PAID` transition succeeds. |
| **Underpayment**: Pay less than the challenge amount | On-chain verification checks `totalTransferred >= challenge.amountRaw`. |
| **Late payment**: Pay after challenge expires | Block timestamp comparison: `block.timestamp <= challenge.expiresAt`. |
| **Token theft**: Stolen JWT used by another agent | JWT is short-lived (1 hour default). Contains `txHash` and `challengeId` for audit. Bind to wallet address in v0.2. |
| **Token forging**: Create fake JWT without payment | JWT signed with `ACCESS_TOKEN_SECRET`. Without the secret, tokens cannot be forged. HMAC-SHA256 is cryptographically secure. |
| **Idempotency key collision**: Two agents use the same `requestId` | v0.1 treats `requestId` as globally unique. OQ-1 resolution: scope `requestId` per `clientAgentId` in v0.2. |
| **Resource enumeration**: Probe `requestAccess` with random resourceIds | `onVerifyResource` is called before challenge issuance. Rate limiting at the HTTP layer is the seller's responsibility. |
| **DDoS via challenge flooding**: Create millions of PENDING challenges | In-memory store has a `maxEntries` limit (default 100K). Redis store can use TTL-based eviction. |

### Secret Management

| Secret | Where | Access |
|---|---|---|
| `ACCESS_TOKEN_SECRET` | `.env` or secrets manager | Never in agent card, config files, or logs |
| `SELLER_PRIVATE_KEY` | `.env` or secrets manager | Reserved for v0.2 escrow — not used in v0.1 |
| `walletAddress` | Agent card (public) | Safe to expose — it's a receive-only address |

### Input Validation

Every external input is validated before processing:

```typescript
// In @agentgate/core/validation.ts

export function validateUUID(value: string, label: string): void {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(value)) {
    throw new AgentGateError("INVALID_REQUEST", `${label} must be a valid UUID`, 400);
  }
}

export function validateTxHash(value: string): asserts value is `0x${string}` {
  const TX_RE = /^0x[0-9a-fA-F]{64}$/;
  if (!TX_RE.test(value)) {
    throw new AgentGateError("INVALID_REQUEST", "txHash must be a 0x-prefixed 64-char hex string", 400);
  }
}

export function validateAddress(value: string): asserts value is `0x${string}` {
  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  if (!ADDR_RE.test(value)) {
    throw new AgentGateError("INVALID_REQUEST", "Address must be a 0x-prefixed 40-char hex string", 400);
  }
}

export function validateNonEmpty(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new AgentGateError("INVALID_REQUEST", `${label} must not be empty`, 400);
  }
}

export function validateDollarAmount(value: string, label: string): void {
  const DOLLAR_RE = /^\$\d+(\.\d{1,6})?$/;
  if (!DOLLAR_RE.test(value)) {
    throw new AgentGateError("INVALID_REQUEST", `${label} must be a dollar amount (e.g. "$0.10")`, 400);
  }
}
```

---

## 16. Error System

### Error Codes and HTTP Status Mapping

| Code | HTTP | When |
|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | `onVerifyResource` returned false |
| `TIER_NOT_FOUND` | 400 | `tierId` doesn't match any product |
| `CHALLENGE_NOT_FOUND` | 404 | `challengeId` doesn't exist in store |
| `CHALLENGE_EXPIRED` | 410 | Challenge `expiresAt` has passed |
| `CHAIN_MISMATCH` | 400 | `proof.chainId !== challenge.chainId` |
| `AMOUNT_MISMATCH` | 400 | `proof.amount !== challenge.amount` |
| `TX_UNCONFIRMED` | 202 | Transaction not yet on-chain (retry) |
| `TX_ALREADY_REDEEMED` | 409 | txHash used for a different challenge |
| `PROOF_ALREADY_REDEEMED` | 200 | Challenge already PAID — returns existing grant |
| `INVALID_REQUEST` | 400 | Malformed input, missing fields, bad types |
| `INVALID_PROOF` | 400 | On-chain verification failed (wrong recipient, reverted, etc.) |
| `ADAPTER_ERROR` | 502 | Payment adapter internal error (RPC failure) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Error Response Shape

All errors are serialized via `AgentGateError.toJSON()`:

```json
{
  "type": "Error",
  "code": "CHALLENGE_EXPIRED",
  "message": "Challenge expired. Re-request access to get a new challenge."
}
```

With details (when applicable):

```json
{
  "type": "Error",
  "code": "PROOF_ALREADY_REDEEMED",
  "message": "This challenge has already been redeemed.",
  "details": {
    "grant": { "type": "AccessGrant", "accessToken": "eyJ...", ... }
  }
}
```

### TX_UNCONFIRMED (Special Case)

When the tx is not yet on-chain, the response uses HTTP 202 (Accepted) to signal "your request is valid but we can't verify yet":

```json
{
  "type": "Error",
  "code": "TX_UNCONFIRMED",
  "message": "Transaction not yet confirmed on-chain. Retry in 30 seconds."
}
```

Client behavior: wait 30 seconds and retry `submitProof` with the same payload. If the challenge expires before the tx confirms, the client gets `CHALLENGE_EXPIRED`.

---

## 17. Middleware & Router

### Router Mount Points

When a seller calls `app.use(agentGateRouter({ config, adapter }))`, the following routes are registered:

```
GET  /.well-known/agent.json     → Agent card (public, cacheable)
POST /agent                       → A2A tasks/send (or config.basePath)
```

The `validateAccessToken` middleware is separate and mounted by the seller on their own API routes:

```
GET  /api/photos/:id              → Seller's existing route
  └── validateAccessToken()       → Validates JWT, attaches decoded claims
```

### Request/Response Flow

```
Client → HTTP POST /agent
  │
  ├── Express/Hono/Fastify receives request
  ├── Framework adapter parses body as JSON-RPC
  ├── Passes to AgentGateRouter.handleA2ATask()
  │     ├── Extracts data part from message
  │     ├── Routes to ChallengeEngine.requestAccess() or submitProof()
  │     ├── ChallengeEngine calls:
  │     │     ├── config.onVerifyResource() (for requestAccess)
  │     │     ├── IPaymentAdapter.verifyProof() (for submitProof)
  │     │     ├── IChallengeStore read/write
  │     │     ├── ISeenTxStore read/write
  │     │     └── AccessTokenIssuer.sign()
  │     └── Returns RouteResult { status, body }
  ├── Framework adapter serializes response
  └── HTTP response sent
```

---

## 18. Testing Strategy

### Test Pyramid

```
                    ┌─────────────┐
                    │  E2E Tests  │  ← 5 tests (full flow with testnet)
                    ├─────────────┤
                    │ Integration │  ← 20 tests (engine + mock adapter)
                    ├─────────────┤
                    │ Unit Tests  │  ← 80+ tests (per-function)
                    └─────────────┘
```

### Unit Tests (`bun test`)

| Module | Tests | Focus |
|---|---|---|
| `parseDollarToUsdcMicro` | 10 | Edge cases: "$0", "$0.000001", "$1000.50", invalid input |
| `validation.ts` | 15 | UUID, txHash, address, dollar amount validation |
| `AccessTokenIssuer` | 10 | Sign, verify, expired, tampered, wrong secret |
| `buildAgentCard` | 8 | Config → card shape, multiple tiers, network configs |
| `InMemoryChallengeStore` | 12 | CRUD, idempotency, transitions, cleanup |
| `InMemorySeenTxStore` | 6 | markUsed, double-mark, get |
| `AgentGateError` | 5 | Serialization, status codes, details |

### Integration Tests

| Scenario | Description |
|---|---|
| Happy path: request → challenge → proof → grant | Full lifecycle with MockPaymentAdapter |
| Idempotent request-access | Same requestId returns same challenge |
| Expired challenge rejection | submitProof after TTL |
| Chain mismatch rejection | proof.chainId !== challenge.chainId |
| Amount mismatch rejection | proof.amount !== challenge.amount |
| txHash double-spend | Same txHash for two challenges |
| Concurrent submitProof | Two simultaneous proofs for one challenge |
| PROOF_ALREADY_REDEEMED | submitProof on PAID challenge returns grant |
| Resource not found | onVerifyResource returns false |
| Tier not found | Invalid tierId |
| Token validation | validateAccessToken with valid/expired/tampered tokens |
| Agent card generation | Verify card structure matches config |

### E2E Tests (Base Sepolia)

Run against actual testnet. Requires funded wallets (USDC + ETH from faucets). Gated behind `AGENTGATE_E2E=true` env var:

```
TEST 1: Full x402 flow — requestAccess → pay on-chain → submitProof → receive grant
TEST 2: Verify access token works on a mock protected endpoint
TEST 3: Expired challenge (set TTL to 5 seconds, wait, submit)
TEST 4: Double-spend prevention (pay once, submit to two challenges)
TEST 5: Invalid txHash submission
```

### Mock Payment Adapter

```typescript
export class MockPaymentAdapter implements IPaymentAdapter {
  readonly protocol = "mock";
  private verifyResult: VerificationResult;

  constructor(defaultResult?: Partial<VerificationResult>) {
    this.verifyResult = {
      verified: true,
      txHash: "0x" + "a".repeat(64) as `0x${string}`,
      confirmedAmount: 100000n,
      confirmedChainId: 84532,
      confirmedAt: new Date(),
      blockNumber: 1000n,
      ...defaultResult,
    };
  }

  async issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload> {
    return {
      challengeId: crypto.randomUUID(),
      protocol: this.protocol,
      raw: {},
      expiresAt: params.expiresAt,
    };
  }

  async verifyProof(_params: VerifyProofParams): Promise<VerificationResult> {
    return this.verifyResult;
  }

  /** Override the next verify result for testing error paths */
  setVerifyResult(result: Partial<VerificationResult>): void {
    this.verifyResult = { ...this.verifyResult, ...result };
  }
}
```

### CI Test Matrix

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    strategy:
      matrix:
        runtime: [bun, node]
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test

  e2e:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    env:
      AGENTGATE_E2E: "true"
      WALLET_A_KEY: ${{ secrets.TESTNET_WALLET_KEY }}
      WALLET_B_ADDRESS: ${{ secrets.TESTNET_RECEIVER_ADDRESS }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run test:e2e
```

---

## 19. Build, Publish & CI

### Package Publishing

Each package publishes independently to npm under the `@agentgate` scope:

```
@agentgate/types       → types only, zero runtime
@agentgate/core        → challenge engine, token issuer, stores
@agentgate/x402-adapter → x402 on-chain verification
@agentgate/sdk         → framework adapters + middleware
```

### Versioning

**Changesets** manages versioning. All packages follow semver:

- Breaking type changes → major bump on `@agentgate/types` → major bump cascades to dependents
- New features → minor bump
- Bug fixes → patch bump

Pre-1.0: use `0.x.y` where minor = breaking, patch = features/fixes.

### Dual Output

Every package ships ESM + CJS via `tsup`:

```
dist/
├── index.js          # ESM
├── index.cjs         # CJS
├── index.d.ts        # Type declarations
└── index.d.cts       # CJS type declarations
```

Package.json exports:

```json
{
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  }
}
```

---

## 20. Deployment Guide

### Minimum Viable Deployment

```typescript
// server.ts — complete seller setup

import express from "express";
import { agentGateRouter, validateAccessToken } from "@agentgate/sdk/express";
import { X402Adapter } from "@agentgate/x402-adapter";

const app = express();
app.use(express.json());

const adapter = new X402Adapter({
  network: "mainnet",
  rpcUrl: process.env.AGENTGATE_RPC_URL,
});

// Mount AgentGate
app.use(agentGateRouter({
  config: {
    agentName: "My SaaS Agent",
    agentDescription: "Access my SaaS product via agent payments",
    agentUrl: "https://my-saas.com",
    providerName: "My Company",
    providerUrl: "https://my-saas.com",
    walletAddress: process.env.AGENTGATE_WALLET_ADDRESS as `0x${string}`,
    network: "mainnet",
    accessTokenSecret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
    products: [
      {
        tierId: "basic",
        label: "Basic Access",
        amount: "$1.00",
        resourceType: "api-call",
        accessDurationSeconds: 3600,
      },
    ],
    onVerifyResource: async (resourceId) => {
      return true; // Always accessible
    },
    resourceEndpointTemplate: "https://api.my-saas.com/v1/{resourceId}",
  },
  adapter,
}));

// Protect existing API
app.use("/api", validateAccessToken({
  secret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
}));

// Existing API routes
app.get("/api/data/:id", (req, res) => {
  res.json({ data: "..." });
});

app.listen(3000);
```

### Environment Requirements

| Requirement | Details |
|---|---|
| **Runtime** | Bun 1.1+ or Node.js 20+ |
| **Memory** | 128 MB minimum (in-memory store) |
| **Network** | Outbound HTTPS to Base RPC (port 443) |
| **Ports** | One HTTP port (seller chooses) |
| **Secrets** | `AGENTGATE_ACCESS_TOKEN_SECRET` (32+ chars), `AGENTGATE_WALLET_ADDRESS` |

### Docker

```dockerfile
FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
```

### Production Checklist

```
□ Set AGENTGATE_NETWORK=mainnet
□ Set AGENTGATE_WALLET_ADDRESS to a dedicated receive wallet
□ Generate and set AGENTGATE_ACCESS_TOKEN_SECRET (32+ random chars)
□ Set AGENTGATE_RPC_URL to a paid RPC provider (Alchemy, QuickNode)
□ Configure Redis-backed stores for multi-instance deployments
□ Enable HTTPS (TLS termination via reverse proxy)
□ Set up monitoring for on-chain verification latency
□ Fund the receive wallet with a small amount of ETH (for future escrow/refund)
□ Test the full flow on testnet before switching to mainnet
□ Rate-limit the /agent endpoint at the reverse proxy layer
□ Set up log collection for payment events (onPaymentReceived hook)
```

---

## 21. Open Questions Resolution

### OQ-1: Should `requestId` be scoped per `clientAgentId`?

**Resolution: Yes, in v0.2.**

v0.1 treats `requestId` as globally unique. In v0.2, the idempotency key becomes `(requestId, clientAgentId)`. The `IChallengeStore.findActiveByRequestId()` signature changes to `findActive(requestId, clientAgentId)`. This is a breaking change, gated behind a major version bump.

**v0.1 risk**: Two different client agents using the same `requestId` UUID would collide. This is astronomically unlikely with proper UUID generation and acceptable for v0.1.

### OQ-2: Refund SLA for late on-chain payments?

**Resolution: Manual hook in v0.1.**

When `verifyProof` returns `TX_AFTER_EXPIRY`, the error message includes the txHash and the seller's support URL. The `onChallengeExpired` hook fires so sellers can implement automated refund logic if they choose.

v0.2 introduces the escrow pattern (EIP-3009 `transferWithAuthorization`) where expired challenges cost nothing on-chain.

### OQ-3: Shared challenge registry?

**Resolution: Not needed.**

AgentGate is self-hosted. Each seller runs their own instance with their own challenge store. There is no cross-seller challenge lookup. The agent card URL is the discovery mechanism.

### OQ-4: Bind JWT to wallet address?

**Resolution: Include in JWT claims in v0.2.**

v0.1 JWTs do not bind to a wallet address. Token theft between agents is mitigated by the 1-hour TTL. In v0.2, add a `walletAddress` claim and an optional `validateAccessToken` option `requireWalletBinding: true` that checks the request includes a signed message proving ownership of the wallet address.

### OQ-5: Multi-page/paginated resources?

**Resolution: Tier-defined.**

The `accessDurationSeconds` field on `ProductTier` controls session duration. A "single-photo" tier has a short TTL (1 hour). A "full-album" tier has a longer TTL (24 hours). Within the TTL, the access token grants access to the resource identified by `resourceId`. Pagination is the seller's responsibility — if the token is valid and the resource is the same, all pages are accessible.

### OQ-6: Async `onVerifyResource` with timeout?

**Resolution: 5-second timeout, fail-open configurable.**

The `requestAccess` flow wraps `onVerifyResource` in a timeout:

```typescript
const result = await Promise.race([
  config.onVerifyResource(resourceId, tierId),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Resource verification timeout")), 5000)
  ),
]);
```

On timeout, the default behavior is to reject (fail-closed) with:

```json
{ "type": "Error", "code": "INTERNAL_ERROR", "message": "Resource verification timed out" }
```

Sellers can override this with a config option `resourceVerificationFailOpen: true` to issue the challenge even if verification times out (useful for high-availability scenarios where the seller's backend is occasionally slow).

---

## 22. Implementation Order

Strict dependency order. Each phase produces a working, tested artifact.

### Phase 1: Types & Core (Week 1)

```
1.1  @agentgate/types
     - All type definitions
     - AgentGateError class
     - Zero runtime dependencies
     - Ship: type-check passes, types exportable

1.2  @agentgate/core — Storage
     - IChallengeStore, ISeenTxStore interfaces (from types)
     - InMemoryChallengeStore implementation
     - InMemorySeenTxStore implementation
     - Unit tests: 18 tests
     - Ship: stores work in isolation

1.3  @agentgate/core — Token Issuer
     - AccessTokenIssuer (sign + verify)
     - Depends on: jose
     - Unit tests: 10 tests
     - Ship: tokens sign and verify correctly

1.4  @agentgate/core — Challenge Engine
     - ChallengeEngine class
     - Depends on: stores, token issuer, adapter interface
     - Uses MockPaymentAdapter for tests
     - Integration tests: 20 tests (all scenarios from Section 18)
     - Ship: full challenge lifecycle works with mock adapter

1.5  @agentgate/core — Agent Card Builder
     - buildAgentCard() function
     - Unit tests: 8 tests
     - Ship: config → valid agent card JSON
```

### Phase 2: x402 Adapter (Week 2)

```
2.1  @agentgate/x402-adapter — Chain Config
     - CHAIN_CONFIGS constant
     - parseDollarToUsdcMicro()
     - Unit tests: 10 tests

2.2  @agentgate/x402-adapter — Transfer Verification
     - verifyTransfer() function
     - Uses viem's publicClient
     - Unit tests with mocked viem client: 12 tests
     - E2E test on Base Sepolia: 2 tests

2.3  @agentgate/x402-adapter — Adapter Class
     - X402Adapter implementing IPaymentAdapter
     - Integration with ChallengeEngine
     - Full integration test: engine + real adapter + mock store
```

### Phase 3: SDK (Week 3)

```
3.1  @agentgate/sdk — Framework-Agnostic Router
     - AgentGateRouter class
     - A2A request parsing and response formatting
     - Unit tests: 10 tests

3.2  @agentgate/sdk — Express Adapter
     - agentGateRouter() function
     - validateAccessToken() middleware
     - Integration test: full Express server + engine + mock adapter

3.3  @agentgate/sdk — Hono Adapter
     - agentGateApp() function
     - honoValidateAccessToken() middleware
     - Integration test: full Hono server

3.4  @agentgate/sdk — Fastify Adapter
     - Fastify plugin
     - Integration test
```

### Phase 4: Examples & E2E (Week 4)

```
4.1  examples/express-seller
     - Complete working example
     - README with step-by-step setup

4.2  examples/hono-seller
     - Cloudflare Workers deployment example

4.3  examples/client-agent
     - Minimal client showing discovery → request → pay → use

4.4  Full E2E test suite on Base Sepolia
     - 5 E2E tests from Section 18

4.5  Documentation
     - Package READMEs
     - API reference (generated from TSDoc)
     - Migration guide from x402-poc
```

### Phase 5: Production Hardening (Week 5)

```
5.1  Redis storage implementations
     - RedisChallengeStore with Lua scripts
     - RedisSeenTxStore with SET NX
     - Integration tests against real Redis

5.2  CI/CD pipeline
     - GitHub Actions: ci.yml, release.yml, canary.yml
     - Changeset-based versioning
     - npm publish automation

5.3  In-memory store cleanup + size guards

5.4  Config validation (fail-fast at startup)

5.5  Security audit
     - Review all input validation
     - Test replay/double-spend scenarios
     - Test concurrent access patterns
```

---

*End of Technical Implementation Document v1.0*
