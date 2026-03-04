# AgentGate

Payment-gated A2A (Agent-to-Agent) endpoints using the x402 protocol with USDC on Base.

AgentGate lets you monetize any API: agents request access, pay via on-chain USDC, and receive a signed credential to access protected resources. No smart contracts needed.

---

## Two Ways to Run

| | [Standalone (Docker)](#standalone-mode) | [Embedded (SDK)](#embedded-mode) |
|---|---|---|
| **Setup** | `docker run riklr/agentgate:latest` | `bun add @riklr/agentgate` |
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
│              │        │  [store: PENDING]         │        │                  │
│              │◀───────│  402 + payment terms       │        │                  │
│              │        │                           │        │                  │
│  [pays USDC on Base]  │                           │        │                  │
│              │        │                           │        │                  │
│  retry +sig  │───────▶│  settle on-chain          │        │                  │
│              │        │  verify payment           │        │                  │
│              │        │  [PENDING → PAID]         │        │                  │
│              │        │  POST /issue-token ───────│───────▶│  issue-token     │
│              │        │                    ◀──────│────────│  {token, ...}    │
│              │        │  [PAID → DELIVERED]       │        │                  │
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
| `AGENTGATE_WALLET_ADDRESS` | ✅ | — | Your wallet address (`0x…`) that receives USDC payments from agents |
| `ISSUE_TOKEN_API` | ✅ | — | Your endpoint that AgentGate POSTs to after payment is verified to issue access tokens |
| `AGENTGATE_NETWORK` | | `testnet` | Blockchain network — `mainnet` for Base, `testnet` for Base Sepolia |
| `PORT` | | `3000` | Port the HTTP server listens on |
| `AGENT_NAME` | | `AgentGate Server` | Name of your agent as shown in `/.well-known/agent.json` |
| `AGENT_DESCRIPTION` | | `Payment-gated A2A endpoint` | Short description of your agent shown in the agent card |
| `AGENT_URL` | | `http://localhost:PORT` | Publicly reachable URL of this server — used in the agent card and resource endpoint URLs |
| `PROVIDER_NAME` | | `AgentGate` | Your organization name shown in the agent card `provider` field |
| `PROVIDER_URL` | | `https://agentgate.dev` | Your organization URL shown in the agent card `provider` field |
| `PRODUCTS` | | `[{"tierId":"basic","label":"Basic","amount":"$0.10","resourceType":"api","accessDurationSeconds":3600}]` | JSON array of pricing tiers — each with `tierId`, `label`, `amount`, `resourceType`, and optional `accessDurationSeconds` |
| `CHALLENGE_TTL_SECONDS` | | `900` | How long a payment challenge remains valid before expiring (seconds) |
| `BASE_PATH` | ✅ | — | URL path prefix for A2A endpoints (e.g. `/a2a` mounts `/a2a/access` and `/a2a/.well-known/agent.json`) |
| `ISSUE_TOKEN_API_SECRET` | | — | If set, sent as `Authorization: Bearer <secret>` on every request to `ISSUE_TOKEN_API` |
| `REDIS_URL` | ✅ | — | Redis connection URL — required for multi-replica deployments and the BullMQ refund cron |
| `GAS_WALLET_PRIVATE_KEY` | | — | Private key of a wallet holding ETH on Base — enables self-contained settlement without a CDP facilitator |
| `AGENTGATE_WALLET_PRIVATE_KEY` | | — | Private key of `AGENTGATE_WALLET_ADDRESS` — required for the refund cron to send USDC back to payers |
| `REFUND_INTERVAL_MS` | | `60000` | How often the refund cron runs (ms) — only active when `AGENTGATE_WALLET_PRIVATE_KEY` is set |
| `REFUND_MIN_AGE_MS` | | `300000` | Minimum age (ms) a stuck `PAID` record must reach before the refund cron picks it up |

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
│  request     │───────▶│  │  onVerifyResource()  ──▶  your DB/logic     │  │
│              │        │  │  [store: PENDING]                          │  │
│              │◀───────│  │  402 + payment terms                        │  │
│  [pays USDC on Base]  │  │                                             │  │
│  retry +sig  │───────▶│  │  settle on-chain                           │  │
│              │        │  │  [PENDING → PAID]                          │  │
│              │        │  │  onIssueToken()      ──▶  your JWT/key gen  │  │
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
bun add @riklr/agentgate
```

Optional peer dependencies:
```bash
bun add ioredis   # Redis-backed storage for multi-process deployments
```

### Express

```typescript
import express from "express";
import { agentGateRouter, validateAccessToken } from "@riklr/agentgate/express";
import { X402Adapter, AccessTokenIssuer } from "@riklr/agentgate";

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
import { agentGateApp, honoValidateAccessToken } from "@riklr/agentgate/hono";
import { X402Adapter } from "@riklr/agentgate";

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
import { agentGatePlugin, fastifyValidateAccessToken } from "@riklr/agentgate/fastify";
import { X402Adapter } from "@riklr/agentgate";

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
import { processRefunds } from "@riklr/agentgate";

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
GAS_WALLET_PRIVATE_KEY=0xYourPrivateKey
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

If `onIssueToken` fails in either flow, the record stays `PAID` and the automatic refund cron picks it up after the grace period.

## Clients

Any agent that can hold a wallet and sign an on-chain USDC transfer can pay AgentGate-protected APIs autonomously — no human in the loop.

### Coding Agents (e.g. Claude Code)

Coding agents like [Claude Code](https://claude.ai/code) can discover an AgentGate endpoint, pay for access, and receive API keys or tokens entirely on their own using an MCP wallet tool. The [Coinbase payments MCP](https://github.com/coinbase/payments-mcp) gives Claude a client-side wallet it can use to sign and broadcast USDC transfers directly:

```
1. Agent reads /.well-known/agent.json → discovers pricing and wallet address
2. Agent calls payments-mcp to sign a USDC authorization (EIP-3009)
3. Agent sends the signed authorization → AgentGate settles on-chain and returns an AccessGrant with the token/API key
4. Agent uses the token to call the protected resource
```

No configuration or human approval required — the agent handles the full payment flow end-to-end.

### Autonomous Agents (e.g. OpenClaw)

Headless autonomous agents can do the same. Any agent runtime that supports wallet signing (via an embedded wallet, a KMS-backed key, or an MCP-compatible tool) can interact with AgentGate without modification — the protocol is standard HTTP + on-chain USDC.

The seller never needs to pre-register clients, issue API keys manually, or manage billing. Payment is the credential.

## Storage

By default, AgentGate uses in-memory storage (suitable for development and single-process deployments). For production with multiple processes, use Redis:

```typescript
import { RedisChallengeStore, RedisSeenTxStore } from "@riklr/agentgate";
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
import { AccessTokenIssuer } from "@riklr/agentgate";

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

## Documentation

- [SPEC.md](./SPEC.md) — Protocol specification
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines and development setup (`github.com/Riklr/agentgate`)
- [Refund_flow.md](./docs/Refund_flow.md) — Refund system: state machine, store TTLs, double-refund prevention, failure handling
