<img src="docs/logo.png" alt="Key0" width="260" />

[![npm version](https://img.shields.io/npm/v/@key0ai/key0)](https://www.npmjs.com/package/@key0ai/key0)
[![Docker](https://img.shields.io/docker/v/key0ai/key0?label=docker)](https://hub.docker.com/r/key0ai/key0)
[![License](https://img.shields.io/github/license/key0ai/key0)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-key0.ai-blue)](https://docs.key0.ai/introduction/overview)

Commerce infrastructure for the agentic web. Let AI agents discover,
pay for, and access your APIs autonomously — no human in the loop.

[Docs](https://docs.key0.ai/introduction/overview) · [Quick Start](#quick-start) · [Book a Demo](https://key0.ai/book-a-demo)

---

- **Zero proxying** — requests go directly to your server, no latency overhead
- **Open-source & self-hostable** — every part of the commerce flow is auditable
- **Automatic refunds** — if anything goes wrong on-chain, Key0 handles it

**Agent environments:** Claude Code, OpenClaw, Cursor, and more
**Protocols:** HTTP x402, MCP, A2A
**Payments:** Base (USDC) · Visa, Mastercard, UPI coming soon

---

## What is Key0

Key0 is an open-source commerce layer for API sellers and agent builders.
Sellers add Key0 to any existing API — via Docker or SDK — to make it
discoverable and purchasable by AI agents. Agents pay with USDC on Base;
Key0 handles verification, credential issuance, and automatic refunds if
anything fails.

---

## Quick Start

| | [Standalone (Docker)](#standalone-mode) | [Embedded (SDK)](#embedded-mode) |
|---|---|---|
| **Setup** | `docker compose up` → browser Setup UI | `bun add @key0ai/key0` |
| **Config** | Setup UI or environment variables | TypeScript config |
| **Token issuance** | Delegated to your `ISSUE_TOKEN_API` | Your `fetchResourceCredentials` callback |
| **Best for** | Quick deploy, no code changes | Full control, existing app |

### Standalone — 30 seconds

```bash
docker compose -f docker/docker-compose.yml --profile full up
# Open http://localhost:3000 → configure via browser
```

### Embedded — Express

```bash
bun add @key0ai/key0
```

```typescript
import { key0Router, validateAccessToken } from "@key0ai/key0/express";

app.use(key0Router({
  config: {
    walletAddress: "0xYour...",
    network: "testnet",
    plans: [{ planId: "basic", unitAmount: "$0.10" }],
    fetchResourceCredentials: async (params) => tokenIssuer.sign(params),
  },
  adapter, store, seenTxStore,
}));
app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
```

`adapter`, `store`, and `seenTxStore` are constructed in the [Embedded Mode](#embedded-mode) section.

---

## How It Works

Key0 sits between your server and any agent client. It handles the commerce
handshake — discovery, challenge, on-chain verification, credential issuance
— then gets out of the way. Your protected routes receive normal Bearer token
requests.

Two flows are supported. Both follow the same `PENDING → PAID → DELIVERED`
lifecycle and are eligible for automatic refunds.

### A2A Flow (Agent-to-Agent)

```
Client Agent          Key0                    Seller Server
     │  1. GET /.well-known/agent.json             │
     │ ──────────────────▶│                         │
     │ ◀── agent card + pricing                    │
     │                   │                         │
     │  2. AccessRequest │                         │
     │ ──────────────────▶│                         │
     │ ◀── X402Challenge  │                         │
     │                   │                         │
     │  3. Pay USDC on Base (on-chain)             │
     │                   │                         │
     │  4. PaymentProof  │                         │
     │ ──────────────────▶│                         │
     │                   │── verify on-chain        │
     │                   │── fetchResourceCredentials ──▶│
     │                   │◀── token                │
     │ ◀── AccessGrant   │                         │
     │                   │                         │
     │  5. Bearer <JWT>  │                         │
     │ ──────────────────────────────────────────▶│
     │ ◀── protected content                       │
```

### HTTP x402 Flow (Gas Wallet / Facilitator)

```
Client                Key0                    Seller Server
     │  1. GET /discovery │                         │
     │ ──────────────────▶│                         │
     │ ◀── plan catalog   │                         │
     │                   │                         │
     │  2. POST /x402/access { planId }            │
     │ ──────────────────▶│                         │
     │ ◀── HTTP 402       │                         │
     │                   │                         │
     │  3. POST + PAYMENT-SIGNATURE                │
     │ ──────────────────▶│                         │
     │                   │── settle on-chain        │
     │                   │── fetchResourceCredentials ──▶│
     │ ◀── AccessGrant   │                         │
     │                   │                         │
     │  4. Bearer <JWT>  │                         │
     │ ──────────────────────────────────────────▶│
     │ ◀── protected content                       │
```

---

## Standalone Mode

Run Key0 as a Docker container alongside your existing backend. No code changes required.

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│ Client Agent │     │    Key0 (Docker)      │     │  Your Backend    │
│              │────▶│  payment handshake    │     │                  │
│              │◀────│  agent card + pricing │     │                  │
│              │     │                       │     │                  │
│              │     │  verify on-chain      │     │                  │
│              │     │  POST /issue-token ───│────▶│  issue-token     │
│              │◀────│  AccessGrant          │◀────│  {token, ...}    │
└──────────────┘     └──────────────────────┘     └──────────────────┘
```

### Setup

There are two ways to configure Standalone mode:

#### Option A: Setup UI (zero-config start)

Just start the container with no environment variables — Key0 boots into **Setup Mode** and serves a browser-based configuration wizard:

```bash
docker compose -f docker/docker-compose.yml --profile full up
# Open http://localhost:3000 → redirects to /setup
# Managed infra (Redis, Postgres) is auto-detected at startup — no extra env vars needed.
```

Docker Compose profiles control which infrastructure services are bundled:

| Profile | What starts |
|---|---|
| *(none)* | Key0 only — bring your own Redis + Postgres via env vars |
| `--profile redis` | Key0 + managed Redis |
| `--profile postgres` | Key0 + managed Postgres (still needs Redis externally) |
| `--profile full` | Key0 + managed Redis + managed Postgres (batteries included) |

The Setup UI lets you configure everything visually: wallet address, network, pricing plans, token issuance API, settlement, and refund settings. When you submit, the server writes the config and restarts automatically.

Configuration is persisted in a Docker volume (`key0-config`), so it survives `docker compose down` / `up` cycles.

The Setup UI also works as a **standalone config generator** — open it outside Docker to generate `.env` files, `docker run` commands, or `docker-compose.yml` files you can copy. See [`docs/setup-ui.md`](./docs/setup-ui.md) for architecture details.

#### Option B: Environment variables

Set the two required variables and start immediately:

| Variable | Description |
|---|---|
| `KEY0_WALLET_ADDRESS` | USDC-receiving wallet (`0x...`) |
| `ISSUE_TOKEN_API` | URL that Key0 POSTs to after payment is verified |

```bash
docker run \
  -e KEY0_WALLET_ADDRESS=0xYourWallet \
  -e ISSUE_TOKEN_API=https://api.example.com/issue-token \
  -p 3000:3000 \
  key0ai/key0:latest
```

### With Docker Compose + Redis

```bash
cp docker/.env.example docker/.env
# Edit docker/.env: set KEY0_WALLET_ADDRESS and ISSUE_TOKEN_API
docker compose -f docker/docker-compose.yml --profile redis up
```

> Even with env vars pre-configured, the Setup UI is always available at `/setup` for reconfiguration.

### Docker Image

Published to Docker Hub on every release: [`key0ai/key0`](https://hub.docker.com/r/key0ai/key0)

| Tag | When |
|---|---|
| `latest` | Latest stable release |
| `1.2.3` / `1.2` / `1` | Specific version pinning |
| `canary` | Latest `main` branch build |

Build from source: `docker build -t key0ai/key0 .`

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `KEY0_WALLET_ADDRESS` | ✅ | — | Your wallet address (`0x…`) that receives USDC payments from agents |
| `ISSUE_TOKEN_API` | ✅ | — | Your endpoint that Key0 POSTs to after payment is verified to issue access tokens |
| `KEY0_NETWORK` | | `testnet` | Blockchain network — `mainnet` for Base, `testnet` for Base Sepolia |
| `PORT` | | `3000` | Port the HTTP server listens on |
| `AGENT_NAME` | | `Key0 Server` | Name of your agent as shown in `/.well-known/agent.json` |
| `AGENT_DESCRIPTION` | | `Payment-gated A2A endpoint` | Short description of your agent shown in the agent card |
| `AGENT_URL` | | `http://localhost:PORT` | Publicly reachable URL of this server — used in the agent card and resource endpoint URLs |
| `PROVIDER_NAME` | | `Key0` | Your organization name shown in the agent card `provider` field |
| `PROVIDER_URL` | | `https://key0.ai` | Your organization URL shown in the agent card `provider` field |
| `PLANS` | | `[{"planId":"basic","unitAmount":"$0.10"}]` | JSON array of pricing plans — each with `planId`, `unitAmount`, and optional `description` |
| `CHALLENGE_TTL_SECONDS` | | `900` | How long a payment challenge remains valid before expiring (seconds) |
| `BASE_PATH` | | — | URL path prefix for endpoints (e.g. `/a2a` mounts `/a2a/.well-known/agent.json`). The `/x402/access` endpoint is always at the root. |
| `BACKEND_AUTH_STRATEGY` | | `none` | How Key0 authenticates with `ISSUE_TOKEN_API` — `none`, `shared-secret`, or `jwt` |
| `ISSUE_TOKEN_API_SECRET` | | — | Secret for `ISSUE_TOKEN_API` auth — Bearer token (shared-secret) or JWT signing key (jwt). Only used when `BACKEND_AUTH_STRATEGY` is not `none` |
| `MCP_ENABLED` | | `false` | When `true`, mounts MCP routes (`/.well-known/mcp.json` + `POST /mcp`) exposing `discover_plans` and `request_access` tools |
| `STORAGE_BACKEND` | | `redis` | Storage backend — `redis` or `postgres` |
| `DATABASE_URL` | | — | PostgreSQL connection URL — required when `STORAGE_BACKEND=postgres` |
| `REDIS_URL` | ✅ | — | Redis connection URL — required for challenge state (or BullMQ refund cron when using Postgres) |
| `KEY0_MANAGED_INFRA` | | — | Optional comma-separated list of compose-managed infra (e.g. `redis,postgres`). Auto-detected at startup via DNS; only needed as an explicit override |
| `GAS_WALLET_PRIVATE_KEY` | | — | Private key of a wallet holding ETH on Base — enables self-contained settlement without a CDP facilitator |
| `KEY0_WALLET_PRIVATE_KEY` | | — | Private key of `KEY0_WALLET_ADDRESS` — required for the refund cron to send USDC back to payers |
| `REFUND_INTERVAL_MS` | | `60000` | How often the refund cron runs (ms) — only active when `KEY0_WALLET_PRIVATE_KEY` is set |
| `REFUND_MIN_AGE_MS` | | `300000` | Minimum age (ms) a stuck `PAID` record must reach before the refund cron picks it up |
| `REFUND_BATCH_SIZE` | | `50` | Max number of `PAID` records processed per refund cron tick |
| `TOKEN_ISSUE_TIMEOUT_MS` | | `15000` | Timeout (ms) for each `ISSUE_TOKEN_API` call |
| `TOKEN_ISSUE_RETRIES` | | `2` | Number of retries for transient `ISSUE_TOKEN_API` failures (does not retry on deterministic errors) |


See [`docker/.env.example`](docker/.env.example) for a fully annotated example.

### ISSUE_TOKEN_API Contract

After on-chain payment is verified, Key0 POSTs to `ISSUE_TOKEN_API` with the payment context merged with the matching plan:

```json
{
  "requestId": "uuid",
  "challengeId": "uuid",
  "resourceId": "photo-42",
  "planId": "basic",
  "txHash": "0x...",
  "unitAmount": "$0.10"
}
```

Any extra fields you add to your `PLANS` plans are included automatically.

Your endpoint can return any credential shape — the response is passed through to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2025-01-01T00:00:00Z", "tokenType": "Bearer" }
```

```json
{ "apiKey": "sk-123", "apiSecret": "secret", "expiresAt": "..." }
```

If the response has a `token` string field it is used directly. Otherwise the full response body is JSON-serialized into `token` with `tokenType: "custom"`, so the client can parse it.

### Automatic Refunds (Standalone)

When `KEY0_WALLET_PRIVATE_KEY` is set, the Docker server runs a BullMQ refund cron automatically — no extra setup needed. It scans for `PAID` challenges that were never delivered (e.g. because `ISSUE_TOKEN_API` returned an error) and sends USDC back to the payer.

```
┌──────────────┐   ┌───────────────────────────┐   ┌──────────────────┐
│ Client Agent │   │    Key0 (Docker)     │   │   Blockchain     │
│              │   │                           │   │                  │
│  pays USDC   │──▶│  verify on-chain          │──▶│                  │
│              │   │  PENDING ──────────────▶ PAID │◀─ Transfer event │
│              │   │                           │   │                  │
│              │   │  POST ISSUE_TOKEN_API ────│──▶│  500 / timeout   │
│              │◀──│  (token issuance fails)   │   │                  │
│              │   │  record stays PAID        │   │                  │
│              │   │                           │   │                  │
│              │   │  ┌─ BullMQ cron (Redis) ─┐│   │                  │
│              │   │  │ every REFUND_INTERVAL  ││   │                  │
│              │   │  │ findPendingForRefund() ││   │                  │
│              │   │  │ PAID → REFUND_PENDING  ││   │                  │
│              │   │  │ sendUsdc() ────────────┼┼──▶│  USDC transfer   │
│  [refunded]  │   │  │ REFUND_PENDING→REFUNDED││◀──│  txHash          │
│              │   │  └───────────────────────┘│   │                  │
└──────────────┘   └───────────────────────────┘   └──────────────────┘
```

```bash
# docker/.env — add to enable refunds
KEY0_WALLET_PRIVATE_KEY=0xYourWalletPrivateKeyHere
REFUND_INTERVAL_MS=60000   # scan every 60s
REFUND_MIN_AGE_MS=300000   # refund after 5-min grace period
```

> Redis is required for refund cron when running multiple replicas — BullMQ ensures only one worker broadcasts each refund transaction.

---

## Embedded Mode

Install the SDK and mount Key0 as middleware inside your existing application. You keep full control over token issuance, routing, and resource verification.

```
┌──────────────┐        ┌──────────────────────────────────────────────────┐
│ Client Agent │        │                 Your Application                  │
│              │        │  ┌────────────────────────────────────────────┐  │
│  discover    │───────▶│  │           Key0 Middleware              │  │
│              │◀───────│  │  /.well-known/agent.json  (auto-generated)  │  │
│              │        │  │  /x402/access  (x402 payment + settlement)  │  │
│  request     │───────▶│  │  [store: PENDING]                          │  │
│              │◀───────│  │  402 + payment terms                        │  │
│  [pays USDC on Base]  │  │                                             │  │
│  retry +sig  │───────▶│  │  settle on-chain                           │  │
│              │        │  │  [PENDING → PAID]                          │  │
│              │        │  │  fetchResourceCredentials()      ──▶  your JWT/key gen  │  │
│              │        │  │  [PAID → DELIVERED]                        │  │
│              │◀───────│  │  AccessGrant (JWT or custom credential)     │  │
│              │        │  └────────────────────────────────────────────┘  │
│  /api/res    │───────▶│                                                   │
│  Bearer: JWT │        │  Protected Routes  (validateAccessToken)          │
│              │◀───────│  premium content                                  │
└──────────────┘        └──────────────────────────────────────────────────┘
```

### Install

```bash
bun add @key0ai/key0
```

Optional peer dependencies:
```bash
bun add ioredis   # Redis-backed storage for multi-process deployments
```

### Express

```typescript
import express from "express";
import { key0Router, validateAccessToken } from "@key0ai/key0/express";
import { X402Adapter, AccessTokenIssuer, RedisChallengeStore, RedisSeenTxStore } from "@key0ai/key0";
import Redis from "ioredis";

const app = express();
app.use(express.json());

const adapter = new X402Adapter({ network: "testnet" });
const tokenIssuer = new AccessTokenIssuer(process.env.ACCESS_TOKEN_SECRET!);

const redis = new Redis(process.env.REDIS_URL!);
const store = new RedisChallengeStore({ redis });
const seenTxStore = new RedisSeenTxStore({ redis });

app.use(
  key0Router({
    config: {
      agentName: "My Agent",
      agentDescription: "A payment-gated API",
      agentUrl: "https://my-agent.example.com",
      providerName: "My Company",
      providerUrl: "https://example.com",
      walletAddress: "0xYourWalletAddress" as `0x${string}`,
      network: "testnet",
      plans: [
        { planId: "basic", unitAmount: "$0.10", description: "Basic API access." },
      ],
      fetchResourceCredentials: async (params) => {
        return tokenIssuer.sign(
          { sub: params.requestId, jti: params.challengeId, resourceId: params.resourceId },
          3600,
        );
      },
    },
    adapter,
    store,
    seenTxStore,
  })
);

// Protect existing routes
app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
app.get("/api/data/:id", (req, res) => res.json({ data: "premium content" }));

app.listen(3000);
```

### Hono

```typescript
import { Hono } from "hono";
import { key0App, honoValidateAccessToken } from "@key0ai/key0/hono";
import { X402Adapter, RedisChallengeStore, RedisSeenTxStore } from "@key0ai/key0";
import Redis from "ioredis";

const adapter = new X402Adapter({ network: "testnet" });
const redis = new Redis(process.env.REDIS_URL!);
const gate = key0App({
  config: { /* same config */ },
  adapter,
  store: new RedisChallengeStore({ redis }),
  seenTxStore: new RedisSeenTxStore({ redis }),
});

const app = new Hono();
app.route("/", gate);

const api = new Hono();
api.use("/*", honoValidateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
api.get("/data/:id", (c) => c.json({ data: "premium content" }));
app.route("/api", api);

export default { port: 3000, fetch: app.fetch };
```

### Fastify

```typescript
import Fastify from "fastify";
import { key0Plugin, fastifyValidateAccessToken } from "@key0ai/key0/fastify";
import { X402Adapter, RedisChallengeStore, RedisSeenTxStore } from "@key0ai/key0";
import Redis from "ioredis";

const fastify = Fastify();
const adapter = new X402Adapter({ network: "testnet" });
const redis = new Redis(process.env.REDIS_URL!);

await fastify.register(key0Plugin, {
  config: { /* same config */ },
  adapter,
  store: new RedisChallengeStore({ redis }),
  seenTxStore: new RedisSeenTxStore({ redis }),
});
fastify.addHook("onRequest", fastifyValidateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));

fastify.listen({ port: 3000 });
```

### Configuration Reference

#### SellerConfig

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `agentName` | `string` | ✅ | — | Display name in agent card |
| `agentDescription` | `string` | ✅ | — | Agent card description |
| `agentUrl` | `string` | ✅ | — | Public URL of your server |
| `providerName` | `string` | ✅ | — | Your company/org name |
| `providerUrl` | `string` | ✅ | — | Your company/org URL |
| `walletAddress` | `0x${string}` | ✅ | — | USDC-receiving wallet |
| `network` | `"testnet" \| "mainnet"` | ✅ | — | Base Sepolia or Base |
| `plans` | `Plan[]` | ✅ | — | Pricing plans |
| `fetchResourceCredentials` | `(params) => Promise<TokenIssuanceResult>` | ✅ | — | Issue the credential after payment |
| `tokenIssueTimeoutMs` | `number` | | `15000` | Timeout for `fetchResourceCredentials` callback (ms) |
| `tokenIssueRetries` | `number` | | `2` | Max retries for `fetchResourceCredentials` on transient failure |
| `challengeTTLSeconds` | `number` | | `900` | Challenge validity window |
| `version` | `string` | | `"1.0.0"` | Agent version shown in agent card and MCP discovery |
| `basePath` | `string` | | `"/agent"` | Path prefix for resource endpoint URLs |
| `resourceEndpointTemplate` | `string` | | auto | URL template (use `{resourceId}`) |
| `gasWalletPrivateKey` | `0x${string}` | | — | Private key for self-contained settlement |
| `redis` | `IRedisLockClient` | | — | Redis client for distributed gas wallet settlement locking across replicas |
| `facilitatorUrl` | `string` | | CDP default | Override the x402 facilitator URL |
| `onPaymentReceived` | `(grant) => Promise<void>` | | — | Fired after successful payment |
| `onChallengeExpired` | `(challengeId) => Promise<void>` | | — | Fired when a challenge expires |
| `mcp` | `boolean` | | `false` | Enable MCP server — mounts `/.well-known/mcp.json` and `POST /mcp` (Streamable HTTP) |

#### Plan

| Field | Type | Required | Description |
|---|---|---|---|
| `planId` | `string` | ✅ | Unique plan identifier |
| `unitAmount` | `string` | ✅ | Price (e.g. `"$0.10"`) |
| `description` | `string` | | Free-form description of what the plan includes |

#### IssueTokenParams

| Field | Type | Description |
|---|---|---|
| `challengeId` | `string` | Use as JWT `jti` for replay prevention |
| `requestId` | `string` | Use as JWT `sub` |
| `resourceId` | `string` | Purchased resource |
| `planId` | `string` | Purchased plan |
| `txHash` | `0x${string}` | On-chain transaction hash |

### Refund Cron (Embedded)

When `fetchResourceCredentials` throws or the server crashes after payment but before delivery, the `ChallengeRecord` stays in `PAID` state. Wire up `processRefunds` on a schedule to detect these and send USDC back to the payer.

```
┌──────────────┐   ┌──────────────────────────────────────────────────┐   ┌──────────┐
│ Client Agent │   │                 Your Application                  │   │Blockchain│
│              │   │  ┌────────────────────────────────────────────┐  │   │          │
│  pays USDC   │──▶│  │  Key0 Middleware                       │  │──▶│          │
│              │   │  │  verify on-chain                            │  │◀──│          │
│              │   │  │  PENDING ──────────────────────────▶ PAID   │  │   │          │
│              │   │  │  fetchResourceCredentials() throws                      │  │   │          │
│              │◀──│  │  record stays PAID                          │  │   │          │
│              │   │  └────────────────────────────────────────────┘  │   │          │
│              │   │                                                   │   │          │
│              │   │  ┌─ Your refund cron (BullMQ / setInterval) ───┐  │   │          │
│              │   │  │ processRefunds({ store, walletPrivateKey })  │  │   │          │
│              │   │  │ PAID → REFUND_PENDING                        │  │   │          │
│              │   │  │ sendUsdc() ─────────────────────────────────┼──┼──▶│ USDC tx  │
│  [refunded]  │   │  │ REFUND_PENDING → REFUNDED                   │  │◀──│ txHash   │
│              │   │  └─────────────────────────────────────────────┘  │   │          │
└──────────────┘   └──────────────────────────────────────────────────┘   └──────────┘
```

```typescript
import { Queue, Worker } from "bullmq";
import { processRefunds } from "@key0ai/key0";

// Uses the same `store` passed to key0Router
const worker = new Worker("refund-cron", async () => {
  const results = await processRefunds({
    store,
    walletPrivateKey: process.env.KEY0_WALLET_PRIVATE_KEY as `0x${string}`,
    network: "testnet",
    minAgeMs: 5 * 60 * 1000, // 5-min grace period
  });

  for (const r of results) {
    if (r.success) console.log(`Refunded ${r.amount} → ${r.toAddress}  tx=${r.refundTxHash}`);
    else console.error(`Refund failed ${r.challengeId}: ${r.error}`);
  }
}, { connection: redis });

const queue = new Queue("refund-cron", { connection: redis });
await queue.add("process", {}, { repeat: { every: 60_000 } });
```

> The `walletPrivateKey` must correspond to `walletAddress` — the wallet that received the USDC payments.
> Without Redis, a plain `setInterval` works for single-instance deployments (the atomic `PAID → REFUND_PENDING` CAS transition prevents double-refunds even with multiple overlapping ticks).

**Retrying failed refunds:**

If a refund fails (e.g. network error), the record moves to `REFUND_FAILED`. Use `retryFailedRefunds` to re-queue them:

```typescript
import { retryFailedRefunds } from "@key0ai/key0";

// Re-queue specific failed refunds — they'll be picked up by the next processRefunds run
const requeued = await retryFailedRefunds(store, ["challengeId-1", "challengeId-2"]);
```

### Environment Variables

```bash
KEY0_NETWORK=testnet                          # "testnet" or "mainnet"
KEY0_WALLET_ADDRESS=0xYourWalletAddress        # Receive-only wallet (no private key needed)
ACCESS_TOKEN_SECRET=your-secret-min-32-chars        # JWT signing secret for AccessTokenIssuer
PORT=3000                                           # Server port

# Required for x402 HTTP flow with CDP facilitator (alternative to gas wallet)
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret

# Optional: self-contained settlement without a facilitator
GAS_WALLET_PRIVATE_KEY=0xYourPrivateKey
```

## Clients

Any agent that can hold a wallet and sign an on-chain USDC transfer can access Key0-gated APIs autonomously — no human in the loop, no pre-registration, no manual API key management. Payment is the credential.

### Coding Agents (e.g. Claude Code)

Coding agents like [Claude Code](https://claude.ai/code) can discover an Key0 endpoint, pay for access, and receive API keys or tokens entirely on their own using an MCP wallet tool. The [Coinbase payments MCP](https://github.com/coinbase/payments-mcp) gives Claude a client-side wallet it can use to sign and broadcast USDC transfers directly:

```
1. Agent reads /.well-known/agent.json → discovers pricing and wallet address
2. Agent calls payments-mcp to sign a USDC authorization (EIP-3009)
3. Agent sends the signed authorization → Key0 settles on-chain and returns an AccessGrant with the token/API key
4. Agent uses the token to call the protected resource
```

No configuration or human approval required — the agent handles the full payment flow end-to-end.

### MCP (Model Context Protocol)

Set `mcp: true` in your config to expose Key0 as an MCP server. MCP clients like Claude Desktop, Cursor, and Claude Code can discover and call your tools directly.

```typescript
app.use(
  key0Router({
    config: {
      // ...existing config
      mcp: true, // enables MCP routes
    },
    adapter, store, seenTxStore,
  })
);
```

This adds:
- `GET /.well-known/mcp.json` — MCP discovery document
- `POST /mcp` — Streamable HTTP transport endpoint

**Two tools are exposed:**
- `discover_plans` — returns the plan catalog (plans, pricing, wallet, chainId)
- `request_access` — x402 payment-gated tool: call to get payment requirements, then use `payments-mcp` to complete payment via the HTTPS x402 endpoint. Includes pre-settlement resource verification, Zod payload validation, and deterministic request IDs for idempotent retry recovery

**Connect from Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "my-seller": {
      "type": "http",
      "url": "https://my-agent.example.com/mcp"
    }
  }
}
```

See [`docs/mcp-integration.md`](./docs/mcp-integration.md) for architecture details and transport rationale.

### Autonomous Agents (e.g. OpenClaw)

Headless autonomous agents can do the same. Any agent runtime that supports wallet signing (via an embedded wallet, a KMS-backed key, or an MCP-compatible tool) can interact with Key0 without modification — the protocol is standard HTTP + on-chain USDC.

The seller never needs to pre-register clients, issue API keys manually, or manage billing. Payment is the credential.

## Storage

Key0 requires a storage backend for challenge state and double-spend prevention. `store` and `seenTxStore` are mandatory fields. Both Redis and Postgres backends are supported.

```typescript
import { RedisChallengeStore, RedisSeenTxStore } from "@key0ai/key0";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

app.use(
  key0Router({
    config: { /* ... */ },
    adapter,
    store: new RedisChallengeStore({ redis, challengeTTLSeconds: 900 }),
    seenTxStore: new RedisSeenTxStore({ redis }),
  })
);
```

Redis storage provides:
- Atomic state transitions via Lua scripts (safe for concurrent requests)
- Automatic TTL-based cleanup
- Double-spend prevention with `SET NX`

Postgres storage uses the same interface with row-level locking for atomic transitions. The schema uses `plan_id` as the column name (matching the `planId` TypeScript field).

All state transitions are recorded in an immutable audit log (`IAuditStore`) for observability and debugging. Redis and Postgres audit store implementations are included.

## Security

- **Pre-settlement state check** — Middleware checks challenge state before on-chain settlement to prevent duplicate USDC burns (DELIVERED returns cached grant, EXPIRED/CANCELLED reject without settling)
- **Double-spend prevention** — Each transaction hash can only be redeemed once (enforced atomically)
- **Idempotent requests** — Same `requestId` returns the same challenge (safe to retry)
- **On-chain verification** — Payments are verified against the actual blockchain (recipient, amount, timing)
- **Challenge expiry** — Challenges expire after `challengeTTLSeconds` (default 15 minutes)
- **Secret rotation** — `AccessTokenIssuer.verifyWithFallback()` supports rotating secrets with zero downtime

## Token Issuance

The `fetchResourceCredentials` callback gives you full control over what token is issued after a verified payment. Use the built-in `AccessTokenIssuer` for JWT issuance, or return any string (API key, opaque token, etc.):

```typescript
import { AccessTokenIssuer } from "@key0ai/key0";

const tokenIssuer = new AccessTokenIssuer(process.env.ACCESS_TOKEN_SECRET!);

fetchResourceCredentials: async (params) => {
  // TTL is entirely your decision — use planId to vary it, or hardcode
  const ttl = params.planId === "pro" ? 86400 : 3600;
  return tokenIssuer.sign(
    { sub: params.requestId, jti: params.challengeId, resourceId: params.resourceId, planId: params.planId },
    ttl,
  );
},
```

**Zero-downtime secret rotation:**

```typescript
const decoded = await issuer.verifyWithFallback(token, [process.env.PREVIOUS_SECRET!]);
```

### Lightweight Token Validator (Backend Services)

If your backend only needs to validate Key0 tokens without the full SDK, use `validateKey0Token`:

```typescript
import { validateKey0Token } from "@key0ai/key0";

const payload = await validateKey0Token(req.headers.authorization, {
  secret: process.env.ACCESS_TOKEN_SECRET!,
});
// payload: { sub, jti, resourceId, planId, txHash, ... }
```

Supports both HS256 (shared secret) and RS256 (public key) algorithms. No blockchain connection needed.

### Settlement Strategies

**Facilitator (default)** — Coinbase CDP executes an EIP-3009 `transferWithAuthorization` on-chain:

```bash
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret
```

**Gas Wallet** — self-contained settlement, no external service:

```typescript
{ gasWalletPrivateKey: process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` }
```

The gas wallet must hold ETH on Base to pay transaction fees.

## Networks

| Network | Chain | Chain ID | USDC Contract | EIP-712 Domain Name | EIP-712 Version |
|---|---|---|---|---|---|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `USDC` | `2` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `USDC` | `2` |

---

## Running Examples

The examples use Base Sepolia by default — testnet USDC is free.

**Prerequisites:**
- Seller wallet (receive-only address)
- Client wallet with a private key
- Testnet USDC from the [Circle Faucet](https://faucet.circle.com/) (select Base Sepolia)

```bash
# Terminal 1 — seller
cd examples/express-seller
cp .env.example .env
# set KEY0_WALLET_ADDRESS and ACCESS_TOKEN_SECRET
bun run start

# Terminal 2 — buyer
cd examples/client-agent
cp .env.example .env
# set WALLET_PRIVATE_KEY and SELLER_URL=http://localhost:3000
bun run start
```

| Example | Description |
|---|---|
| [`examples/express-seller`](./examples/express-seller) | Express photo gallery with two pricing plans |
| [`examples/hono-seller`](./examples/hono-seller) | Same features using Hono |
| [`examples/standalone-service`](./examples/standalone-service) | Key0 as a separate service with Redis + gas wallet |
| [`examples/refund-cron-example`](./examples/refund-cron-example) | BullMQ refund cron with Redis-backed storage |
| [`examples/backend-integration`](./examples/backend-integration) | Key0 service + backend API coordination |
| [`examples/client-agent`](./examples/client-agent) | Buyer agent with real on-chain USDC payments |
| [`examples/simple-x402-client.ts`](./examples/simple-x402-client.ts) | Minimal x402 HTTP client example (single file) |

---

## Development

```bash
bun install          # Install dependencies
bun run typecheck    # Type-check
bun run lint         # Lint with Biome v2
bun test src/        # Run unit tests
                     # E2E tests require Docker + funded wallets — see e2e/README.md
bun run build        # Compile to ./dist
```

## Documentation

Full documentation at **[docs.key0.ai](https://docs.key0.ai/introduction/overview)**.

- [SPEC.md](./SPEC.md) — Protocol specification
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [setup-ui.md](./docs/setup-ui.md) — Setup UI architecture
- [Refund_flow.md](./docs/Refund_flow.md) — Refund state machine
- [mcp-integration.md](./docs/mcp-integration.md) — MCP transport
- [FLOW.md](./docs/FLOW.md) — Payment flow diagrams
