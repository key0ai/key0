# README Improvements — Design Spec

**Date:** 2026-03-20
**Branch:** `docs/readme-improvements`
**Scope:** Plug critical content gaps in the shortened README without re-inflating it.

---

## Context

The README was reduced from ~1,100 lines to ~171 lines across four commits. The goal was to make the root README a lightweight orientation document that points to docs.key0.ai for depth. That goal is correct. However, four practical gaps remain that a first-time developer cannot resolve from the README alone.

**Primary reader:** Developers evaluating Key0 for the first time on GitHub.
**Core message to leave them with:** Key0 handles the full commerce flow (discovery → payment → delivery → refunds) so you don't have to build it — and the fastest way to try it is Docker.

---

## Gaps to Address

### Gap 1: ISSUE_TOKEN_API contract (standalone)
Standalone Docker is now the primary path. After payment is verified, key0 calls the seller's `ISSUE_TOKEN_API`. The README gives no information about what key0 sends or what the endpoint should return. A developer cannot implement this callback without reading the docs.

### Gap 2: Settlement strategies
The quick-start snippets include `adapter` and `gasWalletPrivateKey` but never explain how on-chain settlement works. Developers will stall when trying to get the first payment to settle.

### Gap 3: Networks table
Testnet vs mainnet requires knowing the correct chain ID and USDC contract address. This is referenced but never stated in the current README.

### Gap 4: `payPerRequest` embedded middleware
Per-request billing in embedded mode (the `key0.payPerRequest()` middleware) is entirely absent. Standalone per-request (via Docker proxy) is covered; embedded is not.

---

## What We Are NOT Adding Back

- Security section — the five invariants are well-served by SPEC.md and the docs
- Full SellerConfig reference tables — these belong in the SDK reference docs
- ASCII flow diagrams — "How It Works" covers the flow at an appropriate level of detail
- Buyer-side agent story — "How It Works" covers this; the concrete tooling (payments-mcp, Claude Code) is niche enough for docs
- Hono/Fastify full examples — linked from the embedded quickstart
- Refund cron setup (embedded) — linked from the refunds architecture doc

---

## Design

### Addition 1: ISSUE_TOKEN_API contract

**Placement:** Inside `### Standalone Docker`, after the paragraph beginning "That gives agents multiple standard ways to discover and interact with your service out of the box: HTTP x402, A2A, MCP, generated onboarding files, and CLI distribution flows.", before the "Continue with" links.

**Content:** One sentence intro, one request JSON block, one response JSON block. Separated from the preceding paragraph with one blank line. No subheading.

Field names and types sourced from `src/types/config.ts:10` (`IssueTokenParams`) and `src/helpers/docker-token-issuer.ts:30` (plan fields merged into body via `{ ...params, ...tier }`). Use these exact field names and representative values:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "challengeId": "7f3b2c1d-...",
  "resourceId": "basic",
  "planId": "basic",
  "txHash": "0xabc123...",
  "unitAmount": "$0.10"
}
```

`unitAmount` is merged from the matching plan object — it is a dollar-prefixed string (e.g. `"$0.10"`). Any additional custom fields added to the plan are also merged into the body.

Return any credential shape — key0 passes the response to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2027-01-01T00:00:00Z" }
```

**Size:** ~20 lines.

---

### Addition 2: Settlement strategies

**Placement:** New `## Settlement` section inserted at the blank line immediately before `## How It Works` (currently README line 113). Developers who attempt the quick start often stall on settlement; this section surfaces the two options immediately after so they can unblock themselves without leaving the README. The `network` value does not appear in Settlement snippets — the `testnet` constraint from the Constraints section does not apply here.

**Content:** Two subsections. No prose beyond what is required to configure each.

- **Facilitator (default):** Set `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. CDP executes an EIP-3009 `transferWithAuthorization` on-chain. No ETH required in your wallet.
- **Gas wallet:** Set `gasWalletPrivateKey` in SellerConfig (embedded) or `GAS_WALLET_PRIVATE_KEY` env var (standalone). The wallet must hold ETH on Base for gas fees. Self-contained, no external service.

Each subsection: 2 lines of prose + one config/env snippet.

**Size:** ~16 lines.

---

### Addition 3: Networks table

**Placement:** After the `## Development` section, before `## Repository Docs`.

**Content:** A table with columns: Network name (`testnet` / `mainnet`), Chain, Chain ID, USDC contract address.

| Network | Chain | Chain ID | USDC Contract |
|---|---|---|---|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

**Size:** ~6 lines.

---

### Addition 4: `payPerRequest` embedded middleware

**Placement:** Inside `### Embedded SDK`, after the subscription plan code block but *before* the "Continue with" links for that section. The `payPerRequest` content is a second pattern within the same section — it is not a separate section and does not get its own "Continue with" block.

**Content:** One-sentence intro explaining this is for per-request billing (no JWT, inline settlement). One Express code snippet showing:
- `key0.payPerRequest("routeId")` applied to a route as middleware
- `req.key0Payment` access in the handler (txHash, amount)

`req.key0Payment` is the `PaymentInfo` type (`src/types/config.ts:97`), confirmed to contain: `txHash` (`0x${string}`), `payer` (`string | undefined`), `planId`, `amount`, `method`, `path`, `challengeId`. The snippet should only show `txHash` and `amount` for brevity. `amount` is a dollar-prefixed string (same format as `unitAmount`, e.g. `"$0.10"`).

A note that Hono/Fastify variants are in the embedded quickstart.

**Size:** ~20 lines.

---

## Constraints

- README must stay under ~350 lines total after all additions.
- No new sections beyond those listed above.
- All additions should link to docs.key0.ai for depth rather than expanding inline.
- Code snippets must use `testnet` network (matching the existing quick-start tone).

---

## Out of Scope

Changes to docs.key0.ai, SPEC.md, CONTRIBUTING.md, or any source files.
