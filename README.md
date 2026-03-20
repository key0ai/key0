<img src="https://raw.githubusercontent.com/key0ai/key0/main/docs/logo.png" alt="Key0" width="260" />

[![npm version](https://img.shields.io/npm/v/@key0ai/key0)](https://www.npmjs.com/package/@key0ai/key0)
[![Docker](https://img.shields.io/docker/v/key0ai/key0?label=docker)](https://hub.docker.com/r/key0ai/key0)
[![License](https://img.shields.io/github/license/key0ai/key0)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-key0.ai-blue)](https://docs.key0.ai/introduction/overview)

key0 is the open-source commercial gateway for your AI agents and APIs. Let AI agents discover, pay for, and access your APIs autonomously — no human in the loop. It handles payments in USDC on Base via HTTP x402, A2A, and MCP, and generates `llms.txt`, `skills.md`, and related agent-facing surfaces so agents can find and interact with your service out of the box.

For integration, deployment, protocol, and API reference docs, see [docs.key0.ai](https://docs.key0.ai/introduction/overview).

[Docs](https://docs.key0.ai/introduction/overview) · [Standalone Quickstart](https://docs.key0.ai/quickstart/standalone) · [Embedded Quickstart](https://docs.key0.ai/quickstart/embedded) · [Examples](#examples)

## Why key0

- Sell subscription plans or per-request routes to agents.
- Run as embedded middleware or as a standalone Docker gateway.
- Keep your existing API and credential model.
- Generate agent-facing discovery artifacts like `llms.txt` and `skills.md`.
- Support agent-native discovery and access through x402, A2A, MCP, and CLI workflows.
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

That gives agents multiple standard ways to discover and interact with your service out of the box: HTTP x402, A2A, MCP, generated onboarding files, and CLI distribution flows.

After on-chain payment is verified, key0 POSTs to `ISSUE_TOKEN_API`:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "challengeId": "7f3b2c1d-...",
  "resourceId": "basic",
  "planId": "basic",
  "txHash": "0xabc123...",
  "unitAmount": "$0.10"
}
```

`unitAmount` is merged from the matching plan. Any extra fields you add to a plan are included automatically. Return any credential shape — key0 passes the response to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2027-01-01T00:00:00Z" }
```

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

For per-request billing (no JWT, inline settlement per call), use `payPerRequest` middleware:

```ts
const key0 = key0Router({
  config: {
    walletAddress: "0xYourWalletAddress" as `0x${string}`,
    network: "testnet",
    routes: [{ routeId: "weather", method: "GET" as const, path: "/api/weather/:city", unitAmount: "$0.01" }],
  },
  adapter,
  store: new RedisChallengeStore({ redis }),
  seenTxStore: new RedisSeenTxStore({ redis }),
});
app.use(key0);

app.get(
  "/api/weather/:city",
  key0.payPerRequest("weather"),
  (req, res) => {
    const payment = req.key0Payment; // { txHash: "0x...", amount: "$0.01", ... }
    res.json({ city: req.params.city, temp: 72, txHash: payment?.txHash });
  },
);
```

For Hono and Fastify variants, see [Embedded Quickstart](https://docs.key0.ai/quickstart/embedded).

Continue with:

- [Quickstart: Embedded](https://docs.key0.ai/quickstart/embedded)
- [Express integration](https://docs.key0.ai/integrations/express)
- [Hono integration](https://docs.key0.ai/integrations/hono)
- [Fastify integration](https://docs.key0.ai/integrations/fastify)
- [SellerConfig reference](https://docs.key0.ai/sdk-reference/seller-config)

## Settlement

Two strategies for settling USDC payments on-chain:

### Facilitator (default)

Coinbase CDP submits an EIP-3009 `transferWithAuthorization` on your behalf. No ETH required in your wallet.

```bash
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret
```

### Gas Wallet

Self-contained — no external service. The wallet signs and broadcasts the transfer directly. Must hold ETH on Base for gas fees.

```bash
# Standalone (env var)
GAS_WALLET_PRIVATE_KEY=0xYourPrivateKey
```

```ts
// Embedded (SellerConfig)
config: { gasWalletPrivateKey: process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` }
```

See [Environment variables](https://docs.key0.ai/deployment/environment-variables) for the full list of settlement options.

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
- [Agent CLI](https://docs.key0.ai/guides/agent-cli)

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

## Networks

| Network | Chain | Chain ID | USDC Contract |
|---|---|---|---|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Repository Docs

- [`SPEC.md`](./SPEC.md)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`docs/setup-ui.md`](./docs/setup-ui.md)
- [`docs/FLOW.md`](./docs/FLOW.md)
- [`docs/Refund_flow.md`](./docs/Refund_flow.md)
- [`docs/mcp-integration.md`](./docs/mcp-integration.md)
