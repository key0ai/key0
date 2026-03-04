# AgentGate

Payment-gated A2A (Agent-to-Agent) endpoints using the x402 protocol with USDC on Base.

AgentGate lets you monetize any API: agents request access, pay via on-chain USDC, and receive a signed credential to access protected resources. No smart contracts needed.

---

## Two Ways to Run

| | [Standalone (Docker)](#standalone-mode) | [Embedded (SDK)](#embedded-mode) |
|---|---|---|
| **Setup** | `docker run riklr/agentgate:latest` | `bun add @agentgate/sdk` |
| **Config** | Environment variables | TypeScript config |
| **Token issuance** | Delegated to your `ISSUE_TOKEN_API` | Your `onIssueToken` callback |
| **Best for** | Quick deploy, no code changes | Full control, existing app |

---

## Standalone Mode

Run AgentGate as a pre-built Docker container. No code required — configure entirely via environment variables and point it at your own token-issuance endpoint.

```
┌──────────────┐        ┌───────────────────────────┐        ┌──────────────────┐
│ Client Agent │        │    AgentGate (Docker)     │        │  Your Backend    │
│              │        │                           │        │                  │
│  discover    │───────▶│  /.well-known/agent.json  │        │                  │
│              │◀───────│  agent card + pricing      │        │                  │
│              │        │                           │        │                  │
│  request     │───────▶│  /a2a/access              │        │                  │
│              │◀───────│  402 + payment terms       │        │                  │
│              │        │                           │        │                  │
│  [pays USDC on Base]  │                           │        │                  │
│              │        │                           │        │                  │
│  retry +sig  │───────▶│  settle on-chain          │        │                  │
│              │        │  verify payment           │        │                  │
│              │        │  POST /issue-token ───────│───────▶│  issue-token     │
│              │        │                    ◀──────│────────│  {token, ...}    │
│              │◀───────│  AccessGrant              │        │                  │
│              │        │  (token passed through)   │        │                  │
└──────────────┘        └───────────────────────────┘        └──────────────────┘
```

### Quick Start

**Two required environment variables:**

| Variable | Description |
|---|---|
| `AGENTGATE_WALLET_ADDRESS` | USDC-receiving wallet (`0x...`) |
| `ISSUE_TOKEN_API` | URL that AgentGate POSTs to after payment is verified |

```bash
docker run \
  -e AGENTGATE_WALLET_ADDRESS=0xYourWallet \
  -e ISSUE_TOKEN_API=https://api.example.com/issue-token \
  -p 3000:3000 \
  riklr/agentgate:latest
```

### With Docker Compose + Redis

```bash
cp docker/.env.example docker/.env
# Edit docker/.env: set AGENTGATE_WALLET_ADDRESS and ISSUE_TOKEN_API
docker compose -f docker/docker-compose.yml up
```

### Docker Image

Published to Docker Hub on every release: [`riklr/agentgate`](https://hub.docker.com/r/riklr/agentgate)

| Tag | When |
|---|---|
| `latest` | Latest stable release |
| `1.2.3` / `1.2` / `1` | Specific version |
| `canary` | Latest `main` branch build |

Build from source: `docker build -t riklr/agentgate .`

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENTGATE_WALLET_ADDRESS` | ✅ | — | USDC-receiving wallet |
| `ISSUE_TOKEN_API` | ✅ | — | URL to POST to after payment |
| `AGENTGATE_NETWORK` | | `testnet` | `mainnet` or `testnet` |
| `PORT` | | `3000` | HTTP listen port |
| `AGENT_NAME` | | `AgentGate Server` | Display name in agent card |
| `AGENT_DESCRIPTION` | | `Payment-gated A2A endpoint` | Agent card description |
| `AGENT_URL` | | `http://localhost:PORT` | Public URL of this server |
| `PROVIDER_NAME` | | `AgentGate` | Provider display name |
| `PROVIDER_URL` | | `https://agentgate.dev` | Provider URL |
| `PRODUCTS` | | `[{"tierId":"basic","label":"Basic","amount":"$0.10","resourceType":"api","accessDurationSeconds":3600}]` | JSON array of product tiers |
| `CHALLENGE_TTL_SECONDS` | | `900` | Challenge expiry in seconds |
| `BASE_PATH` | | `/a2a` | A2A endpoint mount path |
| `ISSUE_TOKEN_API_SECRET` | | — | Adds `Authorization: Bearer` to token API requests |
| `REDIS_URL` | | — | Redis URL (required for multi-instance) |
| `GAS_WALLET_PRIVATE_KEY` | | — | Private key for self-contained settlement |
| `AGENTGATE_WALLET_PRIVATE_KEY` | | — | Private key of `AGENTGATE_WALLET_ADDRESS` — enables automatic refunds |
| `REFUND_INTERVAL_MS` | | `60000` | How often the refund cron scans for eligible records |
| `REFUND_MIN_AGE_MS` | | `300000` | Grace period before a `PAID` record is eligible for refund |

See [`docker/.env.example`](docker/.env.example) for a fully annotated example.

### ISSUE_TOKEN_API Contract

After on-chain payment is verified, AgentGate POSTs to `ISSUE_TOKEN_API` with the payment context merged with the matching product tier:

```json
{
  "requestId": "uuid",
  "challengeId": "uuid",
  "resourceId": "photo-42",
  "tierId": "basic",
  "txHash": "0x...",
  "label": "Basic",
  "amount": "$0.10",
  "resourceType": "api",
  "accessDurationSeconds": 3600
}
```

Any extra fields you add to your `PRODUCTS` tiers are included automatically.

Your endpoint can return any credential shape — the response is passed through to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2025-01-01T00:00:00Z", "tokenType": "Bearer" }
```

```json
{ "apiKey": "sk-123", "apiSecret": "secret", "expiresAt": "..." }
```

If the response has a `token` string field it is used directly. Otherwise the full response body is JSON-serialized into `token` with `tokenType: "custom"`, so the client can parse it.

### Automatic Refunds (Standalone)

When `AGENTGATE_WALLET_PRIVATE_KEY` is set, the Docker server runs a BullMQ refund cron automatically — no extra setup needed. It scans for `PAID` challenges that were never delivered (e.g. because `ISSUE_TOKEN_API` returned an error) and sends USDC back to the payer.

```
┌──────────────┐   ┌───────────────────────────┐   ┌──────────────────┐
│ Client Agent │   │    AgentGate (Docker)     │   │   Blockchain     │
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
AGENTGATE_WALLET_PRIVATE_KEY=0xYourWalletPrivateKeyHere
REFUND_INTERVAL_MS=60000   # scan every 60s
REFUND_MIN_AGE_MS=300000   # refund after 5-min grace period
```

> Redis is required for refund cron when running multiple replicas — BullMQ ensures only one worker broadcasts each refund transaction.

---

## Embedded Mode

Install the SDK and add AgentGate as middleware inside your existing application. You keep full control over token issuance, resource verification, and routing.

```
┌──────────────┐        ┌──────────────────────────────────────────────────┐
│ Client Agent │        │                 Your Application                  │
│              │        │  ┌────────────────────────────────────────────┐  │
│  discover    │───────▶│  │           AgentGate Middleware              │  │
│              │◀───────│  │  /.well-known/agent.json  (auto-generated)  │  │
│              │        │  │  /a2a/access  (x402 payment + settlement)   │  │
│  request     │───────▶│  │                                             │  │
│              │◀───────│  │  onVerifyResource()  ──▶  your DB/logic     │  │
│  [pays USDC on Base]  │  │  onIssueToken()      ──▶  your JWT/key gen  │  │
│  retry +sig  │───────▶│  │                                             │  │
│              │◀───────│  │  AccessGrant (JWT or custom credential)     │  │
│              │        │  └────────────────────────────────────────────┘  │
│  /api/res    │───────▶│                                                   │
│  Bearer: JWT │        │  Protected Routes  (validateAccessToken)          │
│              │◀───────│  premium content                                  │
└──────────────┘        └──────────────────────────────────────────────────┘
```

### Install

```bash
bun add @agentgate/sdk
```

Optional peer dependencies:
```bash
bun add ioredis   # Redis-backed storage for multi-process deployments
```

### Express

```typescript
import express from "express";
import { agentGateRouter, validateAccessToken } from "@agentgate/sdk/express";
import { X402Adapter, AccessTokenIssuer } from "@agentgate/sdk";

const app = express();
app.use(express.json());

const adapter = new X402Adapter({ network: "testnet" });
const tokenIssuer = new AccessTokenIssuer(process.env.ACCESS_TOKEN_SECRET!);

app.use(
  agentGateRouter({
    config: {
      agentName: "My Agent",
      agentDescription: "A payment-gated API",
      agentUrl: "https://my-agent.example.com",
      providerName: "My Company",
      providerUrl: "https://example.com",
      walletAddress: "0xYourWalletAddress" as `0x${string}`,
      network: "testnet",
      products: [
        {
          tierId: "basic",
          label: "Basic Access",
          amount: "$0.10",
          resourceType: "api-call",
          accessDurationSeconds: 3600,
        },
      ],
      onVerifyResource: async (resourceId, tierId) => {
        return true; // check your DB here
      },
      onIssueToken: async (params) => {
        return tokenIssuer.sign(
          { sub: params.requestId, jti: params.challengeId, resourceId: params.resourceId },
          params.accessDurationSeconds,
        );
      },
    },
    adapter,
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
import { agentGateApp, honoValidateAccessToken } from "@agentgate/sdk/hono";
import { X402Adapter } from "@agentgate/sdk";

const adapter = new X402Adapter({ network: "testnet" });
const gate = agentGateApp({ config: { /* same config */ }, adapter });

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
import { agentGatePlugin, fastifyValidateAccessToken } from "@agentgate/sdk/fastify";
import { X402Adapter } from "@agentgate/sdk";

const fastify = Fastify();
const adapter = new X402Adapter({ network: "testnet" });

await fastify.register(agentGatePlugin, { config: { /* same config */ }, adapter });
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
| `products` | `ProductTier[]` | ✅ | — | Pricing tiers |
| `onVerifyResource` | `(resourceId, tierId) => Promise<boolean>` | ✅ | — | Check the resource exists and tier is valid |
| `onIssueToken` | `(params) => Promise<TokenIssuanceResult>` | ✅ | — | Issue the credential after payment |
| `challengeTTLSeconds` | `number` | | `900` | Challenge validity window |
| `resourceVerifyTimeoutMs` | `number` | | `5000` | Timeout for `onVerifyResource` |
| `basePath` | `string` | | `"/a2a"` | A2A endpoint path prefix |
| `resourceEndpointTemplate` | `string` | | auto | URL template (use `{resourceId}`) |
| `gasWalletPrivateKey` | `0x${string}` | | — | Private key for self-contained settlement |
| `facilitatorUrl` | `string` | | CDP default | Override the x402 facilitator URL |
| `onPaymentReceived` | `(grant) => Promise<void>` | | — | Fired after successful payment |
| `onChallengeExpired` | `(challengeId) => Promise<void>` | | — | Fired when a challenge expires |

#### ProductTier

| Field | Type | Required | Description |
|---|---|---|---|
| `tierId` | `string` | ✅ | Unique tier identifier |
| `label` | `string` | ✅ | Display name |
| `amount` | `string` | ✅ | Price (e.g. `"$0.10"`) |
| `resourceType` | `string` | ✅ | Category (e.g. `"photo"`, `"api-call"`) |
| `accessDurationSeconds` | `number` | | Token validity; omit for single-use |

#### IssueTokenParams

| Field | Type | Description |
|---|---|---|
| `challengeId` | `string` | Use as JWT `jti` for replay prevention |
| `requestId` | `string` | Use as JWT `sub` |
| `resourceId` | `string` | Purchased resource |
| `tierId` | `string` | Purchased tier |
| `txHash` | `0x${string}` | On-chain transaction hash |

### Refund Cron (Embedded)

When `onIssueToken` throws or the server crashes after payment but before delivery, the `ChallengeRecord` stays in `PAID` state. Wire up `processRefunds` on a schedule to detect these and send USDC back to the payer.

```
┌──────────────┐   ┌──────────────────────────────────────────────────┐   ┌──────────┐
│ Client Agent │   │                 Your Application                  │   │Blockchain│
│              │   │  ┌────────────────────────────────────────────┐  │   │          │
│  pays USDC   │──▶│  │  AgentGate Middleware                       │  │──▶│          │
│              │   │  │  verify on-chain                            │  │◀──│          │
│              │   │  │  PENDING ──────────────────────────▶ PAID   │  │   │          │
│              │   │  │  onIssueToken() throws                      │  │   │          │
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
import { processRefunds } from "@agentgate/sdk";

// Uses the same `store` passed to agentGateRouter
const worker = new Worker("refund-cron", async () => {
  const results = await processRefunds({
    store,
    walletPrivateKey: process.env.AGENTGATE_WALLET_PRIVATE_KEY as `0x${string}`,
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

### Environment Variables

```bash
AGENTGATE_NETWORK=testnet                          # "testnet" or "mainnet"
AGENTGATE_WALLET_ADDRESS=0xYourWalletAddress        # Receive-only wallet (no private key needed)
ACCESS_TOKEN_SECRET=your-secret-min-32-chars        # JWT signing secret for AccessTokenIssuer
PORT=3000                                           # Server port

# Required for x402 HTTP flow with CDP facilitator (alternative to gas wallet)
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret

# Optional: self-contained settlement without a facilitator
AGENTGATE_GAS_WALLET_KEY=0xYourPrivateKey
```

## How It Works

AgentGate supports two payment flows. Both follow the same `ChallengeRecord` lifecycle (`PENDING → PAID → DELIVERED`) and are eligible for automatic refunds.

### A2A Flow (Agent-to-Agent)

```
Client Agent                          Seller Server
     |                                      |
     |  1. GET /.well-known/agent.json      |
     |------------------------------------->|
     |  <-- Agent card (skills, pricing)    |
     |                                      |
     |  2. POST /a2a/jsonrpc (AccessRequest)|
     |------------------------------------->|
     |  <-- X402Challenge (amount, chain,   |
     |       destination, challengeId)      |
     |                                      |
     |  3. Pay USDC on Base (on-chain)      |
     |----> Blockchain                      |
     |  <-- txHash                          |
     |                                      |
     |  4. POST /a2a/jsonrpc (PaymentProof) |
     |------------------------------------->|
     |      Server verifies tx on-chain --> |
     |  <-- AccessGrant (JWT + endpoint)    |
     |                                      |
     |  5. GET /api/resource/:id            |
     |     Authorization: Bearer <JWT>      |
     |------------------------------------->|
     |  <-- Protected content               |
```

1. **Discovery** — Client fetches the agent card at `/.well-known/agent.json` to learn about available products and pricing
2. **Access Request** — Client sends an `AccessRequest` with the resource ID and desired tier
3. **Challenge** — Server creates a `PENDING` record and returns an `X402Challenge` with payment details
4. **Payment** — Client pays on-chain USDC on Base — a standard ERC-20 transfer, no custom contracts
5. **Proof** — Client submits a `PaymentProof` with the transaction hash
6. **Verification** — Server verifies the payment on-chain (correct recipient, amount, not expired, not double-spent), transitions `PENDING → PAID`
7. **Grant** — Server calls `onIssueToken`, transitions `PAID → DELIVERED`, returns an `AccessGrant` with the token and resource endpoint URL
8. **Access** — Client uses the token as a Bearer header to access the protected resource

### HTTP x402 Flow (Gas Wallet / Facilitator)

```
Client                                Seller Server
     |                                      |
     |  1. POST /a2a/jsonrpc                |
     |     (AccessRequest, no payment)      |
     |------------------------------------->|
     |  <-- HTTP 402 + PaymentRequirements  |
     |       + challengeId                  |
     |                                      |
     |  2. POST /a2a/jsonrpc                |
     |     (AccessRequest + PAYMENT-        |
     |      SIGNATURE header with signed    |
     |      EIP-3009 authorization)         |
     |------------------------------------->|
     |      Gas wallet / facilitator        |
     |      settles on-chain -------------> |
     |  <-- AccessGrant (JWT + endpoint)    |
     |                                      |
     |  3. GET /api/resource/:id            |
     |     Authorization: Bearer <JWT>      |
     |------------------------------------->|
     |  <-- Protected content               |
```

1. **Challenge (402)** — Client sends an `AccessRequest` without a payment header. Server creates a `PENDING` record and returns HTTP 402 with x402 `PaymentRequirements` and the `challengeId`
2. **Payment + Settlement** — Client sends the same request with a `PAYMENT-SIGNATURE` header containing a signed EIP-3009 authorization. The gas wallet or facilitator settles the payment on-chain, then the server transitions `PENDING → PAID → DELIVERED` and returns an `AccessGrant`
3. **Access** — Client uses the token as a Bearer header to access the protected resource

If `onIssueToken` fails in either flow, the record stays `PAID` and the [refund cron](#refund-flow) picks it up automatically.

## Storage

By default, AgentGate uses in-memory storage (suitable for development and single-process deployments). For production with multiple processes, use Redis:

```typescript
import { RedisChallengeStore, RedisSeenTxStore } from "@agentgate/sdk";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

app.use(
  agentGateRouter({
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

## Security

- **Double-spend prevention** — Each transaction hash can only be redeemed once (enforced atomically)
- **Idempotent requests** — Same `requestId` returns the same challenge (safe to retry)
- **On-chain verification** — Payments are verified against the actual blockchain (recipient, amount, timing)
- **Challenge expiry** — Challenges expire after `challengeTTLSeconds` (default 15 minutes)
- **Secret rotation** — `AccessTokenIssuer.verifyWithFallback()` supports rotating secrets with zero downtime
- **Resource verification timeout** — `onVerifyResource` has a configurable timeout (default 5s) to prevent hanging

## Token Issuance

The `onIssueToken` callback gives you full control over what token is issued after a verified payment. Use the built-in `AccessTokenIssuer` for JWT issuance, or return any string (API key, opaque token, etc.):

```typescript
import { AccessTokenIssuer } from "@agentgate/sdk";

const tokenIssuer = new AccessTokenIssuer(process.env.ACCESS_TOKEN_SECRET!);

onIssueToken: async (params) => {
  return tokenIssuer.sign(
    { sub: params.requestId, jti: params.challengeId, resourceId: params.resourceId },
    params.accessDurationSeconds, // token TTL in seconds
  );
},
```

**Zero-downtime secret rotation:**

```typescript
const decoded = await issuer.verifyWithFallback(token, [process.env.PREVIOUS_SECRET!]);
```

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

## Refund Flow

Every payment — whether via the A2A protocol or the HTTP x402 flow — is tracked through a single `ChallengeRecord` with the following lifecycle:

```
PENDING ─── payment verified ──────────────► PAID
PENDING ─── challenge TTL exceeded ────────► EXPIRED
PENDING ─── seller cancels ────────────────► CANCELLED

PAID ────── onIssueToken() succeeds ───────► DELIVERED       ← happy path
PAID ────── cron picks up after grace ─────► REFUND_PENDING
REFUND_PENDING ── refund succeeds ─────────► REFUNDED
REFUND_PENDING ── refund fails ────────────► REFUND_FAILED   ← needs operator
```

In the happy path, `PAID` lasts milliseconds — the SDK transitions to `DELIVERED` immediately after `onIssueToken` succeeds. The refund cron is a safety net for when `onIssueToken` throws or the server crashes between payment and delivery.

### How It Works

1. Payment is verified (on-chain for A2A, via gas wallet/facilitator for HTTP x402)
2. Record transitions `PENDING → PAID` with `txHash`, `paidAt`, and `fromAddress` (buyer's wallet)
3. SDK calls `onIssueToken` to generate the access token
4. On success: `PAID → DELIVERED` with `accessGrant` and `deliveredAt`
5. On failure: record stays `PAID` — the refund cron finds it after the grace period

The `fromAddress` is captured automatically: from the on-chain `Transfer` event in A2A, or from the settlement `payer` field in HTTP x402.

### Wiring Up the Refund Cron

Use `processRefunds` with a job scheduler like BullMQ to periodically scan for stuck `PAID` records and refund them:

```typescript
import { Queue, Worker } from "bullmq";
import { processRefunds, RedisChallengeStore } from "@agentgate/sdk";

const store = new RedisChallengeStore({ redis });

// Worker processes refund jobs
new Worker("refund-cron", async () => {
  const results = await processRefunds({
    store,
    walletPrivateKey: process.env.AGENTGATE_WALLET_PRIVATE_KEY as `0x${string}`,
    network: "testnet",
    minAgeMs: 5 * 60 * 1000, // 5-minute grace period
  });

  for (const r of results) {
    if (r.success) {
      console.log(`Refunded ${r.amount} to ${r.toAddress} — tx: ${r.refundTxHash}`);
    } else {
      console.error(`Refund failed for ${r.challengeId}: ${r.error}`);
    }
  }
}, { connection: redis });

// Schedule to run every 60 seconds
const queue = new Queue("refund-cron", { connection: redis });
await queue.add("process", {}, { repeat: { every: 60_000 } });
```

### processRefunds Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `IChallengeStore` | required | The same store passed to `agentGateRouter` |
| `walletPrivateKey` | `0x${string}` | required | Private key of `walletAddress` — used to send USDC refunds |
| `network` | `"mainnet" \| "testnet"` | required | Determines USDC contract and RPC endpoint |
| `minAgeMs` | `number` | `300_000` (5 min) | Grace period before a `PAID` record is eligible for refund |
| `sendUsdc` | `function` | built-in | Override for testing or custom routing |

### Double-Refund Prevention

The `PAID → REFUND_PENDING` transition is atomic in both store implementations. In Redis, a Lua script ensures only one worker can claim a record — if two cron instances fire simultaneously, only one USDC transfer is broadcast. See [Refund_flow.md](./docs/Refund_flow.md) for full details on the state machine, store TTLs, and failure handling.

---

## Networks

| Network | Chain | Chain ID | USDC Contract | EIP-712 Domain Name |
|---|---|---|---|---|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `USD Coin` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `USD Coin` |

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
# set AGENTGATE_WALLET_ADDRESS and ACCESS_TOKEN_SECRET
bun run start

# Terminal 2 — buyer
cd examples/client-agent
cp .env.example .env
# set WALLET_PRIVATE_KEY and SELLER_URL=http://localhost:3000
bun run start
```

| Example | Description |
|---|---|
| [`examples/express-seller`](./examples/express-seller) | Express photo gallery with two pricing tiers |
| [`examples/hono-seller`](./examples/hono-seller) | Same features using Hono |
| [`examples/standalone-service`](./examples/standalone-service) | AgentGate as a separate service with Redis + gas wallet |
| [`examples/refund-cron-example`](./examples/refund-cron-example) | BullMQ refund cron with Redis-backed storage |
| [`examples/backend-integration`](./examples/backend-integration) | AgentGate service + backend API coordination |
| [`examples/client-agent`](./examples/client-agent) | Buyer agent with real on-chain USDC payments |

---

## Development

```bash
bun install          # Install dependencies
bun run typecheck    # Type-check
bun run lint         # Lint with Biome
bun test             # Run all tests
bun run build        # Compile to ./dist
```

### Project Structure

```
src/
  index.ts             # Main entry point (exports everything)
  factory.ts           # createAgentGate() — wires all layers together
  executor.ts          # AgentGateExecutor — A2A protocol handler
  middleware.ts        # validateToken() — framework-agnostic token validation
  types/               # Protocol types and interfaces
  core/                # Challenge engine, access tokens, storage, agent card
  adapter/             # X402Adapter — on-chain USDC verification via viem
  integrations/        # Express, Hono, Fastify adapters + x402 HTTP middleware
  helpers/             # Auth strategies, remote verifier/issuer helpers
  validator/           # Standalone validateAgentGateToken (no full SDK needed)
docker/
  server.ts            # Standalone server entry point
  docker-compose.yml   # Compose setup with Redis
  .env.example         # All environment variables documented
```

---

## Documentation

- [TECH.md](./TECH.md) — Technical architecture reference
- [SPEC.md](./SPEC.md) — Protocol specification
- [Refund_flow.md](./docs/Refund_flow.md) — Refund system: state machine, store TTLs, double-refund prevention, failure handling
