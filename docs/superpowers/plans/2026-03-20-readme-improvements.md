# README Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four targeted content additions to `README.md` to plug critical gaps for first-time developers evaluating Key0.

**Architecture:** Pure documentation edits to a single file (`README.md`). No code changes, no tests. Each addition is a self-contained `Edit` to an exact location in the file, followed by a line-count verification and a commit.

**Tech Stack:** Markdown, `git`

**Spec:** `docs/superpowers/specs/2026-03-20-readme-improvements-design.md`

---

## File Map

| File | Action |
|---|---|
| `README.md` | Modify — 4 targeted insertions |

---

## Task 1: Add ISSUE_TOKEN_API contract to Standalone Docker section

**Files:**
- Modify: `README.md:51-53`

This tells standalone Docker users what their `ISSUE_TOKEN_API` endpoint needs to accept and return. It goes after the "CLI distribution flows" sentence and before the "Continue with" links.

- [ ] **Step 1: Apply the edit**

Insert the following block between line 51 (`...CLI distribution flows.`) and line 53 (`Continue with:`). There must be one blank line between the "CLI distribution flows." sentence and the new block, and one blank line between the new block and "Continue with:".

```markdown
After on-chain payment is verified, key0 POSTs to `ISSUE_TOKEN_API`:

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

`unitAmount` is merged from the matching plan. Any extra fields you add to a plan are included automatically. Return any credential shape — key0 passes the response to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2027-01-01T00:00:00Z" }
```
```

The `old_string` for the Edit tool:

```
That gives agents multiple standard ways to discover and interact with your service out of the box: HTTP x402, A2A, MCP, generated onboarding files, and CLI distribution flows.

Continue with:
```

The `new_string`:

```
That gives agents multiple standard ways to discover and interact with your service out of the box: HTTP x402, A2A, MCP, generated onboarding files, and CLI distribution flows.

After on-chain payment is verified, key0 POSTs to `ISSUE_TOKEN_API`:

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

`unitAmount` is merged from the matching plan. Any extra fields you add to a plan are included automatically. Return any credential shape — key0 passes the response to the client as-is:

```json
{ "token": "eyJ...", "expiresAt": "2027-01-01T00:00:00Z" }
```

Continue with:
```

- [ ] **Step 2: Verify**

```bash
wc -l README.md
```

Expected: README now has ~188 lines (171 + ~17 new lines).

Check the section renders correctly by confirming these strings exist in the file:

```bash
grep -n "ISSUE_TOKEN_API" README.md
grep -n "resourceId" README.md
grep -n "2027-01-01" README.md
```

All three should return exactly one hit each.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add ISSUE_TOKEN_API request/response contract"
```

---

## Task 2: Add `payPerRequest` embedded middleware example

**Files:**
- Modify: `README.md` — inside `### Embedded SDK`, after the subscription code block, before "Continue with:"

This shows embedded per-request billing (no JWT, inline settlement) which was entirely absent from the new README. Placed immediately after the closing ` ``` ` of the subscription TypeScript block, before the "Continue with" links.

- [ ] **Step 1: Apply the edit**

The `old_string` for the Edit tool (the closing of the subscription block and the Continue with links):

```
app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
```

Continue with:
```

The `new_string`:

```
app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
```

For per-request billing (no JWT, inline settlement per call), use `payPerRequest` middleware:

```ts
const key0 = key0Router({
  config: {
    walletAddress: "0xYourWalletAddress" as `0x${string}`,
    network: "testnet",
    routes: [{ routeId: "weather", method: "GET" as const, path: "/api/weather/:city", unitAmount: "$0.01" }],
  },
  adapter,
  store: new RedisChallengeStore({ redis }),
  seenTxStore: new RedisSeenTxStore({ redis }),
});
app.use(key0);

app.get(
  "/api/weather/:city",
  key0.payPerRequest("weather"),
  (req, res) => {
    const payment = req.key0Payment; // { txHash: "0x...", amount: "$0.01", ... }
    res.json({ city: req.params.city, temp: 72, txHash: payment?.txHash });
  },
);
```

For Hono and Fastify variants, see [Embedded Quickstart](https://docs.key0.ai/quickstart/embedded).

Continue with:
```

- [ ] **Step 2: Verify**

```bash
wc -l README.md
grep -n "payPerRequest" README.md
grep -n "key0Payment" README.md
```

`payPerRequest` and `key0Payment` should each appear exactly once.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add payPerRequest embedded middleware example"
```

---

## Task 3: Add Settlement section

**Files:**
- Modify: `README.md` — new `## Settlement` section inserted immediately before `## How It Works`

This surfaces the two settlement strategies (Facilitator and Gas Wallet) right after the quick start, where developers most often stall.

- [ ] **Step 1: Apply the edit**

The `old_string` for the Edit tool:

```
## How It Works
```

The `new_string`:

```
## Settlement

Two strategies for settling USDC payments on-chain:

### Facilitator (default)

Coinbase CDP submits an EIP-3009 `transferWithAuthorization` on your behalf. No ETH required in your wallet.

```bash
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret
```

### Gas Wallet

Self-contained — no external service. The wallet signs and broadcasts the transfer directly. Must hold ETH on Base for gas fees.

```bash
# Standalone (env var)
GAS_WALLET_PRIVATE_KEY=0xYourPrivateKey
```

```ts
// Embedded (SellerConfig)
config: { gasWalletPrivateKey: process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` }
```

See [Environment variables](https://docs.key0.ai/deployment/environment-variables) for the full list of settlement options.

## How It Works
```

- [ ] **Step 2: Verify**

```bash
wc -l README.md
grep -n "## Settlement" README.md
grep -n "Facilitator" README.md
grep -n "Gas Wallet" README.md
```

`## Settlement` should appear exactly once, positioned before `## How It Works`.

```bash
grep -n "## How It Works\|## Settlement" README.md
```

`## Settlement` line number should be less than `## How It Works` line number.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add settlement strategies section"
```

---

## Task 4: Add Networks table

**Files:**
- Modify: `README.md` — new `## Networks` section between `## Development` and `## Repository Docs`

Gives developers the chain IDs and USDC contract addresses they need to verify on-chain behavior or integrate directly.

- [ ] **Step 1: Apply the edit**

The `old_string` for the Edit tool:

```
E2E setup and wallet funding notes live in [`e2e/README.md`](./e2e/README.md).

## Repository Docs
```

The `new_string`:

```
E2E setup and wallet funding notes live in [`e2e/README.md`](./e2e/README.md).

## Networks

| Network | Chain | Chain ID | USDC Contract |
|---|---|---|---|
| `testnet` | Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `mainnet` | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Repository Docs
```

- [ ] **Step 2: Verify**

```bash
wc -l README.md
grep -n "## Networks\|84532\|8453" README.md
```

Both chain IDs should appear exactly once each.

Final line count should be ≤ 350.

```bash
wc -l README.md
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add networks table with chain IDs and USDC contracts"
```

---

## Final Check

After all four tasks are committed:

- [ ] Read through the full README from top to bottom and confirm it flows naturally
- [ ] Verify total line count is ≤ 350: `wc -l README.md`
- [ ] Confirm no section was accidentally duplicated: `grep -c "^## " README.md` (expected: 10 top-level sections)
