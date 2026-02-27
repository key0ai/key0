# Agentic API Marketplace — Product Flow

---

## Actors

| Actor | Description |
|---|---|
| **Seller** | An API provider with an existing Stripe account. Wants to sell API access to AI agents. Integrates one middleware into their backend. |
| **Platform** | Our service. Acts as a payment broker and token issuer. Sits between buyer and seller at purchase time only. Not in the hot path of API calls. |
| **OpenClaw (Buyer Agent)** | An autonomous AI agent with a built-in x402 payment module — holds a USDC wallet on Base, can pay on-chain without any human intervention. |

---

## Core Principle

```
Platform is involved exactly twice:
  1. When the seller onboards (once, ever)
  2. When the buyer purchases access (once per session)

After that, buyer ↔ seller directly. Platform is out of the picture.
```

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         PLATFORM                                │
│                                                                 │
│  Seller ──── registers, connects Stripe ──────────────────────► │
│  Seller ──── OpenAPI spec + pricing tiers ────────────────────► │
│              Platform generates Seller Agent Card               │
│              Platform returns JWT signing public key            │
│                                                                 │
│  OpenClaw ── GET /catalog ─────────────────────────────────────► │
│  OpenClaw ── GET /agents/openweather/agent.json ───────────────► │
│  OpenClaw ── POST /purchase/initiate ──────────────────────────► │
│           ◄─ 402 { amount, recipient, purchase_ref } ──────────  │
│  OpenClaw pays USDC on Base                                     │
│  OpenClaw ── POST /purchase/confirm { purchase_ref, tx_hash } ─► │
│              Platform verifies on-chain                         │
│              Platform generates signed JWT token                │
│           ◄─ 200 { token, seller_api_base_url, expires_at } ──  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

After this point, platform is not involved:

OpenClaw ──── GET api.openweathermap.org/data/2.5/weather ───────► Seller API
              Authorization: Bearer <JWT>                          │
              Seller SDK verifies JWT signature (platform pub key) │
              Seller SDK checks + decrements usage counter         │
OpenClaw ◄─── 200 { weather data } ◄───────────────────────────── │
```

---

## Flow 1: Seller Onboarding

### 1.1 — Register

```http
POST /sellers
{ "name": "OpenWeather Inc", "email": "api@openweather.com" }

← { "seller": { "id": "slr_abc", "status": "pending" } }
```

---

### 1.2 — Connect Stripe

```
GET /sellers/slr_abc/stripe-connect
→ redirects to stripe.com/oauth/authorize
→ seller approves in their Stripe dashboard
→ platform saves their Stripe account ID (acct_xxx)
→ seller status → "active"
```

Sellers receive payouts to this Stripe account. They never touch crypto.

---

### 1.3 — Register an API

Seller uploads their OpenAPI spec and defines pricing tiers — bundles of usage with a flat USDC price.

```http
POST /sellers/slr_abc/apis
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
    },
    {
      "id": "tier_unlimited_day",
      "label": "Unlimited Day",
      "calls": -1,
      "price_usdc": "5.00",
      "validity_seconds": 86400
    }
  ]
}
```

Platform responds with everything the seller needs:

```json
{
  "api": { "id": "api_xyz", "slug": "openweather" },
  "agent_card_url": "https://platform.com/agents/openweather/agent.json",
  "sdk": {
    "platform_public_key": "pk_platform_...",
    "install": "npm install @agentic-payment/seller-sdk",
    "docs": "https://platform.com/docs/sdk"
  }
}
```

---

### 1.4 — Integrate the Seller SDK

This is the only code change the seller makes to their existing backend.

```bash
npm install @agentic-payment/seller-sdk
```

```typescript
import { validateToken } from '@agentic-payment/seller-sdk';

// Add to whichever routes should be accessible to paying agents
app.use('/data/2.5/*', validateToken({
  platformPublicKey: 'pk_platform_...'
}));
```

**That's it.** No new endpoints. No webhooks to set up. No secrets to manage.

The `validateToken` middleware:
1. Verifies the JWT signature against the platform's public key
2. Checks the token hasn't expired
3. Initialises a usage counter (from the token's `usage_limit` claim) on first use
4. Decrements the counter on each valid request
5. Returns `429` when the limit is exhausted

**Storage** — by default the SDK uses in-memory storage. Sellers on multi-instance deployments
swap in their own by implementing three methods:

```typescript
interface TokenStorage {
  get(jti: string): Promise<{ remaining: number } | null>;
  set(jti: string, remaining: number, expiresAt: Date): Promise<void>;
  decrement(jti: string): Promise<number>; // returns new remaining count
}
```

```typescript
// Example: using existing Redis instance
import { RedisStorage } from '@agentic-payment/seller-sdk/storage';

app.use('/data/2.5/*', validateToken({
  platformPublicKey: 'pk_platform_...',
  storage: new RedisStorage(redisClient)
}));
```

No new infrastructure required. Seller plugs into whatever they already have.

**Why no platform call is needed for verification:**
The JWT signature is cryptographic proof that the platform issued it. A valid signature against the platform's public key *is* the verification — the same reason you trust a signed certificate without calling the CA on every request.

---

## Flow 2: Buyer Discovery

OpenClaw is looking for a weather API.

### 2.1 — Browse the catalog

```http
GET https://platform.com/catalog

← {
    "apis": [
      {
        "name": "OpenWeather API",
        "slug": "openweather",
        "description": "Real-time and forecast weather data",
        "agent_card_url": "https://platform.com/agents/openweather/agent.json"
      },
      ...
    ]
  }
```

---

### 2.2 — Read the Seller Agent Card

```http
GET https://platform.com/agents/openweather/agent.json

← {
    "@context": "https://a2a.ai/v1/agent-card",
    "name": "OpenWeather API",
    "description": "Real-time and forecast weather data for any location worldwide",
    "provider": "OpenWeather Inc",
    "services": [
      {
        "name": "Current Weather",
        "path": "/weather",
        "method": "GET",
        "description": "Get current weather for a city or coordinates",
        "parameters": ["q", "lat", "lon", "units"]
      },
      {
        "name": "5-Day Forecast",
        "path": "/forecast",
        "method": "GET",
        "description": "5-day forecast in 3-hour intervals"
      },
      {
        "name": "Air Quality",
        "path": "/air_pollution",
        "method": "GET",
        "description": "Current air quality index and components"
      }
    ],
    "pricing_tiers": [
      {
        "id": "tier_starter",
        "label": "Starter",
        "calls": 100,
        "price_usdc": "1.00",
        "validity": "24 hours",
        "per_call_usdc": "0.010"
      },
      {
        "id": "tier_pro",
        "label": "Pro",
        "calls": 1000,
        "price_usdc": "8.00",
        "validity": "7 days",
        "per_call_usdc": "0.008"
      },
      {
        "id": "tier_unlimited_day",
        "label": "Unlimited Day",
        "calls": "unlimited",
        "price_usdc": "5.00",
        "validity": "24 hours"
      }
    ],
    "purchase_endpoint": "https://platform.com/purchase/initiate",
    "seller_api_base_url": "https://api.openweathermap.org/data/2.5"
  }
```

---

### 2.3 — OpenClaw evaluates and selects a tier

OpenClaw reads the Agent Card and runs its internal decision logic:

```
Task at hand: get weather data for 5 cities
Estimated calls needed: ~5–10

Available tiers:
  Starter      → 100 calls / $1.00 / 24h  → $0.010 per call
  Pro          → 1000 calls / $8.00 / 7d  → $0.008 per call
  Unlimited    → unlimited / $5.00 / 24h

Decision: Starter covers the task at the lowest cost. Select tier_starter.
```

No human involved. No negotiation. OpenClaw picks the tier that fits.

---

## Flow 3: Purchase

### 3.1 — Initiate purchase

OpenClaw signals intent to buy. Platform locks in the exact payment amount and creates a pending purchase.

```http
POST https://platform.com/purchase/initiate
{
  "api_slug": "openweather",
  "tier_id": "tier_starter",
  "buyer_wallet": "0xOpenClawWalletAddress"
}

← HTTP 402 Payment Required
  {
    "purchase_ref": "pref_7f3a9b...",
    "payment": {
      "amount_usdc": "1.000000",
      "recipient": "0xPlatformWalletAddress",
      "network": "base",
      "currency": "USDC"
    },
    "expires_in": 300,
    "expires_at": "2026-02-26T10:35:00Z",
    "instructions": "Send exactly 1.000000 USDC to the recipient on Base. Then POST /purchase/confirm with purchase_ref and tx_hash."
  }
```

The `purchase_ref` ties this payment to this specific purchase attempt. It expires in **5 minutes**. If the buyer doesn't confirm within that window, the reference is invalidated and they must initiate again.

---

### 3.2 — OpenClaw pays on-chain

OpenClaw's x402 module reads the payment instructions and autonomously submits a USDC transfer on Base:

```
From:    0xOpenClawWalletAddress
To:      0xPlatformWalletAddress
Amount:  1.000000 USDC
Network: Base

→ Transaction hash: 0xTxHash123...
```

This is fully autonomous. No human approval. Completes in ~2 seconds on Base.

---

### 3.3 — Confirm purchase

```http
POST https://platform.com/purchase/confirm
{
  "purchase_ref": "pref_7f3a9b...",
  "tx_hash": "0xTxHash123...",
  "buyer_wallet": "0xOpenClawWalletAddress"
}
```

Platform performs these checks in order:

```
1. purchase_ref exists and hasn't expired          ✓
2. purchase_ref hasn't already been confirmed      ✓  (replay protection)
3. tx_hash hasn't been used before                 ✓  (replay protection)
4. Fetch tx receipt from Base via viem
   - status: success                               ✓
   - USDC Transfer event to platform wallet        ✓
   - amount ≥ tier price (1.000000 USDC)           ✓
   - from address matches buyer_wallet             ✓
5. All checks passed → generate token
```

---

### 3.4 — Platform generates a signed JWT

```json
{
  "jti": "tok_unique_id_abc",
  "api_id": "api_xyz",
  "api_slug": "openweather",
  "tier_id": "tier_starter",
  "usage_limit": 100,
  "buyer_wallet": "0xOpenClawWalletAddress",
  "iat": 1740564000,
  "exp": 1740650400
}
```

Signed with the platform's private key (RS256). The seller's SDK verifies this signature using the platform's public key — no call to platform needed.

---

### 3.5 — Platform responds to OpenClaw

```http
HTTP 200 OK
{
  "status": "purchased",
  "token": "eyJhbGciOiJSUzI1NiJ9...",
  "tier": { "label": "Starter", "calls": 100, "validity": "24 hours" },
  "expires_at": "2026-02-27T10:30:00Z",
  "usage_limit": 100,
  "seller_api_base_url": "https://api.openweathermap.org/data/2.5",
  "payment": {
    "amount_usdc": "1.000000",
    "tx_hash": "0xTxHash123...",
    "network": "base"
  }
}
```

**Platform's job is done. It steps out of the picture.**

---

## Flow 4: Direct API Usage

OpenClaw calls the seller's API directly using the JWT. Platform is not involved.

### 4.1 — OpenClaw makes API calls

```http
GET https://api.openweathermap.org/data/2.5/weather?q=London&units=metric
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

← 200 { "temp": 12.5, "weather": "Clouds", ... }
```

```http
GET https://api.openweathermap.org/data/2.5/weather?q=Paris&units=metric
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

← 200 { "temp": 9.1, "weather": "Clear", ... }
```

---

### 4.2 — What the seller SDK does on each request

```
Request arrives with JWT
       ↓
Verify JWT signature against platform public key   → invalid sig? 401
       ↓
Check exp claim                                    → expired? 401
       ↓
Look up jti in storage
  → not found: initialise counter = usage_limit (from JWT), save to storage
  → found: use existing counter
       ↓
remaining > 0?  → decrement, allow request        → 200
remaining = 0?  → reject                          → 429 { "error": "usage_limit_exceeded" }
```

The seller's storage (in-memory, Redis, Postgres, etc.) is the only thing that needs to persist between requests. The JWT itself carries the initial state.

### 4.3 — Usage exhausted or token expired

```
Call 1–100:  200 ✓  (counter: 99, 98, 97... 1, 0)
Call 101:    429 { "error": "usage_limit_exceeded" }

Or if 24h window passes before 100 calls:
Any call:    401 { "error": "token_expired" }
```

When either happens, OpenClaw goes back to **Flow 3** and purchases again.

---

## Flow 5: Refund

### When a refund is triggered

A refund is issued automatically if the platform fails to deliver a token after payment is confirmed — i.e., the payment was verified on-chain but an internal platform error prevented the JWT from being generated or returned.

No other scenario triggers an automatic refund. If a buyer's token worked but they didn't use it, or if the seller's API had downtime, that goes through a manual dispute process.

### Refund mechanics

```
Platform detects delivery failure after confirmed payment
       ↓
Platform constructs on-chain USDC transfer:
  From:    0xPlatformWalletAddress
  To:      0xOpenClawWalletAddress  (buyer_wallet from purchase record)
  Amount:  full purchase amount (1.000000 USDC)
  Network: Base
       ↓
Purchase record marked: status = "refunded"
Seller does not receive a payout for this purchase
```

The buyer receives USDC back to their wallet. No credits, no vouchers — same asset, same chain.

---

## Flow 6: Seller Payout

### Schedule

Payouts run daily via a cron job.

### Mechanics

```
Platform tallies all purchases with status = "confirmed" (not refunded)
since the last payout, grouped by seller.

Example:
  Seller: OpenWeather Inc
  Purchases: 47 confirmed in last 24h
  Total USDC collected: $84.00
  Platform fee (15%):   $12.60
  Seller share:         $71.40

Platform converts $71.40 USDC → USD via Stripe USDC on Base settlement
Stripe Connect transfer: $71.40 USD → acct_sellerStripeId
```

Seller sees the deposit in their existing Stripe dashboard and withdraws to their bank as normal. No crypto knowledge required.

**Payout service is built as a swappable interface.** Default implementation uses Stripe USDC on Base settlement. Coinbase off-ramp is available as a fallback if Stripe's USDC settlement is unavailable.

---

## Complete Flow at a Glance

```
SELLER ONBOARDING  (one-time)
──────────────────────────────────────────────────────────────────
Seller  → POST /sellers                     create account
Seller  → GET  /sellers/:id/stripe-connect  connect Stripe via OAuth
Seller  → POST /sellers/:id/apis            upload spec + pricing tiers
Platform   generates Agent Card             /agents/openweather/agent.json
Platform   returns public key               seller adds to SDK config
Seller     npm install + one middleware line done


BUYER PURCHASE  (each time agent needs a new session)
──────────────────────────────────────────────────────────────────
OpenClaw → GET  /catalog                    browse available APIs
OpenClaw → GET  /agents/openweather/        read services + tiers
              agent.json
OpenClaw   evaluates tiers autonomously     picks tier_starter ($1.00)

OpenClaw → POST /purchase/initiate          signal intent
Platform ← 402  { purchase_ref, amount,     exact payment instructions
                  recipient, expires_in:300 }
OpenClaw   sends 1.00 USDC on-chain         → tx_hash: 0xAbc...
OpenClaw → POST /purchase/confirm           { purchase_ref, tx_hash, buyer_wallet }
Platform   verifies on-chain               amount ✓  recipient ✓  not-replayed ✓
Platform   generates signed JWT             { usage_limit:100, exp:+24h, jti:tok_xyz }
Platform ← 200  { token, seller_api_base_url, expires_at }


DIRECT API USAGE  (platform not involved)
──────────────────────────────────────────────────────────────────
OpenClaw → GET api.openweather.com/…        Authorization: Bearer <JWT>
Seller SDK verifies signature               platform public key ✓
Seller SDK checks + decrements counter      99 remaining
Seller API ← 200 { weather data }          direct to OpenClaw

[repeats until usage_limit=0 or exp reached, then back to PURCHASE]


REFUND  (only on platform delivery failure)
──────────────────────────────────────────────────────────────────
Platform   detects token delivery failure
Platform   sends USDC back on-chain         → buyer_wallet
Purchase   marked refunded                  excluded from seller payout


SELLER PAYOUT  (daily)
──────────────────────────────────────────────────────────────────
Platform   tallies confirmed purchases per seller
Platform   converts USDC → USD              Stripe USDC on Base (Coinbase fallback)
Platform → Stripe Connect transfer          seller receives 85% in their Stripe account
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Two-step purchase (initiate → confirm)** | Platform locks in the exact amount before payment. Prevents over/under payment errors. Creates a traceable pending record for refunds. |
| **5-minute purchase window** | Long enough for Base block confirmation (~2s) plus any wallet latency. Short enough to prevent stale payment references being abused. |
| **Platform-generated JWT, seller verifies** | Seller SDK is one middleware line. No token endpoint, no webhook, no secrets to manage. Cryptographic signature replaces any runtime call to the platform. |
| **Pluggable storage interface (3 methods)** | Sellers control their own storage. SDK works out of the box with in-memory. Production deployments plug in Redis or Postgres they already operate. No new infrastructure mandated. |
| **Platform not in API call path** | After purchase, buyer ↔ seller directly. Platform adds zero latency to actual API calls. Cannot become a bottleneck regardless of call volume. |
| **Tier-based pricing, not per-call** | One USDC payment per session. No repeated micro-transactions. Predictable cost for buyer, predictable revenue for seller. |
| **USDC → USD via Stripe, fiat payout to sellers** | Sellers use Stripe already. No crypto knowledge required on seller side. Stripe's USDC on Base settlement handles conversion transparently. |
| **Auto-refund on delivery failure only** | Clear, unambiguous policy. Everything the platform can control (token generation, delivery) is covered. Usage disputes are between buyer and seller. |
```
