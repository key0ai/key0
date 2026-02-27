# Platform — System Design & Request Flow

> This document covers the platform backend — the service we build and operate.
> It handles seller onboarding, Agent Card generation, purchase orchestration,
> JWT issuance, refunds, and seller payouts.

---

## Role

The platform:
- Onboards sellers and connects their Stripe accounts
- Stores OpenAPI specs, generates per-seller Agent Cards
- Orchestrates the purchase flow (initiate → verify on-chain → issue JWT)
- Runs daily payouts to sellers via Stripe Connect
- Issues on-chain USDC refunds on delivery failure

The platform is **not** in the hot path of API calls. After a token is issued, buyer and seller communicate directly.

---

## System Design

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         PLATFORM                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                      Hono HTTP API                        │    │
│  │  /sellers  /catalog  /agents  /purchase  /webhooks       │    │
│  └───────────────────────────┬──────────────────────────────┘    │
│                              │                                   │
│         ┌────────────────────┼───────────────────┐              │
│         │                    │                   │              │
│  ┌──────▼──────┐   ┌─────────▼──────┐   ┌───────▼──────┐       │
│  │  Purchase   │   │  Seller        │   │  Payout      │       │
│  │  Service    │   │  Service       │   │  Service     │       │
│  └──────┬──────┘   └─────────┬──────┘   └───────┬──────┘       │
│         │                    │                   │              │
│  ┌──────▼──────┐   ┌─────────▼──────┐   ┌───────▼──────┐       │
│  │  x402       │   │  OpenAPI       │   │  Stripe      │       │
│  │  Verifier   │   │  Parser        │   │  Service     │       │
│  └──────┬──────┘   └────────────────┘   └──────────────┘       │
│         │                                                        │
│  ┌──────▼──────┐                                                 │
│  │  JWT        │                                                 │
│  │  Issuer     │                                                 │
│  └─────────────┘                                                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐      │
│  │                    PostgreSQL                           │      │
│  │   sellers · apis · api_endpoints · pricing_tiers       │      │
│  │   purchases                                            │      │
│  └────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
                    │                        │
              Base network             Stripe API
              (viem — tx verify,       (Connect OAuth,
               USDC refund)             USDC settlement,
                                        Connect transfer)
```

---

### Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| Framework | Hono |
| Database | PostgreSQL + Drizzle ORM |
| Chain interaction | viem (Base / Base Sepolia) |
| JWT signing | jose (RS256 — asymmetric, public key shared with sellers) |
| Payments (seller payout) | Stripe SDK v17+ |
| Cron | Bun's built-in scheduler |

---

### Database Schema

```sql
-- Sellers registered on the platform
sellers
  id                  uuid PK
  name                text NOT NULL
  email               text NOT NULL UNIQUE
  stripe_connect_id   text                     -- set after Stripe Connect OAuth
  status              enum(pending,active,suspended) DEFAULT pending
  created_at          timestamptz DEFAULT now()

-- APIs registered by sellers
apis
  id                  uuid PK
  seller_id           uuid FK → sellers.id
  name                text NOT NULL
  slug                text NOT NULL UNIQUE      -- URL-safe identifier, e.g. "openweather"
  description         text
  base_url            text NOT NULL             -- seller's real API base URL
  openapi_spec        jsonb                     -- full OpenAPI 3.1 spec
  status              enum(draft,active,inactive) DEFAULT draft
  created_at          timestamptz DEFAULT now()

-- Endpoints extracted from OpenAPI spec (used for Agent Card services list)
api_endpoints
  id                  uuid PK
  api_id              uuid FK → apis.id
  path                text NOT NULL             -- e.g. /weather
  method              text NOT NULL             -- GET, POST, etc.
  description         text
  created_at          timestamptz DEFAULT now()

-- Pricing tiers defined by seller
pricing_tiers
  id                  uuid PK
  api_id              uuid FK → apis.id
  external_id         text NOT NULL             -- seller-defined, e.g. "tier_starter"
  label               text NOT NULL
  calls               integer NOT NULL          -- -1 = unlimited
  price_usdc_micro    integer NOT NULL          -- 1_000_000 = $1.00 USDC
  validity_seconds    integer NOT NULL
  created_at          timestamptz DEFAULT now()

-- One row per purchase attempt (pending → confirmed or failed)
purchases
  id                  uuid PK
  api_id              uuid FK → apis.id
  tier_id             uuid FK → pricing_tiers.id
  buyer_wallet        text NOT NULL             -- on-chain identity of buyer
  purchase_ref        text NOT NULL UNIQUE      -- nonce, expires in 5 min
  ref_expires_at      timestamptz NOT NULL
  tx_hash             text UNIQUE               -- set on confirm, replay protection
  token_jti           text                      -- JWT id of issued token
  token_expires_at    timestamptz
  status              enum(pending,confirmed,failed,refunded) DEFAULT pending
  created_at          timestamptz DEFAULT now()
```

---

### JWT Token Format

Platform signs tokens with RS256 (RSA private key). Public key is given to sellers at API registration time and embedded in the SDK.

```json
Header: { "alg": "RS256", "typ": "JWT" }

Payload:
{
  "jti":           "tok_abc123",           // unique token ID, used as storage key by seller SDK
  "iss":           "agentic-payment",
  "api_id":        "api_xyz789",
  "api_slug":      "openweather",
  "tier_id":       "tier_starter",
  "usage_limit":   100,                    // -1 for unlimited
  "buyer_wallet":  "0xOpenClawWallet...",
  "iat":           1740564000,
  "exp":           1740650400              // iat + validity_seconds
}

Signed with: RS256 (platform's RSA private key, 2048-bit minimum)
```

---

### Key Management

```
Platform holds:  RSA private key  (PLATFORM_JWT_PRIVATE_KEY env var, PEM format)
Sellers receive: RSA public key   (returned at API registration, embedded in SDK)

Private key never leaves platform.
Public key is safe to distribute — it can only verify, not sign.
```

---

### Services

#### Purchase Service
Orchestrates the full initiate → verify → issue flow.

```
initiate(apiSlug, tierId, buyerWallet)
  → validate tier exists and API is active
  → create purchase row (status: pending, ref_expires_at: now+5min)
  → return 402 with purchase_ref + payment instructions

confirm(purchaseRef, txHash, buyerWallet)
  → validate purchase_ref exists and not expired
  → validate purchase_ref not already confirmed
  → validate txHash not already used (replay check)
  → call x402Verifier.verify(txHash, expectedAmount, buyerWallet)
  → generate JWT via JwtIssuer.sign(claims)
  → update purchase row (status: confirmed, tx_hash, token_jti, token_expires_at)
  → return token + seller_api_base_url
```

#### x402 Verifier
Reads on-chain USDC transfer events via viem.

```
verify(txHash, expectedAmountUsdcMicro, fromAddress)
  → getTransactionReceipt(txHash)
  → check receipt.status == success
  → iterate logs for USDC contract address
  → find Transfer event where to == platformWallet
  → sum all matching transfer amounts
  → check total >= expectedAmountUsdcMicro
  → check from address matches buyerWallet (optional, extra safety)
  → return { valid: boolean, actualAmount: number, error?: string }
```

#### JWT Issuer
Signs and returns a JWT using the platform's RSA private key.

```
sign(claims: JwtClaims)
  → generate jti = "tok_" + uuid()
  → set iat = now, exp = now + validity_seconds
  → sign with RS256 private key via jose
  → return { token: string, jti: string, expiresAt: Date }
```

#### Stripe Service
Handles Stripe Connect OAuth and seller payouts.

```
getConnectOAuthUrl(sellerId)       → Stripe Connect redirect URL
exchangeConnectCode(code)          → { stripeAccountId }
transferToSeller(amountUsd, acct)  → Stripe Transfer object
```

#### Payout Service (cron, daily)
Aggregates confirmed purchases per seller, converts USDC → USD via Stripe, transfers to connected accounts.

```
runPayouts()
  → query purchases WHERE status=confirmed AND payout_processed=false
  → group by seller
  → for each seller:
      totalUsdcMicro = sum(tier.price_usdc_micro)
      platformFee    = totalUsdcMicro * 0.15
      sellerShare    = totalUsdcMicro * 0.85
      convert sellerShare USDC → USD via Stripe USDC on Base settlement
      stripe.transferToSeller(sellerShareUsd, seller.stripeConnectId)
      mark purchases as payout_processed=true
```

#### Refund Service
Triggered when token delivery fails after payment confirmation.

```
refund(purchaseId)
  → load purchase (must be status=confirmed, token not yet delivered)
  → construct USDC transfer: platform wallet → buyer_wallet, full tier amount
  → broadcast on-chain via viem wallet client
  → update purchase status = refunded
  → ensure purchase is excluded from payout aggregation
```

---

## API Routes

### Seller Routes

```
POST   /sellers
       Body: { name, email }
       → creates seller (status: pending)
       ← { seller: { id, name, email, status } }

GET    /sellers/:id/stripe-connect
       → redirects to Stripe Connect OAuth URL
       ← 302 redirect

GET    /sellers/stripe-callback?code=&state=
       → exchanges code for Stripe account ID
       → updates seller.stripe_connect_id, status = active
       ← { message, seller }

POST   /sellers/:id/apis
       Body: { name, slug, description, base_url, openapi_spec, pricing_tiers[] }
       → parses OpenAPI spec → inserts api_endpoints rows
       → inserts pricing_tiers rows
       → sets api.status = active
       ← { api, agent_card_url, sdk: { platform_public_key } }

GET    /sellers/:id/apis
       ← { apis: [ { ...api, tiers, endpoints } ] }
```

---

### Catalog Routes

```
GET    /catalog
       ← {
            apis: [
              {
                slug, name, description,
                tier_count, min_price_usdc,
                agent_card_url
              }
            ]
          }

GET    /catalog/:slug
       ← {
            api: { id, slug, name, description, base_url },
            tiers: [ { id, external_id, label, calls, price_usdc, validity_seconds } ],
            endpoints: [ { path, method, description } ],
            agent_card_url
          }
```

---

### Agent Card Route

```
GET    /agents/:slug/agent.json
       → generates Agent Card from stored api + tiers + endpoints data
       ← {
            "@context": "https://a2a.ai/v1/agent-card",
            name, description, provider,
            services: [ { name, path, method, description, parameters } ],
            pricing_tiers: [ { id, label, calls, price_usdc, validity, per_call_usdc } ],
            payment: {
              protocol: "x402",
              currency: "USDC",
              network: "base",
              platform_address: "0xPlatformWallet",
              purchase_endpoint: "https://platform.com/purchase/initiate"
            },
            seller_api_base_url
          }
```

---

### Purchase Routes

```
POST   /purchase/initiate
       Body: { api_slug, tier_id, buyer_wallet }

       Validations:
         - api exists and is active
         - tier belongs to that api
         - buyer_wallet is a valid EVM address

       Creates: purchases row (status: pending, ref_expires_at: now+5min)

       ← HTTP 402
         {
           purchase_ref: "pref_...",
           payment: {
             amount_usdc: "1.000000",
             recipient: "0xPlatformWallet",
             network: "base",
             currency: "USDC"
           },
           expires_at: "...",
           expires_in: 300
         }


POST   /purchase/confirm
       Body: { purchase_ref, tx_hash, buyer_wallet }

       Validations:
         1. purchase_ref exists
         2. purchase_ref not expired (ref_expires_at > now)
         3. purchase_ref status == pending (not already confirmed)
         4. tx_hash not already used in any purchase
         5. On-chain verification (see x402 Verifier)

       On success:
         - Generate JWT (RS256)
         - Update purchase row (status: confirmed, tx_hash, token_jti, token_expires_at)

       ← HTTP 200
         {
           status: "purchased",
           token: "eyJ...",
           tier: { label, calls, validity },
           expires_at: "...",
           usage_limit: 100,
           seller_api_base_url: "https://...",
           payment: { amount_usdc, tx_hash, network }
         }

       On failure (any validation):
         ← HTTP 400 { error: "...", code: "..." }
         Error codes:
           ref_not_found, ref_expired, ref_already_used,
           tx_already_used, payment_insufficient, payment_not_found
```

---

### Webhook Route

```
POST   /webhooks/stripe
       Stripe-Signature: <sig>
       Body: raw Stripe event payload

       Handled events:
         account.updated → update seller stripe_connect_id or status if needed

       All events acknowledged with 200 { received: true }
```

---

## Request Flow: Purchase (Internal Detail)

```
POST /purchase/initiate
  ├── validate api_slug → load api (404 if not found or inactive)
  ├── validate tier_id → load tier (400 if not found or wrong api)
  ├── validate buyer_wallet (basic EVM address format check)
  ├── generate purchase_ref = "pref_" + uuid()
  ├── INSERT purchases (pending, ref_expires_at = now + 300s)
  └── return 402 with payment instructions


POST /purchase/confirm
  ├── load purchase by purchase_ref
  │     → 400 ref_not_found if missing
  ├── check ref_expires_at > now
  │     → 400 ref_expired if not
  ├── check purchase.status == "pending"
  │     → 400 ref_already_used if not
  ├── check no other purchase has this tx_hash
  │     → 400 tx_already_used if found
  ├── call x402Verifier.verify(tx_hash, tier.price_usdc_micro, buyer_wallet)
  │     → 400 payment_insufficient | payment_not_found if fails
  ├── call JwtIssuer.sign({
  │       api_id, api_slug, tier_id: tier.external_id,
  │       usage_limit: tier.calls,
  │       buyer_wallet,
  │       exp: now + tier.validity_seconds
  │     })
  ├── UPDATE purchases SET
  │       status = confirmed,
  │       tx_hash = ...,
  │       token_jti = ...,
  │       token_expires_at = ...
  ├── [if update or JWT signing fails → trigger refund flow]
  └── return 200 with token + seller_api_base_url


REFUND (triggered on delivery failure)
  ├── load purchase (must be confirmed, token_jti just set)
  ├── load tier → get price_usdc_micro
  ├── construct viem walletClient with platform private key
  ├── call USDC contract transfer(buyer_wallet, price_usdc_micro)
  ├── wait for receipt
  ├── UPDATE purchases SET status = refunded
  └── log refund tx_hash for audit
```

---

## Error Response Format

All errors follow this shape:

```json
{
  "error": "human readable message",
  "code": "machine_readable_code",
  "details": { }
}
```

Standard error codes:

| Code | HTTP | Meaning |
|---|---|---|
| `ref_not_found` | 400 | purchase_ref doesn't exist |
| `ref_expired` | 400 | 5-minute window passed |
| `ref_already_used` | 400 | purchase already confirmed |
| `tx_already_used` | 400 | tx_hash used in another purchase |
| `payment_not_found` | 400 | No USDC transfer found in tx |
| `payment_insufficient` | 400 | Transfer amount less than tier price |
| `api_not_found` | 404 | API slug doesn't exist or inactive |
| `tier_not_found` | 404 | Tier doesn't belong to this API |
| `seller_not_found` | 404 | Seller ID doesn't exist |
| `slug_taken` | 409 | API slug already registered |
| `internal_error` | 500 | Unexpected platform error |

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://localhost/agentic_payment

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_CLIENT_ID=ca_...

# JWT signing (RS256)
PLATFORM_JWT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
PLATFORM_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."

# x402 / on-chain
PLATFORM_WALLET_PRIVATE_KEY=0x...
X402_NETWORK=base                  # or base-sepolia for testnet

# Platform
PLATFORM_URL=https://platform.com
PLATFORM_FEE_PERCENT=15
PORT=3000
```

---

## Directory Structure

```
src/
├── index.ts                    # Hono app entry, route mounting
├── routes/
│   ├── sellers.ts              # POST /sellers, Stripe Connect
│   ├── catalog.ts              # GET /catalog, GET /catalog/:slug
│   ├── agent-card.ts           # GET /agents/:slug/agent.json
│   ├── purchase.ts             # POST /purchase/initiate|confirm
│   └── webhooks.ts             # POST /webhooks/stripe
├── services/
│   ├── x402.ts                 # on-chain USDC verification + refund
│   ├── jwt.ts                  # RS256 sign + verify
│   ├── stripe.ts               # Connect OAuth, USDC settlement, transfers
│   ├── openapi-parser.ts       # OpenAPI spec → endpoint list
│   └── agent-card-builder.ts   # api + tiers + endpoints → Agent Card JSON
├── cron/
│   └── payouts.ts              # daily seller payout job
└── db/
    ├── schema.ts               # Drizzle table definitions
    ├── index.ts                # connection pool
    └── migrations/
```
