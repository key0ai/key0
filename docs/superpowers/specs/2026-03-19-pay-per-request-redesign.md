# Pay-Per-Request Redesign Spec

**Date:** 2026-03-19
**Branch:** feat/pay-per-request
**Status:** Draft

---

## Overview

The current `feat/pay-per-request` branch introduces pay-per-request billing but with a config shape that conflates two separate concepts: subscription plans and priced API routes. This spec redesigns the config surface, adds transparent HTTP proxy support for brownfield sellers, and ensures all routes (paid and free) are accessible via HTTP, A2A, and MCP — with full discovery. It also updates the Docker setup UI (dashboard) to expose these concepts intuitively.

### Goals

- Routes and plans are separate top-level concepts in `SellerConfig`
- Brownfield sellers can add Key0 in front of an existing API with minimal backend changes — existing API response shapes are preserved exactly (no wrapper)
- Every route is accessible via HTTP (transparent proxy), A2A (`/x402/access`), and MCP
- Discovery exposes the full API spec (routes and plans) so agent clients can find and call any endpoint
- `fetchResourceCredentials` is only required when subscription plans exist
- The Docker setup UI makes it intuitive to configure both routes and plans
- No breaking changes to the subscription flow

### Non-Goals

- Per-route timeout configuration (future work)
- HMAC-signed payment headers (future work)
- Dynamic route discovery from backend OpenAPI specs
- Dashboard authentication (existing security model unchanged — `/setup` is Docker-internal only)

---

## Config API Changes

### `Plan` — Subscription-only

Plans become purely subscription-focused. All PPR/proxy/free fields are removed.

```typescript
type Plan = {
  planId: string;
  unitAmount: string;       // required — subscription price
  description?: string;
};
```

**Removed from Plan:** `mode`, `free`, `proxyPath`, `proxyMethod`, `proxyQuery`, `routes`

### `Route` — New type

A `Route` is a priced (or free) API endpoint that Key0 exposes via transparent proxy, A2A, and MCP.

```typescript
type Route = {
  routeId: string;                                           // stable identifier used in discovery + A2A/MCP calls
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;                                             // Express-style :param (e.g. "/api/weather/:city")
  unitAmount?: string;                                      // omit for free routes
  description?: string;
};
```

A route with no `unitAmount` is free — no payment required, proxied directly.

### `SellerConfig` — Updated

`fetchResource` (the programmatic proxy callback from the current branch) is removed. `proxyTo` is the only proxy mechanism when using the gateway mode. Sellers who need custom routing logic should handle it in their backend behind the proxy.

```typescript
type SellerConfig = {
  agentName: string;
  walletAddress: `0x${string}`;
  network: "mainnet" | "testnet";
  basePath?: string;                                         // default "/agent"

  plans?: Plan[];                                           // subscription tiers (optional)
  routes?: Route[];                                         // per-request + free endpoints (optional)

  fetchResourceCredentials?: FetchResourceCredentialsFn;   // required only when plans is non-empty
  proxyTo?: ProxyToConfig;                                  // required when routes is non-empty

  // ... existing optional fields (redis, rpcUrl, gasWalletPrivateKey, etc.)
};
```

**Validation rules (enforced at startup):**
- If `plans` is non-empty → `fetchResourceCredentials` is required
- If `routes` is non-empty → `proxyTo` is required
- If both are absent → warn and proceed (developer mode / health-check only)

### `ProxyToConfig` — Unchanged

```typescript
type ProxyToConfig = {
  baseUrl: string;
  headers?: Record<string, string>;     // static headers added to every proxied request
  proxySecret?: string;                 // injected as x-key0-internal-token header
};
```

### `ResourceResponse` type — Updated

`planId` becomes optional (only present for subscription flows); `routeId` is added for route flows.

```typescript
type ResourceResponse = {
  type: "ResourceResponse";
  challengeId: string;
  requestId: string;
  planId?: string;       // present for subscription access grants
  routeId?: string;      // present for route-based calls
  txHash?: `0x${string}`; // absent for free routes
  explorerUrl?: string;   // absent for free routes
  resource: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
};
```

---

## Behavior

### Transparent HTTP Proxy

When `routes` is configured, Key0 auto-mounts each route at its declared `method` + `path` on the same server at startup. The seller registers no additional routes manually.

The transparent proxy forwards the matched Express path (with parameters already substituted) to `proxyTo.baseUrl`. For example, a request to `GET /api/weather/london` matching route `GET /api/weather/:city` is forwarded to `{baseUrl}/api/weather/london` verbatim. Query parameters from the original request are forwarded unchanged.

**Paid route flow:**
1. Request arrives at e.g. `GET /api/weather/london`
2. No `PAYMENT-SIGNATURE` header → respond `402 Payment Required` with requirements
3. Valid `PAYMENT-SIGNATURE` → settle on-chain → proxy to `proxyTo.baseUrl + matched path` → return backend response body and headers **unchanged**
4. Backend non-2xx → initiate refund → return backend error status + body **unchanged**

**Free route flow:**
1. Request arrives at e.g. `GET /health`
2. Proxy directly to `proxyTo.baseUrl + matched path` → return backend response unchanged

The backend response is **never wrapped** for transparent proxy routes. Status code, headers, and body pass through exactly as received from the backend.

**Headers added to the upstream request (transparent proxy only):**
- `x-key0-internal-token` — if `proxySecret` is set; use this in the backend to verify the request came through Key0
- `x-key0-tx-hash`, `x-key0-route-id`, `x-key0-amount`, `x-key0-payer` — on paid routes only (informational; not tamper-proof, do not use for trust decisions)

### A2A and MCP Access

All routes — paid and free — are also accessible via `POST /x402/access` and MCP tools. The behavior is identical to the transparent proxy (same settlement, same backend call) but the response is wrapped in `ResourceResponse` for protocol compatibility.

**A2A request shape for routes:**
```json
{
  "routeId": "weather",
  "resource": { "method": "GET", "path": "/api/weather/london" }
}
```

`/x402/access` continues to accept `planId` for subscription flows unchanged. It now also accepts `routeId` for route flows. Exactly one of `planId` or `routeId` must be present.

**A2A response for paid routes:**
```json
{
  "type": "ResourceResponse",
  "challengeId": "...",
  "requestId": "...",
  "routeId": "weather",
  "txHash": "0x...",
  "explorerUrl": "...",
  "resource": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "temp": 72 }
  }
}
```

For free routes, `txHash` and `explorerUrl` are absent. For backend non-2xx responses via A2A: refund is initiated, and the backend error is surfaced inside `resource` (status + body from backend unchanged).

**A2A agent card skills:**
- Skill `id: "discover-plans"`, `name: "Discover Plans"` → `id: "discover"`, `name: "Discover"`
- Skill `id: "request-access"`, `name: "Request Access"` → `id: "access"`, `name: "Access"`
- All skill descriptions and examples referencing `${baseUrl}/discovery` → `${baseUrl}/discover`
- Per-request route skills: `id` prefix `ppr-<planId>-` → `ppr-<routeId>-` (reflects route/plan split)

**MCP tools:**
- `discover_plans` → renamed to `discover` — returns both plans and routes
- `request_access` → renamed to `access` — handles both `planId` (subscription) and `routeId` (route); exactly one required

### Error Pass-Through Contract

| Access path | Backend 2xx | Backend non-2xx | Settlement after error |
|---|---|---|---|
| HTTP transparent proxy | Pass through unchanged | Pass through unchanged | Refund initiated |
| A2A / MCP | Wrapped in `ResourceResponse.resource` | Wrapped in `ResourceResponse.resource` | Refund initiated |

In both cases, the backend status code and body are preserved. Key0 never replaces a backend error with its own error shape (e.g. no 502 wrapping of backend 500s).

### Discovery Endpoint

`GET /discover` returns both plans and routes. The response is unwrapped (no `discoveryResponse` wrapper — this is a fix from the current branch):

```json
{
  "agentName": "Weather API",
  "plans": [
    { "planId": "premium", "unitAmount": "$5.00", "description": "Monthly access" }
  ],
  "routes": [
    {
      "routeId": "weather",
      "method": "GET",
      "path": "/api/weather/:city",
      "unitAmount": "$0.01",
      "description": "Get current weather for a city"
    },
    {
      "routeId": "health",
      "method": "GET",
      "path": "/health"
    }
  ]
}
```

Free routes have no `unitAmount` field. The gateway does not add a computed `free: true` field — absence of `unitAmount` indicates a free route.

### Embedded Mode — API Rename

Sellers using `key0.payPerRequest()` middleware directly on their Express/Hono/Fastify app continue to work. The parameter is renamed from `planId` to `routeId` (breaking change within the branch; not a main-branch change). The middleware resolves the `routeId` against `SellerConfig.routes`.

```typescript
app.get("/api/weather/:city", key0.payPerRequest("weather"), handler);
// req.key0Payment contains payment metadata
```

This mode remains HTTP-only (no A2A/MCP). It is for greenfield sellers who own the app and prefer middleware-style gating. In this case, `proxyTo` is not needed.

---

## Docker Setup UI (Dashboard)

The setup UI at `/setup` is a React SPA served from `ui/dist`. The layout is: a left-side configuration form with collapsible sections (60% width on large screens) + a sticky right-side output panel (40%) showing live previews of the agent card, MCP terminal walkthrough, and deployment scripts. The current form has 6 sections: Company, Pricing Plans, Token Issuance, Wallet & Network, Server & Storage, Refund Cron.

This spec requires three changes to the form and its backing API:
1. Replace the "Pricing Plans" section with a combined **"Plans & Routes"** section
2. Add a **"Gateway / Proxy"** section (conditionally required when routes are configured)
3. Make the "Token Issuance" section conditionally required (only when plans are configured)

All other sections (Company, Wallet & Network, Server & Storage, Refund Cron) and their fields are unchanged.

---

### Section: Plans & Routes (replaces "Pricing Plans")

This section contains two independent sub-editors side by side (or stacked on mobile): one for Plans, one for Routes. A seller may configure plans only, routes only, or both.

**Plans sub-editor** (existing `PlanEditor`, unchanged field set)

Each plan row:
- **Plan ID** (required) — slug, e.g. `starter-monthly`
- **Price in USDC** (required) — e.g. `5.00`
- **Description** (optional)

Section hint: _"Clients pay once and receive a token for ongoing access. Your backend decides what each plan unlocks."_

Add/remove rows. Minimum 0 rows (routes-only sellers need no plans).

**Routes sub-editor** (new `RouteEditor` component, modelled on `PlanEditor`)

Each route row:
- **Route ID** (required) — slug, e.g. `weather-query`
- **Method** (required) — dropdown: `GET | POST | PUT | DELETE | PATCH`; default `GET`
- **Path** (required) — Express-style param path, e.g. `/api/weather/:city`
- **Price per call in USDC** (optional) — leave blank for free
- **Description** (optional)

Section hint: _"Each API call is individually gated. Paid routes require payment per call. Free routes proxy directly. Your backend receives every request."_

Add/remove rows. Minimum 0 rows (plans-only sellers need no routes).

**Validation for this section:**
- At least one plan OR one route must exist (save button disabled otherwise)
- Each plan row: `planId` and `unitAmount` both required
- Each route row: `routeId`, `method`, and `path` all required; `unitAmount` optional
- `path` must start with `/`
- `routeId` and `planId` values must be unique within their respective lists (no duplicates)

---

### Section: Gateway / Proxy (new, conditionally shown)

Shown only when at least one route is configured. Collapsed by default if no routes exist yet; auto-expands when the first route is added.

Fields:
- **Backend URL** (required when routes exist) — `PROXY_TO_BASE_URL`, e.g. `http://localhost:3001`. Hint: _"Key0 will proxy all route requests to this base URL."_
- **Internal Secret** (optional, password field) — `KEY0_PROXY_SECRET`. Sent as `x-key0-internal-token` on every proxied request. Hint: _"Validate this header in your backend to ensure requests came through Key0."_ Masked in status response using same `••••••` pattern as other secrets.

**Validation:**
- If any route is configured → Backend URL is required; save button remains disabled without it
- If no routes are configured → entire section hidden; Backend URL not required

---

### Section: Token Issuance (now conditionally required)

Currently always required. Under the new design, it is **only required when plans are configured**.

- If plans list is non-empty → Issue Token API and backend auth fields are required (unchanged behaviour)
- If plans list is empty (routes-only seller) → entire Token Issuance section is hidden; `ISSUE_TOKEN_API` is not written to `.env.runtime`

This eliminates the confusing situation where a routes-only seller must fill in a callback URL that will never be called.

---

### Validation Summary

The overall save-button enabled condition becomes:

```
(plans.length > 0 || routes.length > 0)                         // at least one thing configured
AND (plans.length === 0 || issueTokenApi.length > 0)            // token API required only with plans
AND (routes.length === 0 || proxyToBaseUrl.length > 0)          // backend URL required only with routes
AND walletAddress valid (0x + 42 chars)
AND storage backend requirement met (redis/postgres URL or managed)
AND all plan rows have planId + unitAmount
AND all route rows have routeId + method + path
AND no duplicate planIds
AND no duplicate routeIds
AND all paths start with /
```

---

### Output Panel Changes

**Experience tab — Agent Card subtab:** Update `generateAgentCard()` to include `routes` array in the discovery preview. Show route entries with `routeId`, method, path, and price (or "free"). The terminal walkthrough should demonstrate a route call via `/x402/access` in addition to the existing subscription plan flow.

**Experience tab — MCP subtab:** Update `generateMcpTerminal()` to show `discover` (renamed from `discover_plans`) returning both plans and routes.

**Deploy tab — .env subtab:** `generateEnv()` must write:
- `ROUTES_B64` — base64 JSON of routes array (when routes are configured), matching `PLANS_B64` pattern
- `PROXY_TO_BASE_URL` — when routes are configured
- `KEY0_PROXY_SECRET` — when set
- Omit `ISSUE_TOKEN_API` and `BACKEND_AUTH_STRATEGY` when plans list is empty

**Deploy tab — docker-compose.yml and docker run subtabs:** No structural changes; the new env vars are injected automatically via `generateEnv()`.

---

### Setup API Changes

**`GET /api/setup/status` — additions to `config` object in response:**

```typescript
{
  // existing fields...
  routes: Route[];            // parsed from ROUTES_B64 or ROUTES env var; [] if absent/invalid
  proxyToBaseUrl: string;     // from PROXY_TO_BASE_URL env var; "" if absent
  proxySecret: string;        // from KEY0_PROXY_SECRET env var; "••••••" if set, "" if absent
}
```

Error handling for `ROUTES_B64`: same as `PLANS_B64` — if present but invalid JSON, server logs a warning and exits with code 1.

**`POST /api/setup` — additions to request body:**

```typescript
{
  // existing fields...
  routes: Route[];
  proxyToBaseUrl: string;
  proxySecret: string;        // empty string means "clear it"; "••••••" means "keep existing"
}
```

**`POST /api/setup` — server-side validation additions:**
- If `routes.length > 0` and `proxyToBaseUrl` is empty → return 400 `"proxyToBaseUrl is required when routes are configured"`
- If `plans.length > 0` and `issueTokenApi` is empty → existing 400 behaviour (unchanged)
- If both `plans` and `routes` are empty → return 400 `"At least one plan or route must be configured"`

**`POST /api/setup` — `.env.runtime` write additions:**
- Write `ROUTES_B64=<base64>` when routes is non-empty (same encoding as `PLANS_B64`)
- Write `PROXY_TO_BASE_URL=<url>` when `proxyToBaseUrl` is non-empty
- Write `KEY0_PROXY_SECRET=<secret>` when proxySecret is non-empty and not masked
- Omit `ISSUE_TOKEN_API` when plans list is empty
- Secret masking: `proxySecret` is filtered same as other secrets — if value contains `•`, skip write to preserve existing value

---

### Edge Cases

| Scenario | Expected behaviour |
|---|---|
| Routes-only seller saves with no Backend URL | Save button disabled; inline error on Backend URL field |
| Routes-only seller (no plans) — Token Issuance section hidden? | Yes — section hides; `issueTokenApi` not required |
| Plans-only seller (no routes) — Token Issuance section hidden? | No — section stays visible and required; unchanged behaviour |
| Seller adds first route | Gateway section auto-expands; Backend URL field highlighted |
| Seller removes all routes | Gateway section collapses and hides; Backend URL no longer blocks save |
| Seller removes all plans | Token Issuance section hides; `ISSUE_TOKEN_API` omitted from .env |
| `ROUTES_B64` is invalid base64/JSON at startup | Server logs error, exits code 1 (same as `PLANS_B64`) |
| `ROUTES_B64` is absent | `routes` defaults to `[]`; no error |
| Duplicate `routeId` values | Inline validation error on the duplicate row; save blocked |
| Route path without leading `/` | Inline validation error on the path field |
| `proxySecret` not changed by user | Frontend sends `"••••••"`; server skips write, preserving existing value |
| `proxySecret` cleared by user | Frontend sends `""`; server omits `KEY0_PROXY_SECRET` from .env |
| Mixed plans + routes, only routes failing validation | Save blocked; only route section shows errors |
| Server restarting after save | Existing poll-until-configured behaviour unchanged |

---

## Backward Compatibility

This is a **breaking change** to the `feat/pay-per-request` branch (not to `main`). The following are removed:

| Removed | Replacement |
|---|---|
| `Plan.mode` | Separate `routes` array |
| `Plan.free` | Route with no `unitAmount` |
| `Plan.proxyPath` | `Route.path` |
| `Plan.proxyMethod` | `Route.method` |
| `Plan.proxyQuery` | Seller backend responsibility |
| `Plan.routes` | Top-level `SellerConfig.routes` |
| `SellerConfig.fetchResource` | `proxyTo` (custom logic moves to backend) |
| `key0.payPerRequest(planId)` | `key0.payPerRequest(routeId)` (parameter rename) |
| `GET /discovery` endpoint | Renamed to `GET /discover` |
| `discoveryResponse` wrapper on `GET /discover` | Unwrapped response object |
| A2A skill `id: "discover-plans"` | Renamed to `id: "discover"` |
| A2A skill `id: "request-access"` | Renamed to `id: "access"` |
| MCP tool `discover_plans` | Renamed to `discover` |
| MCP tool `request_access` | Renamed to `access` |

The subscription flow (`Plan` → payment → JWT) is **unchanged**. Sellers using only subscription plans today are unaffected.

---

## E2E Test Cases

### Transparent Proxy — Paid Route

1. **Happy path:** Client sends `GET /api/weather/london` with valid `PAYMENT-SIGNATURE` → backend receives request with `x-key0-tx-hash` and `x-key0-internal-token` headers → client receives raw backend response unchanged (status, headers, body)
2. **No payment header:** `GET /api/weather/london` without signature → `402 Payment Required` with payment requirements
3. **Invalid signature:** Invalid `PAYMENT-SIGNATURE` → `402` with error detail
4. **Double spend:** Reuse same `txHash` → `402` rejected
5. **Backend non-2xx:** Backend returns `500` with error body → refund initiated → client receives `500` with exact backend body unchanged
6. **Backend timeout:** Backend takes >30s → refund initiated → client receives `504`
7. **Path parameters forwarded correctly:** Route `GET /api/weather/:city`, request `GET /api/weather/london` → backend receives `GET /api/weather/london` (not `/api/weather/:city`)
8. **Query parameters forwarded:** `GET /api/weather/london?units=metric` → backend receives `?units=metric` unchanged

### Transparent Proxy — Free Route

9. **Happy path:** Client sends `GET /health` with no headers → proxied directly → raw backend response returned
10. **With spurious payment header:** Header is ignored, route still proxies freely

### A2A — Routes

11. **Paid route via A2A:** `POST /x402/access` with `routeId` + `PAYMENT-SIGNATURE` → `ResourceResponse` with `resource.body` matching backend response
12. **Free route via A2A:** `POST /x402/access` with `routeId` for free route, no payment needed → `ResourceResponse` with no `txHash`
13. **Unknown routeId:** → `404` error response
14. **Backend non-2xx via A2A:** → refund initiated → `ResourceResponse` with `resource.status` = backend status, `resource.body` = backend body unchanged
15. **`planId` and `routeId` both present:** → `400` error (ambiguous request)

### MCP Tools

16. **`discover` tool:** Returns both plans and routes with correct schema; free routes have no `unitAmount`
17. **`access` with routeId — paid:** Settles payment → `ResourceResponse`
18. **`access` with routeId — free:** No payment → `ResourceResponse`
19. **`access` with planId:** Subscription flow unchanged → `AccessGrant` JWT

### Subscription Plans (Regression)

20. **Subscription happy path:** `POST /x402/access` with `planId` → `AccessGrant` JWT (unchanged)
21. **`validateAccessToken` middleware:** JWT from subscription plan still accepted on protected routes

### Config Validation

22. **routes without proxyTo:** Startup throws clear error message
23. **plans without fetchResourceCredentials:** Startup throws clear error message
24. **Route with no unitAmount:** Treated as free, `402` never returned
25. **Both plans and routes configured:** Both work independently on the same server

### Coexistence

26. **Seller with both plans and routes:** Subscription clients and per-request clients coexist
27. **Discovery returns both:** `GET /discover` includes both `plans` and `routes` arrays, no wrapper

### Docker Setup UI

28. **Routes persist across restart:** Routes saved via `/api/setup/save` are written to `ROUTES_B64` and survive container restart
29. **Discovery reflects saved routes:** After saving routes via UI, `GET /discover` returns them correctly
30. **Free route in UI:** Route saved with blank price → discovery shows no `unitAmount` → transparent proxy requires no payment

---

## Documentation Updates

### README

- Replace "plans" section with two sections: **Subscription Plans** and **Per-Request Routes**
- Add quickstart snippet showing `routes` config alongside `proxyTo` for the gateway pattern
- Add comparison table: subscription vs per-request vs free route
- Update Docker quickstart to show the setup UI's two-section layout

### Mintlify

- **`introduction/two-modes.mdx`** — Update to describe embedded vs gateway; clarify gateway supports HTTP + A2A + MCP for all routes
- **`introduction/core-concepts.mdx`** — Add `Route` as a first-class concept alongside `Plan`; explain the distinction
- **`sdk-reference/seller-config.mdx`** — Add `routes` field, update `plans` to subscription-only, mark all removed fields with migration notes
- **`api-reference/data-models.mdx`** — Add `Route` type; update `Plan` type; update `ResourceResponse` with optional `routeId`/`txHash`; fix discovery response shape (remove wrapper)
- **`examples/ppr-embedded.mdx`** — Update `planId` → `routeId` in `payPerRequest()` call
- **`examples/ppr-standalone.mdx`** — Full rewrite: show top-level `routes` array, transparent proxy behavior, A2A + MCP access, no response wrapper
- **New: `guides/routes-vs-plans.mdx`** — When to use routes vs plans; how sellers use `validateAccessToken` to control subscription access; free route pattern
- **`architecture/payment-flow.mdx`** — Add transparent proxy path alongside the existing A2A/subscription flows
- **`deployment/environment-variables.mdx`** — Add `ROUTES_B64`, update `PLANS_B64` notes
- **`deployment/docker.mdx`** — Update setup UI walkthrough to show Plans + Routes tabs
