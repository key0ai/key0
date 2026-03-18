# Plan Configuration — Spec

**Version**: 0.5
**Date**: 2026-03-17
**Context**: Plan type extended with `mode` and `routes` for pay-per-request support.

---

## 1. Design Philosophy

Key0 is a **payment + credential protocol**, not a billing platform.

- Key0 shows plans, collects USDC, and either issues a credential (subscription) or proxies to the backend and returns the response (per-request).
- **Everything after** — quota tracking, concurrency enforcement, feature gating, renewals, token TTL — is the **seller's backend**.
- The `Plan` config should be minimal: identify the plan, set the price, declare the billing mode, and optionally declare the routes.

---

## 2. Plan Type

```typescript
type Plan = {
  readonly planId: string;
  readonly unitAmount: string;               // "$0.015", "$15.00"
  readonly description?: string;             // human-readable paragraph
  readonly mode?: "subscription" | "per-request"; // default: "subscription"
  readonly routes?: PlanRouteInfo[];         // routes for per-request plans
};

type PlanRouteInfo = {
  readonly method: string;    // e.g. "GET"
  readonly path: string;      // e.g. "/api/weather/:city"
  readonly description?: string;
};
```

### Field Notes

- `mode` — defaults to `"subscription"` when omitted. Set to `"per-request"` for pay-per-call billing. With `mode: "per-request"`, no JWT is issued; the route handler runs directly (embedded) or the request is proxied to the backend (standalone).
- `routes` — optional array of routes guarded by this per-request plan. Used to:
  - Populate the agent card skills with route metadata (so A2A agents know which paths to call).
  - Populate the `/discovery` response with route information.
  - Enable auto-discovery when using `key0.payPerRequest()` middleware (the framework integration captures the path automatically, but `routes` provides explicit metadata and description).

### Subscription and per-request plans can coexist

```typescript
const plans: Plan[] = [
  // Subscription: issues a JWT
  { planId: "basic", unitAmount: "$0.10", description: "API access — $0.10 per session." },

  // Per-request: charges per call, no JWT
  {
    planId: "weather-query",
    unitAmount: "$0.01",
    description: "Current weather for any city — $0.01 per request.",
    mode: "per-request",
    routes: [
      {
        method: "GET",
        path: "/api/weather/:city",
        description: "Current weather conditions for a given city",
      },
    ],
  },
];
```

---

## 3. TinyFish AI Example (Subscription)

```typescript
const plans: Plan[] = [
  {
    planId: "payg",
    unitAmount: "$0.015",
    description:
      "Pay-as-you-go. Best for low-volume or unpredictable workflows. 2 concurrent agents, all LLM costs included, email support.",
  },
  {
    planId: "starter-monthly",
    unitAmount: "$15.00",
    description:
      "Starter (monthly). Best for developers running daily workflows. 1,650 steps/month, 10 concurrent agents, priority email support. Past 1,650 steps: $0.014/step.",
  },
  {
    planId: "pro-monthly",
    unitAmount: "$150.00",
    description:
      "Pro (monthly). Best for teams with high-volume workflows. 16,500 steps/month, 50 concurrent agents, priority email + Slack. Past 16,500 steps: $0.012/step.",
  },
];
```

---

## 4. Pay-Per-Request Example

```typescript
const plans: Plan[] = [
  {
    planId: "weather-query",
    unitAmount: "$0.01",
    description: "Current weather for any city — $0.01 per request.",
    mode: "per-request",
    routes: [
      {
        method: "GET",
        path: "/api/weather/:city",
        description: "Current weather conditions for a given city",
      },
    ],
  },
  {
    planId: "joke-of-the-day",
    unitAmount: "$0.005",
    description: "A random programming joke — $0.005 per request.",
    mode: "per-request",
    routes: [{ method: "GET", path: "/api/joke" }],
  },
];
```

---

## 5. What Moved Out

Fields removed from `Plan` (sellers describe these in `description` or handle in their backend):

| Removed Field | Where It Lives Now |
|---|---|
| `displayName` | Use `planId` or include in `description` |
| `resourceType` | Seller's backend concern |
| `expiresIn` | Token TTL is decided by `fetchResourceCredentials` |
| `features` | Include in `description` paragraph |
| `tags` | Seller's backend/UI concern |

---

## 6. Changelog

| Version | Change |
|---|---|
| 0.4 | Initial simplified spec: `planId`, `unitAmount`, `description` only |
| 0.5 | Added `mode` (`"subscription" \| "per-request"`) and `routes` (`PlanRouteInfo[]`) for pay-per-request support |

---

*End of Spec v0.5*
