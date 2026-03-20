<img src="docs/logo.png" alt="Key0" width="260" />

[![npm version](https://img.shields.io/npm/v/@key0ai/key0)](https://www.npmjs.com/package/@key0ai/key0)
[![Docker](https://img.shields.io/docker/v/key0ai/key0?label=docker)](https://hub.docker.com/r/key0ai/key0)
[![License](https://img.shields.io/github/license/key0ai/key0)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-key0.ai-blue)](https://docs.key0.ai/introduction/overview)

key0 is an open-source commerce layer for AI agents and APIs. It lets agents discover pricing, pay in USDC on Base, and access protected services through HTTP x402, A2A, and MCP.

This README is intentionally short. Detailed integration, deployment, protocol, and API reference docs live in Mintlify at [docs.key0.ai](https://docs.key0.ai/introduction/overview).

[Docs](https://docs.key0.ai/introduction/overview) · [Standalone Quickstart](https://docs.key0.ai/quickstart/standalone) · [Embedded Quickstart](https://docs.key0.ai/quickstart/embedded) · [Examples](#examples)

## Why key0

- Sell subscription plans or per-request routes to agents.
- Run as embedded middleware or as a standalone Docker gateway.
- Keep your existing API and credential model.
- Support agent-native discovery through x402, A2A, and MCP.
- Refund automatically when payment succeeds but delivery fails.

## Choose a Mode

> **Recommended for most teams:** Start with **Standalone Docker**. It is the fastest way to expose a paid agent-facing gateway without changing your application code.

| | Standalone Docker | Embedded SDK |
|---|---|---|
| Best for | Teams that want a gateway with minimal app changes | Existing apps that want full control in code |
| Install | `docker compose -f docker/docker-compose.yml --profile full up` | `bun add @key0ai/key0` |
| Config | Setup UI or environment variables | `SellerConfig` in TypeScript |
| Subscription flow | `ISSUE_TOKEN_API` returns the credential | `fetchResourceCredentials` callback returns the credential |
| Per-request flow | Proxy mode through `PROXY_TO_BASE_URL` | Route-level middleware inside your app |
| Docs | [Standalone](https://docs.key0.ai/quickstart/standalone) | [Embedded](https://docs.key0.ai/quickstart/embedded) |

For a full comparison, see [Two Modes](https://docs.key0.ai/introduction/two-modes).

## Quick Start

Use `network: "testnet"` for local development and switch to `mainnet` only when you are ready to accept real payments.

### Standalone Docker

```bash
docker compose -f docker/docker-compose.yml --profile full up
# Open http://localhost:3000
```

Standalone mode exposes the payment endpoints and generates the buyer onboarding bundle from your config, including `GET /discover`, `POST /x402/access`, optional `/.well-known/agent.json`, optional `/.well-known/mcp.json`, `/llms.txt`, and `/skills.md`.

Continue with:

- [Quickstart: Standalone](https://docs.key0.ai/quickstart/standalone)
- [Docker deployment](https://docs.key0.ai/deployment/docker)
- [Environment variables](https://docs.key0.ai/deployment/environment-variables)
- [Refund architecture](https://docs.key0.ai/architecture/refunds)

### Embedded SDK

```bash
bun add @key0ai/key0 ioredis
```

```ts
import express from "express";
import { key0Router, validateAccessToken } from "@key0ai/key0/express";
import {
  AccessTokenIssuer,
  RedisChallengeStore,
  RedisSeenTxStore,
  X402Adapter,
} from "@key0ai/key0";
import Redis from "ioredis";

const app = express();
app.use(express.json());

const adapter = new X402Adapter({ network: "testnet" });
const redis = new Redis(process.env.REDIS_URL!);
const tokenIssuer = new AccessTokenIssuer(process.env.ACCESS_TOKEN_SECRET!);

app.use(
  key0Router({
    config: {
      walletAddress: "0xYourWalletAddress" as `0x${string}`,
      network: "testnet",
      plans: [{ planId: "basic", unitAmount: "$0.10" }],
      fetchResourceCredentials: async (params) =>
        tokenIssuer.sign(
          { sub: params.requestId, jti: params.challengeId, planId: params.planId },
          3600,
        ),
    },
    adapter,
    store: new RedisChallengeStore({ redis }),
    seenTxStore: new RedisSeenTxStore({ redis }),
  }),
);

app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
```

Continue with:

- [Quickstart: Embedded](https://docs.key0.ai/quickstart/embedded)
- [Express integration](https://docs.key0.ai/integrations/express)
- [Hono integration](https://docs.key0.ai/integrations/hono)
- [Fastify integration](https://docs.key0.ai/integrations/fastify)
- [SellerConfig reference](https://docs.key0.ai/sdk-reference/seller-config)

## How It Works

1. The agent discovers your service and pricing through `GET /discover`, A2A, or MCP.
2. key0 returns a payment challenge and verifies the USDC payment on Base.
3. On success, key0 either returns a credential for subscription access or serves the paid route response for per-request access.
4. If delivery fails after payment, key0 can refund the payer on-chain.

Protocol details:

- [HTTP x402 flow](https://docs.key0.ai/protocol/x402-http-flow)
- [A2A flow](https://docs.key0.ai/protocol/a2a-flow)
- [MCP protocol](https://docs.key0.ai/protocol/mcp)
- [Core concepts](https://docs.key0.ai/introduction/core-concepts)

## What To Read Next

- Getting started: [Overview](https://docs.key0.ai/introduction/overview), [Core Concepts](https://docs.key0.ai/introduction/core-concepts), [Two Modes](https://docs.key0.ai/introduction/two-modes)
- Architecture: [Payment Flow](https://docs.key0.ai/architecture/payment-flow), [State Machine](https://docs.key0.ai/architecture/state-machine), [Storage](https://docs.key0.ai/architecture/storage), [Token Issuance](https://docs.key0.ai/architecture/token-issuance), [Refunds](https://docs.key0.ai/architecture/refunds)
- Guides: [Building a Seller](https://docs.key0.ai/guides/building-a-seller), [Agent CLI](https://docs.key0.ai/guides/agent-cli), [Claude Code Integration](https://docs.key0.ai/guides/claude-code-integration)
- SDK reference: [Overview](https://docs.key0.ai/sdk-reference/overview), [SellerConfig](https://docs.key0.ai/sdk-reference/seller-config), [Middleware](https://docs.key0.ai/sdk-reference/middleware), [Auth Helpers](https://docs.key0.ai/sdk-reference/auth-helpers), [Storage](https://docs.key0.ai/sdk-reference/storage), [Error Codes](https://docs.key0.ai/sdk-reference/error-codes)
- API reference: [Overview](https://docs.key0.ai/api-reference/overview), [Agent Card](https://docs.key0.ai/api-reference/agent-card), [x402 Access](https://docs.key0.ai/api-reference/x402-access), [MCP Tools](https://docs.key0.ai/api-reference/mcp-tools), [Data Models](https://docs.key0.ai/api-reference/data-models)
- Examples docs: [Express Seller](https://docs.key0.ai/examples/express-seller), [Hono Seller](https://docs.key0.ai/examples/hono-seller), [Standalone Service](https://docs.key0.ai/examples/standalone-service), [Backend Integration](https://docs.key0.ai/examples/backend-integration), [Embedded Pay-Per-Request](https://docs.key0.ai/examples/ppr-embedded), [Standalone Pay-Per-Request](https://docs.key0.ai/examples/ppr-standalone)

## Examples

Local example projects:

- [`examples/express-seller`](./examples/express-seller)
- [`examples/hono-seller`](./examples/hono-seller)
- [`examples/standalone-service`](./examples/standalone-service)
- [`examples/backend-integration`](./examples/backend-integration)
- [`examples/refund-cron-example`](./examples/refund-cron-example)
- [`examples/ppr-embedded`](./examples/ppr-embedded)
- [`examples/ppr-standalone`](./examples/ppr-standalone)
- [`examples/client-agent`](./examples/client-agent)
- [`examples/simple-x402-client.ts`](./examples/simple-x402-client.ts)

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test src/
bun run build
```

E2E setup and wallet funding notes live in [`e2e/README.md`](./e2e/README.md).

## Repository Docs

- [`SPEC.md`](./SPEC.md)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`docs/setup-ui.md`](./docs/setup-ui.md)
- [`docs/FLOW.md`](./docs/FLOW.md)
- [`docs/Refund_flow.md`](./docs/Refund_flow.md)
- [`docs/mcp-integration.md`](./docs/mcp-integration.md)
