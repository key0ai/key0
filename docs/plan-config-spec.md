# Plan Configuration — Spec

**Version**: 0.4
**Date**: 2026-03-11
**Context**: Simplified Plan type — only `planId`, `unitAmount`, and optional `description`.

---

## 1. Design Philosophy

Key0 is a **payment + credential protocol**, not a billing platform.

- Key0 shows plans, collects USDC, issues a credential.
- **Everything after** — quota tracking, concurrency enforcement, feature gating, renewals, token TTL — is the **seller's backend**.
- The `Plan` config should be minimal: identify the plan, set the price, optionally describe it.

---

## 2. Plan Type

```typescript
type Plan = {
  readonly planId: string;
  readonly unitAmount: string;    // "$0.015", "$15.00"
  readonly description?: string;  // human-readable paragraph
};
```

That's it. Everything else (display name, resource type, features, tags, expiry) is metadata the seller controls in their own backend/UI. The plan description is a free-form paragraph that can include all of that info.

---

## 3. TinyFish AI Example

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

## 4. What Moved Out

Fields removed from `Plan` (sellers describe these in `description` or handle in their backend):

| Removed Field | Where It Lives Now |
|---|---|
| `displayName` | Use `planId` or include in `description` |
| `resourceType` | Seller's backend concern |
| `expiresIn` | Token TTL is decided by `fetchResourceCredentials` |
| `features` | Include in `description` paragraph |
| `tags` | Seller's backend/UI concern |

---

*End of Spec v0.4*
