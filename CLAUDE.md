# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Key0 SDK

Payment-gated A2A (Agent-to-Agent) endpoints using the x402 protocol with USDC on Base. Lets sellers monetize any API: agents request access, pay via on-chain USDC, and receive either a signed JWT (subscription plans) or a direct API response (per-request plans).

Package name: `@key0ai/key0` (single package, not a monorepo despite README references to packages).

## Commands

```bash
bun install          # Install dependencies
bun test             # Run all tests
bun run typecheck    # Type-check without emitting
bun run lint         # Lint with Biome
bun run build        # Compile TypeScript to ./dist
```

Run a single test file:
```bash
bun test src/core/__tests__/challenge-engine.test.ts
```

Run examples:
```bash
cd examples/express-seller && bun run start
cd examples/client-agent && bun run start
```

## Architecture

### Two-Phase Payment Flow

**Subscription plans** (default `mode: "subscription"`):
```
Client → AccessRequest → X402Challenge (amount, destination, chainId)
Client → PaymentProof (txHash) → AccessGrant (JWT)
Client → Protected API with Bearer JWT
```

**Per-request plans** (`mode: "per-request"`) and **per-request routes** (`routes: [{ routeId, ... }]`):
```
Client → POST /x402/access { planId | routeId, resource: { method, path } } → 402 + PaymentRequirements
Client → POST /x402/access + PAYMENT-SIGNATURE → ResourceResponse (API response proxied inline)
  (standalone gateway) or
Client → GET /api/route + PAYMENT-SIGNATURE → direct 200 response (embedded, no token issued)
```

### Core Layers

1. **Types** (`src/types/`) — Protocol-agnostic interfaces: `IPaymentAdapter`, `IChallengeStore`, `ISeenTxStore`, `IAuditStore`, plus all message types (`AccessRequest`, `X402Challenge`, `PaymentProof`, `AccessGrant`).

2. **Core** (`src/core/`) — Business logic:
   - `challenge-engine.ts` — State machine (PENDING → PAID → DELIVERED | PENDING → EXPIRED | PENDING → CANCELLED | PAID → REFUND_PENDING → REFUNDED | PAID → REFUND_PENDING → REFUND_FAILED | REFUND_FAILED → PAID via `retryFailedRefunds`). Owns the full challenge lifecycle, on-chain verification dispatch, and token issuance. Key methods: `requestAccess` (A2A), `requestHttpAccess` (HTTP x402 PENDING record), `preSettlementCheck` (avoid burning USDC), `processHttpPayment` (PENDING → PAID → DELIVERED for HTTP/MCP flows), `submitProof` (A2A proof verification), `recordPerRequestPayment` (settles a per-request payment — PENDING → PAID without issuing a token), `markDelivered` (transitions PAID → DELIVERED after the backend response is returned to the client).
   - `access-token.ts` — JWT issuance/verification (HS256 or RS256). Supports fallback secrets for zero-downtime rotation.
   - `agent-card.ts` — Auto-generates A2A discovery card from `SellerConfig`.
   - `storage/` — `IChallengeStore` + `ISeenTxStore` + `IAuditStore`. Redis implementations: `RedisChallengeStore`, `RedisSeenTxStore`, `RedisAuditStore`. Postgres implementations: `PostgresChallengeStore`, `PostgresSeenTxStore`, `PostgresAuditStore`. Uses atomic Lua scripts (Redis) for concurrent state transitions. `IChallengeStore` and `ISeenTxStore` are required; `IAuditStore` is optional (audit trail).

3. **Adapter** (`src/adapter/`) — `X402Adapter`: verifies ERC-20 Transfer events on Base via viem. Supports `mainnet` (chainId 8453) and `testnet`/Base Sepolia (chainId 84532).

4. **Integrations** (`src/integrations/`) — Framework adapters mount a unified `POST /x402/access` endpoint (with `X-A2A-Extensions` header routing to A2A JSON-RPC), `GET /discovery` (plan catalog, no PENDING record), and export `validateAccessToken` middleware for protecting routes. Available for Express, Hono, Fastify, and MCP (Streamable HTTP transport via `@modelcontextprotocol/sdk`). Settlement helpers in `settlement.ts`: `buildHttpPaymentRequirements`, `buildDiscoveryResponse`, `decodePaymentSignature`, `settleViaFacilitator`, `settleViaGasWallet`, and the unified `settlePayment` entry point (auto-selects strategy based on config, serialises gas wallet calls via `withGasWalletLock`). Per-request middleware in `pay-per-request.ts`: `key0.payPerRequest(routeId, opts?)` factory for embedded route-level gating (settles inline, calls `next()`, no token issued); `resolveConfigFetchResource(config)` determines whether standalone proxy mode is active. The `routeId` path inside `POST /x402/access` is handled directly in express.ts, hono.ts, and fastify.ts (not via `pay-per-request.ts`) with a full two-phase PENDING → PAID → DELIVERED flow and inline proxy call to `fetchResource`/`proxyTo`. MCP routeId flow uses `engine.recordPerRequestPayment` for double-spend protection and state tracking.

5. **Executor** (`src/executor.ts`) — `Key0Executor` implements `@a2a-js/sdk`'s `AgentExecutor` for the A2A protocol flow.

6. **Factory** (`src/factory.ts`) — `createKey0()` wires everything together and returns `{ requestHandler, agentCard, engine, executor }`.

7. **Utils** (`src/utils/`) — Shared utilities: `gas-wallet-lock.ts` provides distributed locking for gas wallet settlement (Redis-based across replicas, in-process serial queue for single-instance).

### Entry Points

- Main: `src/index.ts` — exports all types, core, adapter, helpers, middleware, executor, factory, and the lightweight `validateKey0Token` validator (`src/validator/index.ts` — for backend services that only need token validation without the full SDK).
- Framework subpaths: `./express`, `./hono`, `./fastify`, `./mcp` (see `package.json` exports).

### Storage Abstraction

`IChallengeStore.transition(id, fromState, toState, updates?, meta?)` is the atomic state transition method — always use this (not direct writes) to prevent race conditions. `meta` carries `{ actor, reason? }` for audit logging. `ISeenTxStore.markUsed(txHash, challengeId)` is atomic SET NX for double-spend prevention. `IAuditStore.append(entry)` is write-only; all state transitions are logged immutably.

### Auth Helpers (`src/helpers/`)

`noAuth`, `sharedSecretAuth`, `signedJwtAuth`, `oauthClientCredentialsAuth` — service-to-service auth strategies for outbound requests from client agents. `noAuth` sends no headers (local dev / trusted networks). `createRemoteTokenIssuer` wraps a remote HTTP endpoint as a `fetchResourceCredentials` callback.

## Key Configuration

`SellerConfig` drives everything: `walletAddress`, `network`, `plans` (array of plans with `planId`, `unitAmount`, optional `description`, optional `mode: "subscription" | "per-request"`, optional `routes: PlanRouteInfo[]`), `basePath` (default `"/agent"` — used for resource endpoint URLs).

Required callback: `fetchResourceCredentials` (issue credential after payment — JWT, API key, etc.). **Not called for per-request plans when `fetchResource`/`proxyTo` is set.** Configurable via `tokenIssueTimeoutMs` (default 15s) and `tokenIssueRetries` (default 2).

Per-request proxy (standalone gateway mode — optional):
- `fetchResource?: (params: FetchResourceParams) => Promise<FetchResourceResult>` — called after settlement for per-request plans; gateway proxies to the backend and returns its response as a `ResourceResponse`. When set, per-request plans work via `/x402/access` (HTTP, A2A, MCP).
- `proxyTo?: ProxyToConfig` — shorthand: auto-builds a `fetchResource` callback that forwards to `baseUrl`. Supports optional `headers` (e.g. shared secret) and `pathRewrite`.

Optional: `version` (default `"1.0.0"`), `facilitatorUrl` (override CDP default), `gasWalletPrivateKey` (self-contained settlement), `redis` (distributed gas wallet lock), `rpcUrl` (override public RPC for all on-chain ops — recommended in production), `onPaymentReceived`, `onChallengeExpired`.

When `mcp: true` is set, the Express router also mounts MCP routes (`/.well-known/mcp.json` discovery + `POST /mcp` Streamable HTTP endpoint) exposing `discover_plans` and `request_access` tools. Payment follows the x402 MCP transport spec (`isError` + `structuredContent` + `_meta`). See `docs/mcp-integration.md`.

## Code Style

- Biome linter: tabs, 100-char lines, double quotes, semicolons always.
- Strict TypeScript: `noUncheckedIndexAccess`, `exactOptionalPropertyTypes` enabled.
- ES modules throughout (`"type": "module"` in package.json).
- Runtime: Bun (tests and examples). Node 18+ also supported for the compiled output.

## Related Documentation

- `SPEC.md` — Requirements and security invariants

## Available Agents

- `@security-reviewer` — Reviews payment-critical files (`challenge-engine.ts`, `verify-transfer.ts`, `storage/`, `access-token.ts`, middleware) against the repo's security invariants (state transition atomicity, double-spend prevention, on-chain verification completeness, JWT security).
- `@test-writer` — Writes Bun tests matching project conventions (`bun:test`, `makeConfig()`/`makeEngine()` factory pattern, injectable clock, `TestChallengeStore` from `test-utils`, concurrency assertions).

## Agent Invocation Rules

**Always invoke `@security-reviewer` after any edit to payment-critical files** (see agent definition for the full file list). Do not skip this even for small changes.
