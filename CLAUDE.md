# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: AgentGate SDK

Payment-gated A2A (Agent-to-Agent) endpoints using the x402 protocol with USDC on Base. Lets sellers monetize any API: agents request access, pay via on-chain USDC, receive a signed JWT.

Package name: `@riklr/agentgate` (single package, not a monorepo despite README references to packages).

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

```
Client → AccessRequest → X402Challenge (amount, destination, chainId)
Client → PaymentProof (txHash) → AccessGrant (JWT)
Client → Protected API with Bearer JWT
```

### Core Layers

1. **Types** (`src/types/`) — Protocol-agnostic interfaces: `IPaymentAdapter`, `IChallengeStore`, `ISeenTxStore`, plus all message types (`AccessRequest`, `X402Challenge`, `PaymentProof`, `AccessGrant`).

2. **Core** (`src/core/`) — Business logic:
   - `challenge-engine.ts` — State machine (PENDING → PAID/EXPIRED/CANCELLED). Owns the full challenge lifecycle, on-chain verification dispatch, and token issuance.
   - `access-token.ts` — JWT issuance/verification (HS256 or RS256). Supports fallback secrets for zero-downtime rotation.
   - `agent-card.ts` — Auto-generates A2A discovery card from `SellerConfig`.
   - `storage/` — `IChallengeStore` + `ISeenTxStore` with in-memory (default) and Redis (production) implementations. Redis uses atomic Lua scripts for concurrent state transitions.

3. **Adapter** (`src/adapter/`) — `X402Adapter`: verifies ERC-20 Transfer events on Base via viem. Supports `mainnet` (chainId 8453) and `testnet`/Base Sepolia (chainId 84532).

4. **Integrations** (`src/integrations/`) — Framework adapters mount the challenge/proof endpoints and export `validateAccessToken` middleware for protecting routes. Available for Express, Hono, and Fastify.

5. **Executor** (`src/executor.ts`) — `AgentGateExecutor` implements `@a2a-js/sdk`'s `AgentExecutor` for the A2A protocol flow.

6. **Factory** (`src/factory.ts`) — `createAgentGate()` wires everything together and returns `{ requestHandler, agentCard, engine, executor }`.

### Entry Points

- Main: `src/index.ts` — exports all types, core, adapter, helpers, middleware, executor, factory.
- Framework subpaths: `./express`, `./hono`, `./fastify` (see `package.json` exports).

### Storage Abstraction

`IChallengeStore.transition(id, fromState, toState, updates)` is the atomic state transition method — always use this (not direct writes) to prevent race conditions. `ISeenTxStore.markUsed(txHash, challengeId)` is atomic SET NX for double-spend prevention.

### Auth Helpers (`src/helpers/`)

`createSharedSecretAuth`, `createJwtAuth`, `createOAuthAuth` — service-to-service auth strategies for outbound requests from client agents. `RemoteVerifier` and `RemoteTokenIssuer` wrap remote AgentGate endpoints.

## Key Configuration

`SellerConfig` drives everything: `walletAddress`, `network`, `accessTokenSecret`, `products` (array of tiers with `tierId`, `amount`, `accessDurationSeconds`).

Optional callbacks: `onPaymentReceived`, `onIssueToken` (override default JWT generation), `resourceVerifier` (custom access control per request).

## Code Style

- Biome linter: tabs, 100-char lines, double quotes, semicolons always.
- Strict TypeScript: `noUncheckedIndexAccess`, `exactOptionalPropertyTypes` enabled.
- ES modules throughout (`"type": "module"` in package.json).
- Runtime: Bun (tests and examples). Node 18+ also supported for the compiled output.

## Related Documentation

- `SPEC.md` — Requirements and security invariants

## Available Agents

- `@security-reviewer` — Reviews payment-critical files (`challenge-engine.ts`, `verify-transfer.ts`, `storage/`, `access-token.ts`, middleware) against the repo's security invariants (state transition atomicity, double-spend prevention, on-chain verification completeness, JWT security).
- `@test-writer` — Writes Bun tests matching project conventions (`bun:test`, `makeConfig()`/`makeEngine()` factory pattern, injectable clock, `InMemoryChallengeStore({ cleanupIntervalMs: 0 })`, concurrency assertions).

## Agent Invocation Rules

**Always invoke `@security-reviewer` after any edit to payment-critical files** (see agent definition for the full file list). Do not skip this even for small changes.
