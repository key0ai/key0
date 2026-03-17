# README v2 Design Spec

## Goal

Rewrite the README to match what reputed open-source projects do: crisp,
confident, technically comprehensive, and aesthetically professional. Keep all
existing content — rewrite tone, structure, and framing. Both API sellers and
agent builders are primary audiences.

---

## Constraints

- **Approach:** Contextual/comprehensive (Prisma/tRPC style) — not minimal, not
  landing-page-only. The README doubles as the primary technical reference.
- **Tone:** Direct, technical, no marketing fluff. "Commerce layer" everywhere
  (never "payment layer").
- **ASCII diagrams:** Keep all of them. Clean up alignment.
- **Reference tables:** Keep all of them (env vars, SellerConfig, Plan, etc.).
- **Docs link:** `https://docs.key0.ai/introduction/overview` must appear
  prominently — both in the hero nav row (full URL including path) and as the
  lead line in the Documentation section.

---

## Structure

Sections are listed in order. "Kept as-is" means content only — position follows
this numbered list, not the current README order.

```
1. Hero
2. What is Key0
3. Quick Start
4. How It Works
5. Standalone Mode
6. Embedded Mode
7. Clients
8. Storage
9. Security
10. Token Issuance
11. Settlement Strategies
12. Networks
13. Running Examples
14. Development
15. Documentation
```

Rationale for ordering How It Works (4) before Standalone/Embedded (5/6): Quick
Start gets readers running in 30 seconds; How It Works explains the protocol before
the detailed deployment sections. The Key Principles note ("Topology vs protocol
diagrams separated") means deployment sections carry topology diagrams and How It
Works carries protocol flow diagrams — not that topology comes before protocol in
the document.

---

## Section Designs

### 1. Hero

```
[logo — docs/logo.png, width 260]

[badges: npm version | Docker Hub | license | docs]

Commerce infrastructure for the agentic web. Let AI agents discover,
pay for, and access your APIs autonomously — no human in the loop.

[Docs](https://docs.key0.ai/introduction/overview) · [Quick Start](#quick-start) · [Book a Demo](https://key0.ai/book-a-demo)

---

- **Zero proxying** — requests go directly to your server, no latency overhead
- **Open-source & self-hostable** — every part of the commerce flow is auditable
- **Automatic refunds** — if anything goes wrong on-chain, Key0 handles it

**Agent environments:** Claude Code, OpenClaw, Cursor, and more
**Protocols:** HTTP x402, MCP, A2A
**Payments:** Base (USDC) · Visa, Mastercard, UPI coming soon
```

Badges:
- npm: `https://img.shields.io/npm/v/@key0ai/key0`
- Docker: `https://img.shields.io/docker/v/key0ai/key0?label=docker`
- License: `https://img.shields.io/github/license/key0ai/key0`
- Docs: `https://img.shields.io/badge/docs-key0.ai-blue`

### 2. What is Key0

One paragraph, 3 sentences:

> Key0 is an open-source commerce layer for API sellers and agent builders.
> Sellers add Key0 to any existing API — via Docker or SDK — to make it
> discoverable and purchasable by AI agents. Agents pay with USDC on Base;
> Key0 handles verification, credential issuance, and automatic refunds if
> anything fails.

### 3. Quick Start

The section heading is "Quick Start" (replacing the current "Two Ways to Run"
heading). It opens with the comparison table (content kept as-is), then:

**Standalone — 30 seconds:**
```bash
docker compose -f docker/docker-compose.yml --profile full up
# Open http://localhost:3000 → configure via browser
```

**Embedded — Express (pattern snippet — `adapter`, `store`, `seenTxStore` shown as
already-constructed variables; full instantiation is in the Embedded Mode section):**
```bash
bun add @key0ai/key0
```
```typescript
app.use(key0Router({
  config: {
    walletAddress: "0xYour...",
    network: "testnet",
    plans: [{ planId: "basic", unitAmount: "$0.10" }],
    fetchResourceCredentials: async (params) => tokenIssuer.sign(params),
  },
  adapter, store, seenTxStore,
}));
app.use("/api", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET! }));
```

### 4. How It Works

Opening paragraph:

> Key0 sits between your server and any agent client. It handles the commerce
> handshake — discovery, challenge, on-chain verification, credential issuance
> — then gets out of the way. Your protected routes receive normal Bearer token
> requests.
>
> Two flows are supported. Both follow the same `PENDING → PAID → DELIVERED`
> lifecycle and are eligible for automatic refunds.

Then two ASCII diagrams with **Key0 as an explicit column**:

**A2A Flow:**
```
Client Agent          Key0                    Seller Server
     │  1. GET /.well-known/agent.json             │
     │ ──────────────────▶│                         │
     │ ◀── agent card + pricing                    │
     │                   │                         │
     │  2. AccessRequest │                         │
     │ ──────────────────▶│                         │
     │ ◀── X402Challenge  │                         │
     │                   │                         │
     │  3. Pay USDC on Base (on-chain)             │
     │                   │                         │
     │  4. PaymentProof  │                         │
     │ ──────────────────▶│                         │
     │                   │── verify on-chain        │
     │                   │── fetchResourceCredentials ──▶│
     │                   │◀── token                │
     │ ◀── AccessGrant   │                         │
     │                   │                         │
     │  5. Bearer <JWT>  │                         │
     │ ──────────────────────────────────────────▶│
     │ ◀── protected content                       │
```

**HTTP x402 Flow:**
```
Client                Key0                    Seller Server
     │  1. GET /discovery │                         │
     │ ──────────────────▶│                         │
     │ ◀── plan catalog   │                         │
     │                   │                         │
     │  2. POST /x402/access { planId }            │
     │ ──────────────────▶│                         │
     │ ◀── HTTP 402       │                         │
     │                   │                         │
     │  3. POST + PAYMENT-SIGNATURE                │
     │ ──────────────────▶│                         │
     │                   │── settle on-chain        │
     │                   │── fetchResourceCredentials ──▶│
     │ ◀── AccessGrant   │                         │
     │                   │                         │
     │  4. Bearer <JWT>  │                         │
     │ ──────────────────────────────────────────▶│
     │ ◀── protected content                       │
```

### 5. Standalone Mode

Intro (1 sentence):
> Run Key0 as a Docker container alongside your existing backend. No code
> changes required.

Topology diagram (corrected alignment — use this exactly):

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ Client Agent │     │    Key0 (Docker)     │     │  Your Backend    │
│              │────▶│  payment handshake   │     │                  │
│              │◀────│  agent card + pricing│     │                  │
│              │     │                      │     │                  │
│              │     │  verify on-chain     │     │                  │
│              │     │  POST /issue-token ──│────▶│  issue-token     │
│              │◀────│  AccessGrant         │◀────│  {token, ...}    │
└──────────────┘     └──────────────────────┘     └──────────────────┘
```

Then:
- Setup: renamed from `### Quick Start` to `### Setup` (avoids duplicate anchor
  with the top-level `## Quick Start` at section 3). Option A (Setup UI) + Option B
  (env vars) — kept as-is, including
  the `docker compose` command. The command appears in both section 3 and section 5
  intentionally — readers landing directly on Standalone Mode need it without
  scrolling up.
- Docker Compose profiles table — kept as-is
- Docker Image section — kept as-is
- Environment Variables table — kept as-is
- ISSUE_TOKEN_API contract — kept as-is
- Automatic Refunds section + diagram — kept as-is

### 6. Embedded Mode

Intro (2 sentences):
> Install the SDK and mount Key0 as middleware inside your existing application.
> You keep full control over token issuance, routing, and resource verification.

Topology diagram showing Key0 *inside* Your Application box (contrasts with Standalone).

Then:
- Install (bun add + optional ioredis)
- Full Express, Hono, Fastify examples — kept as-is
- SellerConfig reference table — kept as-is
- Plan + IssueTokenParams tables — kept as-is
- Refund Cron section + BullMQ example — kept as-is
- Environment Variables — kept as-is

### 7. Clients

Opening paragraph rewritten:
> Any agent that can hold a wallet and sign an on-chain USDC transfer can access
> Key0-gated APIs autonomously — no human in the loop, no pre-registration, no
> manual API key management. Payment is the credential.

Subsections: Coding Agents, MCP, Autonomous Agents — content kept as-is.

### 8–12. Storage / Security / Token Issuance / Settlement / Networks

All content kept as-is. No structural changes needed — these sections are
technically accurate and well-written.

**Heading levels:** Keep existing heading levels exactly. "Settlement Strategies"
remains `###` under `## Token Issuance` — it is not promoted to `##`. The
numbered list in the Structure section is a logical reading order, not a directive
to change heading levels.

### 13. Running Examples

Kept as-is.

### 14. Development

Kept as-is.

### 15. Documentation

```markdown
## Documentation

Full documentation at **[docs.key0.ai](https://docs.key0.ai/introduction/overview)**.

- [SPEC.md](./SPEC.md) — Protocol specification
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [setup-ui.md](./docs/setup-ui.md) — Setup UI architecture
- [Refund_flow.md](./docs/Refund_flow.md) — Refund state machine
- [mcp-integration.md](./docs/mcp-integration.md) — MCP transport
- [FLOW.md](./docs/FLOW.md) — Payment flow diagrams
```

---

## Key Principles Applied

- **"Commerce layer"** everywhere — never "payment layer"
- **Docs link first** — `docs.key0.ai` in hero nav and leading the Documentation section
- **Key0 visible in diagrams** — all flow diagrams show Key0 as an explicit party
- **Topology vs protocol diagrams separated** — Standalone/Embedded sections show
  deployment topology; How It Works shows protocol flow
- **No content cut** — rewrite tone and structure, preserve all reference material
