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

### Token Issuance

Use the built-in `AccessTokenIssuer` for JWT issuance, or return any string (API key, opaque token, etc.):

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

### Storage

In-memory by default. For multi-process production deployments, use Redis:

```typescript
import { RedisChallengeStore, RedisSeenTxStore } from "@agentgate/sdk";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

agentGateRouter({
  config: { /* ... */ },
  adapter,
  store: new RedisChallengeStore({ redis, challengeTTLSeconds: 900 }),
  seenTxStore: new RedisSeenTxStore({ redis }),
});
```

Redis storage uses atomic Lua scripts for state transitions and `SET NX` for double-spend prevention.

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

---

## How It Works

Both modes implement the same underlying protocol:

```
Client Agent                          AgentGate
     │                                    │
     │  1. GET /.well-known/agent.json    │
     │──────────────────────────────────▶ │
     │  ◀── agent card (skills, pricing)  │
     │                                    │
     │  2. POST /a2a/access               │
     │──────────────────────────────────▶ │
     │  ◀── 402 + payment requirements    │
     │       (amount, asset, payTo, chain)│
     │                                    │
     │  3. Sign EIP-3009 authorization    │
     │     [off-chain, no broadcast yet]  │
     │                                    │
     │  4. POST /a2a/access + signature   │
     │──────────────────────────────────▶ │
     │                         settle ──▶ Base
     │                         verify ◀── tx confirmed
     │                         issue token
     │  ◀── AccessGrant (token + endpoint)│
     │                                    │
     │  5. GET /api/resource              │
     │     Authorization: Bearer <token>  │
     │──────────────────────────────────▶ │
     │  ◀── protected content             │
```

1. **Discovery** — Client reads the agent card to learn products and pricing
2. **Request** — Client POSTs an access request; server returns 402 with payment terms
3. **Sign** — Client creates an EIP-3009 `transferWithAuthorization` signature off-chain
4. **Settle** — Client sends the signature; AgentGate broadcasts and confirms on-chain
5. **Grant** — Server calls `onIssueToken`, returns `AccessGrant` with the credential
6. **Access** — Client uses the credential to call the protected resource

---

## Security

- **Double-spend prevention** — Each `txHash` is redeemable exactly once (atomic `SET NX`)
- **On-chain verification** — Recipient, amount, and timing are verified against the blockchain
- **Challenge expiry** — Challenges expire after `challengeTTLSeconds` (default 15 min)
- **Idempotent requests** — Same `requestId` always returns the same challenge (safe to retry)
- **Secret rotation** — `verifyWithFallback()` rotates secrets with zero downtime

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
| [`examples/standalone-service`](./examples/standalone-service) | AgentGate as a separate service with Redis |
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
