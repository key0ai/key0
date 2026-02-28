# AgentGate

Turn any API into a pay-per-use service for AI agents. No signups, no API keys, no human in the loop.

AgentGate adds a payment layer to your existing API using on-chain USDC on Base. An AI agent discovers your service, pays a few cents, and gets instant access — all autonomously.

## Why AgentGate?

AI agents can't sign up for accounts, enter credit cards, or verify emails. AgentGate solves this:

```
Traditional API access:          AgentGate:
  Sign up → Verify email →        Agent discovers your API →
  Add credit card → Get API key → Pays USDC on-chain →
  Make request                     Gets instant access
```

Your API gets paid. The agent gets access. No human needed.

## How It Works

```
  AI Agent                                    Your Server
     |                                             |
     |  1. Discover                                |
     |  GET /.well-known/agent.json                |
     |-------------------------------------------->|
     |  <--- Agent card (pricing, skills)          |
     |                                             |
     |  2. Request access                          |
     |  POST /agent  { resourceId, tierId }        |
     |-------------------------------------------->|
     |  <--- Payment challenge ($0.10 USDC)        |
     |                                             |
     |  3. Pay on-chain                            |
     |  USDC transfer on Base ----------------------> Blockchain
     |  <--- txHash                                |
     |                                             |
     |  4. Submit proof                            |
     |  POST /agent  { challengeId, txHash }       |
     |-------------------------------------------->|
     |       Server verifies tx on-chain --------->|
     |  <--- Access token (JWT)                    |
     |                                             |
     |  5. Use API                                 |
     |  GET /api/photos/42                         |
     |  Authorization: Bearer <token>              |
     |-------------------------------------------->|
     |  <--- Protected content                     |
     |                                             |
```

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- A wallet address on Base to receive USDC payments (no private key needed on the server)

## Quick Start

### 1. Install

```bash
bun add @agentgate/sdk
```

### 2. Add to your Express app

```typescript
import express from "express";
import { agentGateRouter, validateAccessToken } from "@agentgate/sdk/express";
import { X402Adapter } from "@agentgate/sdk";

const app = express();
app.use(express.json());

const adapter = new X402Adapter({ network: "testnet" });

// Mount AgentGate (serves agent card + payment endpoints)
app.use(
  agentGateRouter({
    config: {
      agentName: "My API",
      agentDescription: "A payment-gated API",
      agentUrl: "http://localhost:3000",
      providerName: "My Company",
      providerUrl: "https://example.com",
      walletAddress: "0xYourWalletAddress" as `0x${string}`,
      network: "testnet",
      accessTokenSecret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
      products: [
        {
          tierId: "basic",
          label: "Basic Access",
          amount: "$0.10",
          resourceType: "api-call",
          accessDurationSeconds: 3600,
        },
      ],
      onVerifyResource: async (resourceId) => true,
    },
    adapter,
  })
);

// Protect your routes
app.use("/api", validateAccessToken({
  secret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
}));

app.get("/api/data/:id", (req, res) => {
  res.json({ data: "premium content" });
});

app.listen(3000);
```

### 3. Set environment variables

```bash
AGENTGATE_NETWORK=testnet
AGENTGATE_WALLET_ADDRESS=0xYourWalletAddress
AGENTGATE_ACCESS_TOKEN_SECRET=your-secret-min-32-characters-long
```

### 4. Start your server

```bash
bun run server.ts
```

Your server now exposes:
- `GET /.well-known/agent.json` — Agent card (auto-generated from your config)
- `POST /agent` — A2A endpoint for the payment challenge flow
- `GET /api/*` — Your protected routes (requires JWT from payment flow)

## Run the Example

A working photo gallery example is included.

```bash
# Clone the repo
git clone <repo-url>
cd api-agentic-commerce
bun install

# Set up the example server
cd examples/express-seller
cp .env.example .env
```

Edit `.env` with your wallet address:

```bash
AGENTGATE_NETWORK=testnet
AGENTGATE_WALLET_ADDRESS=0xYourWalletAddress
AGENTGATE_ACCESS_TOKEN_SECRET=change-me-to-a-random-string-at-least-32-chars
PORT=3000
```

Start the server:

```bash
bun run start
```

You should see:

```
Photo Gallery Agent running on http://localhost:3000
  Agent card: http://localhost:3000/.well-known/agent.json
  A2A endpoint: http://localhost:3000/agent
  Network: testnet
```

Visit `http://localhost:3000/.well-known/agent.json` in your browser to see the auto-generated agent card with pricing and skills.

## Use with Claude (or any AI Agent)

Once your AgentGate server is running, any A2A-compatible AI agent can interact with it. Here's how it works in a conversation with Claude:

1. **Give Claude your agent card URL** — share `http://localhost:3000/.well-known/agent.json`
2. **Claude reads the agent card** — discovers your pricing, skills, and payment details
3. **Claude requests access** — sends a `POST` to your `/agent` endpoint with the resource and tier
4. **Claude receives a payment challenge** — amount, destination wallet, chain ID
5. **Claude pays on-chain** — transfers USDC to your wallet on Base (requires a funded wallet)
6. **Claude submits proof** — sends the transaction hash back
7. **Claude gets a JWT** — uses it to call your protected API

The agent card tells Claude everything it needs: what resources are available, how much they cost, and how to pay. No documentation or manual integration needed.

## Framework Support

AgentGate works with Express, Hono, and Fastify.

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
api.use("/*", honoValidateAccessToken({ secret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET! }));
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
fastify.addHook("onRequest", fastifyValidateAccessToken({
  secret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET!,
}));

fastify.listen({ port: 3000 });
```

## Configuration

### SellerConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentName` | `string` | Yes | Display name for your agent |
| `agentDescription` | `string` | Yes | Description shown in agent card |
| `agentUrl` | `string` | Yes | Public URL of your server |
| `providerName` | `string` | Yes | Your company/org name |
| `providerUrl` | `string` | Yes | Your company/org URL |
| `walletAddress` | `` `0x${string}` `` | Yes | Wallet to receive USDC (no private key needed) |
| `network` | `"testnet"` \| `"mainnet"` | Yes | Base Sepolia or Base mainnet |
| `products` | `ProductTier[]` | Yes | Pricing tiers |
| `accessTokenSecret` | `string` | Yes | JWT signing secret (min 32 chars) |
| `onVerifyResource` | `(resourceId, tierId) => Promise<boolean>` | Yes | Check if a resource exists |
| `basePath` | `string` | No | A2A endpoint path (default: `"/agent"`) |
| `accessTokenTTLSeconds` | `number` | No | JWT expiry (default: `3600`) |
| `challengeTTLSeconds` | `number` | No | Payment challenge expiry (default: `900`) |
| `onPaymentReceived` | `(grant) => Promise<void>` | No | Hook after successful payment |

### ProductTier

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tierId` | `string` | Yes | Unique identifier (e.g. `"basic"`) |
| `label` | `string` | Yes | Display name (e.g. `"Basic Access"`) |
| `amount` | `string` | Yes | Price (e.g. `"$0.10"`) |
| `resourceType` | `string` | Yes | Category (e.g. `"photo"`, `"api-call"`) |
| `accessDurationSeconds` | `number` | No | Per-tier token TTL override |

### Environment Variables

```bash
AGENTGATE_NETWORK=testnet                          # "testnet" or "mainnet"
AGENTGATE_WALLET_ADDRESS=0xYourWalletAddress        # Receive-only wallet
AGENTGATE_ACCESS_TOKEN_SECRET=your-secret-min-32ch  # JWT signing secret
AGENTGATE_RPC_URL=https://sepolia.base.org          # Optional: custom RPC
PORT=3000                                           # Server port
```

## Networks

| Network | Chain | Chain ID | USDC Contract |
|---------|-------|----------|---------------|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Start with `testnet` for development. Get free testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Base Sepolia + USDC). Switch to `mainnet` when ready for real payments — just change the `network` field.

## Production

For production deployments, swap in Redis storage for multi-process safety:

```bash
bun add ioredis
```

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

Also remember to:
- Use `network: "mainnet"` for real USDC payments
- Set a strong, random `accessTokenSecret` (32+ characters)
- Use HTTPS for your `agentUrl`
- Connect `onVerifyResource` to your real database

## Security

- **Double-spend prevention** — each transaction hash can only be redeemed once
- **On-chain verification** — payments verified against the actual blockchain
- **Challenge expiry** — payment challenges expire after 15 minutes (configurable)
- **Idempotent requests** — same `requestId` returns the same challenge (safe to retry)
- **Secret rotation** — `AccessTokenIssuer.verifyWithFallback()` supports rotating secrets with zero downtime

## Development

```bash
bun install           # Install dependencies
bun run typecheck     # Type-check
bun run lint          # Lint with Biome
bun test --recursive  # Run tests
```

## License

MIT
