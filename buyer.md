# Buyer Agent — System Design & Request Flow

> This document specifies what any buyer agent (e.g. OpenClaw) must implement to
> discover, purchase, and consume APIs on the platform. The platform does not build
> the buyer agent — this is the integration contract.

---

## Role

The buyer agent is a fully autonomous AI agent that:
- Holds a USDC wallet on Base network
- Can submit on-chain transactions without human approval
- Discovers APIs via the platform catalog and Agent Cards
- Purchases access using x402 (one USDC payment per session)
- Calls the seller's API directly using a short-lived JWT

---

## System Design

### Components

```
┌─────────────────────────────────────────────────────┐
│                   BUYER AGENT                       │
│                                                     │
│  ┌─────────────┐   ┌──────────────┐                 │
│  │  Discovery  │   │    Wallet    │                 │
│  │  Module     │   │   (USDC on   │                 │
│  │             │   │    Base)     │                 │
│  └──────┬──────┘   └──────┬───────┘                 │
│         │                 │                         │
│  ┌──────▼──────┐   ┌──────▼───────┐                 │
│  │  Tier       │   │   Purchase   │                 │
│  │  Evaluator  │──►│   Module     │                 │
│  └─────────────┘   └──────┬───────┘                 │
│                           │                         │
│                    ┌──────▼───────┐                 │
│                    │    Token     │                 │
│                    │    Store     │                 │
│                    └──────┬───────┘                 │
│                           │                         │
│                    ┌──────▼───────┐                 │
│                    │  API Client  │                 │
│                    └─────────────┘                 │
└─────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Responsibility |
|---|---|
| **Discovery** | Fetch catalog, read Agent Cards, surface available APIs |
| **Tier Evaluator** | Given a task, pick the best tier (calls needed vs price vs validity) |
| **Wallet** | Hold USDC private key, sign and submit on-chain transactions |
| **Purchase Module** | Orchestrate the full initiate → pay → confirm flow |
| **Token Store** | Persist active tokens keyed by `api_slug`, track `usage_remaining` and `expires_at` |
| **API Client** | Make HTTP requests to seller APIs with `Authorization: Bearer <jwt>` header |

---

### Token Store Schema

The buyer must persist active tokens across calls. Minimum required fields:

```typescript
interface ActiveToken {
  apiSlug: string;            // e.g. "openweather"
  token: string;              // raw JWT string
  sellerApiBaseUrl: string;   // e.g. "https://api.openweathermap.org/data/2.5"
  expiresAt: Date;
  usageLimit: number;         // -1 = unlimited
  usageRemaining: number;
  purchaseRef: string;        // for audit / support
  txHash: string;             // on-chain payment proof
}
```

Lookup key: `apiSlug`. Before making any API call, the agent checks the store for a
valid, non-exhausted token for that API.

---

### Wallet Requirements

- Private key stored securely (env var, secrets manager, HSM)
- Capable of signing and broadcasting ERC-20 USDC transfer transactions on Base
- Must be able to send exact USDC amounts (6 decimal precision)
- Sufficient USDC balance to cover purchases (agent operator is responsible for topping up)

---

## Request Flows

### Flow A: Discovery

Run once on startup or when looking for a new API type.

```
1. Fetch catalog
   GET https://platform.com/catalog

   Response:
   {
     "apis": [
       {
         "name": "OpenWeather API",
         "slug": "openweather",
         "description": "Real-time and forecast weather data",
         "agent_card_url": "https://platform.com/agents/openweather/agent.json"
       }
     ]
   }

2. Fetch Agent Card for relevant API
   GET https://platform.com/agents/openweather/agent.json

   Response: (see platform.md for full Agent Card schema)
   {
     "services": [ ... ],
     "pricing_tiers": [ ... ],
     "purchase_endpoint": "https://platform.com/purchase/initiate",
     "seller_api_base_url": "https://api.openweathermap.org/data/2.5"
   }

3. Cache Agent Card locally (TTL: 1 hour or until purchase needed)
```

---

### Flow B: Tier Evaluation

Run when a purchase is needed. Agent evaluates tiers against its current task.

```
Inputs:
  - estimated_calls: int         (how many calls this task needs)
  - budget_usdc: float           (max agent is willing to spend)
  - pricing_tiers: Tier[]        (from Agent Card)

Logic:
  For each tier:
    if tier.calls == -1 (unlimited):
      effective_per_call = tier.price_usdc / estimated_calls  ← estimate only
    else:
      if tier.calls < estimated_calls: skip (not enough)
      effective_per_call = tier.price_usdc / tier.calls

  Filter: tier.price_usdc <= budget_usdc
  Sort by: effective_per_call ascending
  Pick: first (cheapest per call that covers the task)

Example:
  estimated_calls = 8
  Starter  (100 calls, $1.00) → $0.010/call  ← covers task, cheapest → PICK
  Pro     (1000 calls, $8.00) → $0.008/call  ← covers task but overkill
  Unlimited ($5.00/24h)       → $0.625/call estimate → expensive for 8 calls
```

---

### Flow C: Purchase (Initiate → Pay → Confirm)

Run when no valid token exists for the target API.

```
Step 1 — Initiate

  POST https://platform.com/purchase/initiate
  Content-Type: application/json
  {
    "api_slug": "openweather",
    "tier_id": "tier_starter",
    "buyer_wallet": "0xAgentWalletAddress"
  }

  Response: HTTP 402
  {
    "purchase_ref": "pref_7f3a9b...",
    "payment": {
      "amount_usdc": "1.000000",
      "recipient": "0xPlatformWalletAddress",
      "network": "base",
      "currency": "USDC"
    },
    "expires_at": "2026-02-26T10:35:00Z"
  }

  Agent stores purchase_ref and notes expiry (5 minutes).


Step 2 — Pay on-chain

  Agent constructs USDC transfer transaction:
    contract:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (USDC on Base)
    method:    transfer(address to, uint256 amount)
    to:        0xPlatformWalletAddress
    amount:    1_000_000  (1.00 USDC, 6 decimals)
    from:      0xAgentWalletAddress

  Agent signs with wallet private key and broadcasts.
  Waits for transaction receipt (Base ~2 second block time).
  Extracts tx_hash from receipt.


Step 3 — Confirm

  POST https://platform.com/purchase/confirm
  Content-Type: application/json
  {
    "purchase_ref": "pref_7f3a9b...",
    "tx_hash": "0xTxHash123...",
    "buyer_wallet": "0xAgentWalletAddress"
  }

  Response: HTTP 200
  {
    "status": "purchased",
    "token": "eyJhbGciOiJSUzI1NiJ9...",
    "tier": { "label": "Starter", "calls": 100 },
    "expires_at": "2026-02-27T10:30:00Z",
    "usage_limit": 100,
    "seller_api_base_url": "https://api.openweathermap.org/data/2.5",
    "payment": {
      "amount_usdc": "1.000000",
      "tx_hash": "0xTxHash123...",
      "network": "base"
    }
  }

  Agent saves to Token Store:
  {
    apiSlug: "openweather",
    token: "eyJ...",
    sellerApiBaseUrl: "https://api.openweathermap.org/data/2.5",
    expiresAt: new Date("2026-02-27T10:30:00Z"),
    usageLimit: 100,
    usageRemaining: 100,
    purchaseRef: "pref_7f3a9b...",
    txHash: "0xTxHash123..."
  }
```

---

### Flow D: API Call

Run for every actual API request to the seller.

```
Step 1 — Check Token Store

  Look up token for "openweather"
  Checks:
    a. Token exists                     → if not: run Flow C (purchase)
    b. expiresAt > now                  → if not: run Flow C (purchase)
    c. usageRemaining > 0               → if not: run Flow C (purchase)
       OR usageLimit == -1 (unlimited)

Step 2 — Make API call

  GET https://api.openweathermap.org/data/2.5/weather?q=London&units=metric
  Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

  Seller SDK validates the JWT and enforces limits server-side.

Step 3 — Handle response

  HTTP 200 → success
    Decrement usageRemaining in Token Store by 1
    Return response data to agent task

  HTTP 401 → token invalid or expired
    Remove token from Token Store
    Run Flow C (purchase) then retry

  HTTP 429 → usage limit exceeded (seller's SDK enforced)
    Remove token from Token Store
    Run Flow C (purchase) then retry

  HTTP 4xx/5xx → seller API error, do not consume usage
    Surface error to agent task logic
```

---

### Flow E: Re-purchase

Triggered automatically when a token is expired, exhausted, or rejected.

```
Token Store lookup fails (expired / exhausted / not found)
       ↓
Run Flow B (tier evaluation) with fresh Agent Card data
       ↓
Run Flow C (purchase)
       ↓
Retry original API call (Flow D)
```

---

## Error Handling

| Error | Action |
|---|---|
| `purchase/initiate` returns non-402 error | Log, retry after backoff, alert operator after 3 failures |
| `purchase_ref` expired before confirm (>5 min) | Discard ref, re-run Flow C from Step 1 |
| On-chain tx fails (insufficient balance, reverted) | Do not call `/purchase/confirm`. Alert operator: insufficient USDC balance. |
| `purchase/confirm` returns 400 (payment mismatch) | Log tx_hash and amount, alert operator |
| Seller API returns 401 | Clear token, re-purchase |
| Seller API returns 429 | Clear token, re-purchase |
| Seller API returns 503 | Retry with backoff, do not re-purchase |

---

## Security Notes

- **Private key** must never appear in logs or be sent to any endpoint
- **Token** is a bearer credential — store in memory only, not on disk
- **purchase_ref** is single-use — never retry a confirm with an already-used ref
- **tx_hash** is single-use on the platform — do not reuse for multiple purchases
