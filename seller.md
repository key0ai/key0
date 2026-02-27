# Seller SDK — System Design & Integration Guide

> This document covers the seller-side integration: the `@agentic-payment/seller-sdk`
> package that sellers install in their existing backend. It also covers the seller
> onboarding flow on the platform.

---

## Role

The seller:
- Registers their API on the platform (one-time, via platform API or dashboard)
- Connects their Stripe account to receive payouts
- Installs the SDK into their existing backend — **one middleware line**
- Does not need to understand x402, USDC, or blockchain

The SDK:
- Verifies incoming JWTs (signed by the platform's RSA private key)
- Enforces usage limits via a pluggable counter storage
- Returns standardized errors so buyer agents know how to react

---

## System Design

### What the Seller Does NOT Need

| Concern | Handled by |
|---|---|
| Accepting crypto payments | Platform |
| USDC → USD conversion | Platform (Stripe USDC settlement) |
| Generating tokens | Platform (signed JWT) |
| Verifying on-chain payments | Platform |
| Running any new endpoints | Not needed — only middleware |

---

### What the Seller Adds to Their Backend

```
Existing seller backend
       │
       ├── /data/2.5/weather      ← existing route
       ├── /data/2.5/forecast     ← existing route
       └── /data/2.5/*            ← validateToken() middleware added here
                                     (one line of code)
```

---

### SDK Architecture

```
┌────────────────────────────────────────────────────────┐
│               @agentic-payment/seller-sdk               │
│                                                        │
│  validateToken(config)                                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │  1. Extract JWT from Authorization header        │  │
│  │  2. Verify RS256 signature (platform public key) │  │
│  │  3. Check exp claim (token expiry)               │  │
│  │  4. Look up jti in TokenStorage                  │  │
│  │     → not found: init counter = usage_limit      │  │
│  │     → found: use existing counter                │  │
│  │  5. Check remaining > 0  (or usage_limit == -1)  │  │
│  │  6. Decrement counter                            │  │
│  │  7. Attach token claims to request context       │  │
│  │  8. Call next()                                  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  TokenStorage (interface)                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  get(jti)          → { remaining } | null        │  │
│  │  set(jti, n, exp)  → void                        │  │
│  │  decrement(jti)    → new remaining count         │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Built-in implementations:                            │
│  ┌───────────────┐  ┌──────────────┐                  │
│  │ InMemory      │  │ Redis        │                  │
│  │ Storage       │  │ Storage      │                  │
│  │ (default)     │  │ (adapter)    │                  │
│  └───────────────┘  └──────────────┘                  │
└────────────────────────────────────────────────────────┘
```

---

### Token Storage Interface

Sellers plug in their own storage by implementing three methods. The SDK handles all the JWT logic — storage is the only seller responsibility.

```typescript
interface TokenStorage {
  // Return current remaining count for a token, or null if not yet seen
  get(jti: string): Promise<{ remaining: number } | null>;

  // Initialise a token's counter when first encountered
  set(jti: string, remaining: number, expiresAt: Date): Promise<void>;

  // Atomically decrement counter, return new value
  // Must be atomic to be safe under concurrent requests
  decrement(jti: string): Promise<number>;
}
```

**On first use of a token:**
1. SDK calls `storage.get(jti)` → returns `null`
2. SDK reads `usage_limit` from JWT claims
3. SDK calls `storage.set(jti, usage_limit - 1, expiresAt)`
4. Request is allowed

**On subsequent uses:**
1. SDK calls `storage.get(jti)` → returns `{ remaining: N }`
2. If N > 0: SDK calls `storage.decrement(jti)`, allows request
3. If N == 0: SDK rejects with 429

**On unlimited tokens** (`usage_limit == -1`):
1. SDK skips all counter logic entirely
2. Only expiry (`exp`) is enforced

---

### JWT Claims the SDK Uses

The SDK reads these claims from the platform-signed JWT:

| Claim | Type | Used for |
|---|---|---|
| `jti` | string | Storage key for usage counter |
| `exp` | number | Token expiry (Unix timestamp) |
| `usage_limit` | number | Initial counter value. `-1` = unlimited |
| `api_slug` | string | Available on request context if seller wants to log it |
| `buyer_wallet` | string | Available on request context if seller wants to log it |
| `tier_id` | string | Available on request context |

---

### Error Responses

The SDK returns standardized errors that buyer agents can programmatically react to:

| Situation | HTTP | Body |
|---|---|---|
| No Authorization header | 401 | `{ "error": "missing_token" }` |
| JWT signature invalid | 401 | `{ "error": "invalid_token" }` |
| JWT expired | 401 | `{ "error": "token_expired" }` |
| Usage limit exhausted | 429 | `{ "error": "usage_limit_exceeded" }` |

Both `token_expired` and `usage_limit_exceeded` signal to the buyer agent that it should re-purchase rather than retry the same request.

---

## Onboarding Flow (Seller's Perspective)

### Step 1 — Register on the platform

Via platform API or a seller dashboard (browser):

```http
POST https://platform.com/sellers
{ "name": "OpenWeather Inc", "email": "api@openweather.com" }

← { "seller": { "id": "slr_abc", "status": "pending" } }
```

---

### Step 2 — Connect Stripe

```
Open in browser: https://platform.com/sellers/slr_abc/stripe-connect
→ Stripe OAuth page appears
→ Seller logs into their existing Stripe account
→ Approves "Connect to Agentic Payment Platform"
→ Redirected back, status → "active"
```

The seller's Stripe account now receives payouts. No new Stripe account needed.

---

### Step 3 — Register an API

```http
POST https://platform.com/sellers/slr_abc/apis
{
  "name": "OpenWeather API",
  "slug": "openweather",
  "description": "Real-time and forecast weather data",
  "base_url": "https://api.openweathermap.org/data/2.5",
  "openapi_spec": { ... },
  "pricing_tiers": [
    {
      "id": "tier_starter",
      "label": "Starter",
      "calls": 100,
      "price_usdc": "1.00",
      "validity_seconds": 86400
    },
    {
      "id": "tier_pro",
      "label": "Pro",
      "calls": 1000,
      "price_usdc": "8.00",
      "validity_seconds": 604800
    }
  ]
}

← {
    "api": { "id": "api_xyz", "slug": "openweather" },
    "agent_card_url": "https://platform.com/agents/openweather/agent.json",
    "sdk": {
      "platform_public_key": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...\n-----END PUBLIC KEY-----",
      "install": "npm install @agentic-payment/seller-sdk"
    }
  }
```

The seller copies the `platform_public_key` into their environment.

---

### Step 4 — Install and configure the SDK

```bash
npm install @agentic-payment/seller-sdk
```

Add to backend — **this is the only code change needed**:

```typescript
import { validateToken } from '@agentic-payment/seller-sdk';

app.use('/data/2.5/*', validateToken({
  platformPublicKey: process.env.PLATFORM_PUBLIC_KEY
}));
```

Done. Existing routes are now protected. Any request without a valid platform JWT is rejected.

---

## Integration Examples

### Express

```typescript
import express from 'express';
import { validateToken } from '@agentic-payment/seller-sdk';

const app = express();

app.use(
  '/data/2.5/*',
  validateToken({ platformPublicKey: process.env.PLATFORM_PUBLIC_KEY })
);

app.get('/data/2.5/weather', (req, res) => {
  // req.agenticToken is available with decoded claims
  // { jti, apiSlug, buyerWallet, usageLimit, exp }
  res.json({ temp: 12.5, city: req.query.q });
});
```

---

### Hono

```typescript
import { Hono } from 'hono';
import { validateToken } from '@agentic-payment/seller-sdk/hono';

const app = new Hono();

app.use('/data/2.5/*', validateToken({
  platformPublicKey: process.env.PLATFORM_PUBLIC_KEY
}));

app.get('/data/2.5/weather', (c) => {
  const token = c.get('agenticToken');
  // token.buyerWallet, token.usageLimit, etc.
  return c.json({ temp: 12.5 });
});
```

---

### Fastify

```typescript
import Fastify from 'fastify';
import { fastifyAgenticPayment } from '@agentic-payment/seller-sdk/fastify';

const app = Fastify();

await app.register(fastifyAgenticPayment, {
  platformPublicKey: process.env.PLATFORM_PUBLIC_KEY,
  protectedPrefix: '/data/2.5'
});

app.get('/data/2.5/weather', async (req, reply) => {
  // req.agenticToken available
  return { temp: 12.5 };
});
```

---

### Custom storage — Redis example

```typescript
import { validateToken, TokenStorage } from '@agentic-payment/seller-sdk';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const redisStorage: TokenStorage = {
  async get(jti) {
    const val = await redis.get(`agentic:token:${jti}`);
    if (!val) return null;
    return { remaining: parseInt(val) };
  },

  async set(jti, remaining, expiresAt) {
    const ttl = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    await redis.setex(`agentic:token:${jti}`, ttl, remaining.toString());
  },

  async decrement(jti) {
    const newVal = await redis.decr(`agentic:token:${jti}`);
    return newVal;
  }
};

app.use('/data/2.5/*', validateToken({
  platformPublicKey: process.env.PLATFORM_PUBLIC_KEY,
  storage: redisStorage
}));
```

---

### Custom storage — Postgres example

```typescript
import { validateToken, TokenStorage } from '@agentic-payment/seller-sdk';
import { db } from './db'; // seller's existing db instance

const pgStorage: TokenStorage = {
  async get(jti) {
    const row = await db.query(
      'SELECT remaining FROM agentic_tokens WHERE jti = $1', [jti]
    );
    if (!row.rows[0]) return null;
    return { remaining: row.rows[0].remaining };
  },

  async set(jti, remaining, expiresAt) {
    await db.query(
      'INSERT INTO agentic_tokens (jti, remaining, expires_at) VALUES ($1, $2, $3)',
      [jti, remaining, expiresAt]
    );
  },

  async decrement(jti) {
    const result = await db.query(
      'UPDATE agentic_tokens SET remaining = remaining - 1 WHERE jti = $1 RETURNING remaining',
      [jti]
    );
    return result.rows[0].remaining;
  }
};
```

Required table (seller creates this once):

```sql
CREATE TABLE agentic_tokens (
  jti         text PRIMARY KEY,
  remaining   integer NOT NULL,
  expires_at  timestamptz NOT NULL
);
-- Optional: auto-clean expired tokens
CREATE INDEX ON agentic_tokens (expires_at);
```

---

## SDK Internal Request Flow

```
Incoming request: GET /data/2.5/weather
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

validateToken middleware:

  1. Extract token from Authorization header
       → no header? → 401 { error: "missing_token" }

  2. Verify RS256 signature using platformPublicKey
       → invalid sig? → 401 { error: "invalid_token" }

  3. Check exp claim
       → now > exp? → 401 { error: "token_expired" }

  4. Extract jti and usage_limit from claims

  5. If usage_limit == -1 (unlimited):
       → skip steps 6-9, go straight to step 10

  6. storage.get(jti)
       → null (first time this token is seen):
           storage.set(jti, usage_limit - 1, new Date(exp * 1000))
           attach claims to request context
           → call next()

  7. → { remaining: N } (token seen before):
       if N <= 0:
         → 429 { error: "usage_limit_exceeded" }

  8. storage.decrement(jti)
       → returns new remaining count

  9. Attach decoded claims to request context:
       req.agenticToken = { jti, apiSlug, tierid, usageLimit, buyerWallet, exp }

  10. call next()

Seller route handler executes normally.
```

---

## SDK Package Structure

```
@agentic-payment/seller-sdk
├── index.ts                  # main export: validateToken, TokenStorage
├── hono.ts                   # Hono-specific middleware export
├── fastify.ts                # Fastify plugin export
├── storage/
│   ├── memory.ts             # InMemoryStorage (default)
│   └── redis.ts              # RedisStorage adapter
└── types.ts                  # TokenStorage interface, AgenticTokenClaims
```

---

## What Sellers Get on Each Request (Context)

After `validateToken` passes, the decoded token claims are available on the request context. Sellers can use these for logging, analytics, or custom logic:

```typescript
interface AgenticTokenClaims {
  jti: string;           // unique token ID
  apiSlug: string;       // e.g. "openweather"
  tierId: string;        // e.g. "tier_starter"
  usageLimit: number;    // original limit (-1 = unlimited)
  buyerWallet: string;   // e.g. "0xOpenClawWallet..."
  exp: number;           // expiry timestamp
}
```

Example use — logging per-buyer usage:

```typescript
app.get('/data/2.5/weather', (req, res) => {
  const { buyerWallet, tierId } = req.agenticToken;
  console.log(`Weather request from ${buyerWallet} on tier ${tierId}`);
  // ... existing handler logic
});
```

---

## Seller Checklist

```
□ Register on platform (POST /sellers)
□ Connect Stripe account (GET /sellers/:id/stripe-connect)
□ Upload OpenAPI spec + pricing tiers (POST /sellers/:id/apis)
□ Copy platform_public_key to environment variable
□ npm install @agentic-payment/seller-sdk
□ Add validateToken() middleware to protected routes
□ Choose storage: in-memory (default) or plug in Redis/Postgres
□ Deploy updated backend
□ Share Agent Card URL with buyer agents:
  https://platform.com/agents/{your-api-slug}/agent.json
```
