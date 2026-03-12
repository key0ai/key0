# Key0 Documentation Spec — Mintlify

**Version**: 1.1
**Date**: 2026-03-12
**Status**: Scaffolded — 51 placeholder `.mdx` files + `mint.json` created. Ready for content fill per Phase order below.

---

## 1. Purpose

Build comprehensive, developer-facing documentation for the Key0 SDK using Mintlify. The docs should serve three audiences:

1. **API providers (sellers)** — want to monetize their APIs for AI agents
2. **Agent developers (clients)** — want to pay for and consume Key0-protected APIs
3. **Contributors** — want to extend Key0 (new adapters, integrations, storage backends)

---

## 2. Folder Structure

```
docs/mintlify/
├── mint.json                          # Mintlify config (navigation, theme, tabs)
├── DOCS-SPEC.md                       # This file — content plan
├── images/                            # Logos, diagrams, screenshots
│   ├── logo-dark.png
│   ├── logo-light.png
│   ├── favicon.png
│   ├── payment-flow.png               # Sequence diagram
│   ├── state-machine.png              # State diagram
│   └── architecture.png               # System architecture
│
├── introduction/
│   ├── overview.mdx                   # What is Key0, value prop, agent environments
│   ├── how-it-works.mdx               # Two-phase payment flow (high level)
│   └── two-modes.mdx                  # Standalone vs Embedded comparison
│
├── quickstart/
│   ├── embedded.mdx                   # SDK install → Express setup → test with client
│   └── standalone.mdx                 # Docker compose → Setup UI → test with curl
│
├── architecture/
│   ├── payment-flow.mdx               # Full lifecycle with sequence diagrams
│   ├── state-machine.mdx              # All states, transitions, Lua scripts
│   ├── settlement-strategies.mdx      # Facilitator vs Gas Wallet
│   └── project-structure.mdx          # src/ layout, layers, entry points
│
├── integrations/
│   ├── express.mdx                    # Express router + validateAccessToken
│   ├── hono.mdx                       # Hono app + middleware
│   ├── fastify.mdx                    # Fastify plugin + hook
│   └── mcp.mdx                        # MCP server, tools, transport
│
├── payments/
│   ├── a2a-flow.mdx                   # A2A protocol flow (agent-to-agent)
│   ├── x402-http-flow.mdx             # HTTP x402 flow (3 cases)
│   ├── plans-and-pricing.mdx          # Plan type, config, examples
│   └── refunds.mdx                    # Refund cron, state machine, setup
│
├── security/
│   ├── invariants.mdx                 # The 5 security invariants
│   ├── token-issuance.mdx             # AccessTokenIssuer, JWT claims, HS256/RS256
│   ├── secret-rotation.mdx            # verifyWithFallback, zero-downtime
│   └── on-chain-verification.mdx      # 6 on-chain checks, replay prevention
│
├── deployment/
│   ├── docker.mdx                     # Docker image, compose, profiles
│   ├── setup-ui.mdx                   # Browser config wizard
│   ├── storage.mdx                    # Redis + Postgres backends, TTLs
│   └── environment-variables.mdx      # Full env var reference table
│
├── guides/
│   ├── building-a-seller.mdx          # End-to-end seller tutorial
│   ├── building-a-client-agent.mdx    # End-to-end buyer tutorial
│   ├── claude-code-integration.mdx    # MCP + payments-mcp + Claude Code
│   └── custom-payment-adapter.mdx     # Implementing IPaymentAdapter
│
├── sdk-reference/
│   ├── overview.mdx                   # Package exports, subpath imports
│   ├── seller-config.mdx              # SellerConfig type reference
│   ├── challenge-engine.mdx           # ChallengeEngine API
│   ├── access-token-issuer.mdx        # AccessTokenIssuer API
│   ├── x402-adapter.mdx               # X402Adapter API
│   ├── storage.mdx                    # IChallengeStore, ISeenTxStore, IAuditStore
│   ├── factory.mdx                    # createKey0() API
│   ├── middleware.mdx                 # validateAccessToken, validateKey0Token
│   ├── auth-helpers.mdx               # noAuth, createSharedSecretAuth, etc.
│   └── error-codes.mdx                # Key0ErrorCode table + shapes
│
├── api-reference/
│   ├── overview.mdx                   # HTTP endpoints overview
│   ├── agent-card.mdx                 # GET /.well-known/agent.json
│   ├── a2a-jsonrpc.mdx                # POST {basePath}/jsonrpc
│   ├── x402-access.mdx                # POST /x402/access (3 cases)
│   ├── mcp-tools.mdx                  # discover_plans, request_access
│   └── data-models.mdx                # All TypeScript types
│
└── examples/
    ├── express-seller.mdx             # Walkthrough of express-seller example
    ├── hono-seller.mdx                # Walkthrough of hono-seller example
    ├── client-agent.mdx               # Walkthrough of client-agent example
    ├── standalone-service.mdx         # Walkthrough of standalone-service
    ├── refund-cron.mdx                # Walkthrough of refund-cron-example
    └── backend-integration.mdx        # Walkthrough of backend-integration
```

---

## 3. Content Plan — Page by Page

### 3.1 Getting Started

#### `introduction/overview.mdx`
**Source material**: `README.md` § hero + value props, `SPEC.md` § 1 Problem Statement + § 2 Vision & Scope
**Content**:
- Hero: "Sell anything to AI agents" — one-liner + logo
- Three value props: zero proxying, open-source, automatic refunds
- Supported agent environments (Claude Code, OpenClaw, Cursor)
- Supported protocols (HTTP, MCP, A2A)
- Supported payment rails (Base/USDC today, Visa/MC/UPI soon)
- "Why Key0" section — contrast with manual API key management
**Mintlify features**: Hero component, CardGroup for protocols, Icon cards

#### `introduction/how-it-works.mdx`
**Source material**: `README.md` § "How It Works", `SPEC.md` § 5 System Architecture, `docs/FLOW.md` § Overview
**Content**:
- Two-phase payment flow explained in plain English
- Simplified sequence diagram (Mintlify Mermaid)
- Challenge → Payment → Grant lifecycle in 3 steps
- Link to detailed architecture pages
**Mintlify features**: Steps component, Mermaid diagrams

#### `introduction/two-modes.mdx`
**Source material**: `README.md` § "Two Ways to Run" + Standalone/Embedded ASCII diagrams
**Content**:
- Side-by-side comparison table (Standalone vs Embedded)
- When to choose each mode
- ASCII/Mermaid diagrams for each architecture
- Links to respective quickstart pages
**Mintlify features**: Tabs component, comparison table

### 3.2 Quickstart

#### `quickstart/embedded.mdx`
**Source material**: `README.md` § "Embedded Mode" + Express example, `SPEC.md` § 10 Seller Onboarding Flow
**Content**:
- Prerequisites: Bun, wallet address, testnet USDC
- Step 1: `bun add @key0ai/key0`
- Step 2: Configure SellerConfig (minimal)
- Step 3: Mount Express router (full working code)
- Step 4: Protect routes with validateAccessToken
- Step 5: Test with the client-agent example
- Expected output: challenge → payment → JWT → protected content
**Mintlify features**: Steps, CodeGroup (Express/Hono/Fastify tabs), Callouts

#### `quickstart/standalone.mdx`
**Source material**: `README.md` § "Standalone Mode" (through "Environment Variables"), `docs/setup-ui.md`
**Content**:
- Prerequisites: Docker
- Option A: Setup UI (`docker compose up` → browser)
- Option B: Environment variables
- Docker Compose profiles table
- ISSUE_TOKEN_API contract
- Test with curl
**Mintlify features**: Steps, Tabs (Setup UI / Env vars), CodeGroup

### 3.3 Architecture

#### `architecture/payment-flow.mdx`
**Source material**: `docs/FLOW.md` (Payment Flow, Transports)
**Content**:
- Full Phase 1 + Phase 2 lifecycle
- Three transports: `/x402/access`, `{basePath}/jsonrpc` middleware, A2A executor
- How they share the same ChallengeEngine
- Sequence diagrams for each transport
- HTTP headers reference table
- Message types (X402Challenge, AccessGrant, payment-signature)
**Mintlify features**: Mermaid sequence diagrams, Tabs per transport

#### `architecture/state-machine.mdx`
**Source material**: `docs/FLOW.md` (State Machine), `docs/Refund_flow.md` (State Machine), `src/types/challenge.ts`
**Content**:
- Full state diagram showing **both branches from PAID**:
  - Happy path: PENDING → PAID → DELIVERED (terminal success)
  - Refund path: PAID → REFUND_PENDING → REFUNDED | REFUND_FAILED (separate branch, not after DELIVERED)
  - Other terminals: PENDING → EXPIRED, PENDING → CANCELLED
- All 8 states: PENDING, PAID, DELIVERED, EXPIRED, CANCELLED, REFUND_PENDING, REFUNDED, REFUND_FAILED
- All allowed transitions table (from `docs/FLOW.md` "Allowed Transitions")
- Lua script walkthrough (atomic CAS)
- Redis schema: challenge hash, request index, seen tx, paid sorted set
- TTL management (7d → 12h on DELIVERED)
- **Important**: DELIVERED and REFUNDED are both terminal — refunds only happen from PAID when token issuance fails, never after successful delivery
**Mintlify features**: Mermaid state diagram, Code blocks for Lua

#### `architecture/settlement-strategies.mdx`
**Source material**: `docs/FLOW.md` (Settlement Strategies)
**Content**:
- Facilitator mode: CDP /verify + /settle flow
- Gas wallet mode: viem + ExactEvmScheme
- Nonce serialization (Redis lock vs in-process queue)
- Comparison table: when to use which
- Config options for each
**Mintlify features**: Tabs (Facilitator / Gas Wallet), comparison table

#### `architecture/project-structure.mdx`
**Source material**: `CLAUDE.md` (Architecture section), `CONTRIBUTING.md` (Project Structure)
**Content**:
- `src/` directory layout with descriptions
- Core layers diagram
- Key files table
- Entry points and subpath exports
**Mintlify features**: File tree component, cards per layer

### 3.4 Integrations

#### `integrations/express.mdx`
**Source material**: `README.md` § "Express" under Embedded Mode
**Content**:
- Install + import
- Full working example with key0Router
- validateAccessToken middleware
- Accessing decoded token via `req.key0Token`
- Customizing basePath
- MCP mode (`mcp: true`)
**Mintlify features**: Code blocks, Callouts for important notes

#### `integrations/hono.mdx`
**Source material**: `README.md` § "Hono" under Embedded Mode
**Content**:
- Install + import from `@key0ai/key0/hono`
- key0App usage
- honoValidateAccessToken middleware
- Accessing token via `c.get("key0Token")`
**Mintlify features**: Code blocks

#### `integrations/fastify.mdx`
**Source material**: `README.md` § "Fastify" under Embedded Mode
**Content**:
- Install + import from `@key0ai/key0/fastify`
- key0Plugin registration
- fastifyValidateAccessToken hook
- Accessing token via `request.key0Token`
**Mintlify features**: Code blocks

#### `integrations/mcp.mdx`
**Source material**: `docs/mcp-integration.md` (full file)
**Content**:
- Architecture diagram
- Two tools: discover_plans, request_access
- Payment flow Path A (HTTP x402 via payments-mcp) and Path B (native x402)
- Response formats: PaymentRequired, AccessGrant, errors
- Routes table
- Streamable HTTP transport explanation
- Stateless architecture rationale
- Claude Code `.mcp.json` connection
- Testing with curl
**Mintlify features**: Tabs (Path A / Path B), Mermaid diagrams, API response blocks

### 3.5 Payments

#### `payments/a2a-flow.mdx`
**Source material**: `README.md` § "A2A Flow (Agent-to-Agent)", `docs/FLOW.md` § Transport 3: A2A Executor
**Content**:
- Full A2A protocol flow (8 steps)
- Sequence diagram
- JSON-RPC request/response examples
- x402 metadata keys table
- AccessRequest → X402Challenge → PaymentProof → AccessGrant
**Mintlify features**: Steps, JSON code blocks

#### `payments/x402-http-flow.mdx`
**Source material**: `README.md` § "HTTP x402 Flow", `docs/FLOW.md` § Transport 1 + Transport 2
**Content**:
- Three cases: Discovery, Challenge, Settlement
- Request/response examples for each case
- HTTP headers: payment-required, www-authenticate, payment-signature, payment-response
- EIP-3009 signature structure
- x402 middleware routing logic
**Mintlify features**: Tabs per case, request/response blocks

#### `payments/plans-and-pricing.mdx`
**Source material**: `docs/plan-config-spec.md` (full file), `README.md` (Plan table)
**Content**:
- Plan type definition (planId, unitAmount, description)
- Design philosophy: "Key0 is a payment protocol, not a billing platform"
- TinyFish AI example
- What moved out of Plan (and where it lives now)
- How agents discover plans (agent card, MCP tools)
**Mintlify features**: Code blocks, callouts

#### `payments/refunds.mdx`
**Source material**: `docs/Refund_flow.md` (full file), `README.md` (Refund sections)
**Content**:
- Core idea: safety net for failed token issuance
- Refund state machine (PAID → REFUND_PENDING → REFUNDED | REFUND_FAILED)
- processRefunds() API reference
- Store TTLs
- BullMQ setup example
- Double-refund prevention (Lua CAS)
- findPendingForRefund mechanics
- REFUND_FAILED handling
- Timing diagrams (A2A + HTTP x402 + Refund)
- Standalone (Docker) vs Embedded refund setup
**Mintlify features**: Mermaid state diagram, code blocks, warning callouts

### 3.6 Security

#### `security/invariants.mdx`
**Source material**: `docs/FLOW.md` (Security Checks Summary), `SPEC.md` (section 9), `BEST_PRACTICES.md` (payment-invariants)
**Content**:
- The 5 security invariants that protect Key0:
  1. Atomic state transitions (Lua CAS)
  2. Double-spend prevention (SET NX + rollback)
  3. On-chain verification (6 checks)
  4. JWT security (jti, exp, min secret length)
  5. Callback safety (fire-and-forget vs caught)
- Per-request security checks table (ordered)
- Why each invariant matters
**Mintlify features**: Numbered list with accordions per invariant

#### `security/token-issuance.mdx`
**Source material**: `docs/FLOW.md` (Token Issuance & Validation), `SPEC.md` (section 9.6), `src/core/challenge-engine.ts` (`issueTokenWithRetry`)
**Content**:
- fetchResourceCredentials callback contract
- AccessTokenIssuer: HS256 (shared secret) + RS256 (PEM key)
- JWT claims reference
- Timeout + retry behavior — document accurately:
  - Default 15s timeout (`tokenIssueTimeoutMs`), default 2 retries (`tokenIssueRetries`)
  - **Timeouts are NOT retried** — `TOKEN_ISSUE_TIMEOUT` throws immediately to avoid duplicate token issuance from concurrent in-flight calls (the timed-out `fetchResourceCredentials` is still running)
  - Only transient errors (non-timeout) are retried with exponential backoff (500ms, 1s, 2s)
  - Deterministic errors (`PAYMENT_FAILED`) are also not retried
- Validation middleware per framework
**Mintlify features**: Tabs (HS256 / RS256), code blocks, Warning callout for timeout behavior

#### `security/secret-rotation.mdx`
**Source material**: `docs/FLOW.md` (Token Issuance), `README.md` (Secret rotation)
**Content**:
- verifyWithFallback() API
- Zero-downtime rotation steps
- Example: rolling from old secret to new secret
**Mintlify features**: Steps component

#### `security/on-chain-verification.mdx`
**Source material**: `SPEC.md` (section 7.1, on-chain verification steps), `docs/FLOW.md` (Security Checks)
**Content**:
- The 6 on-chain checks in order
- How verifyTransfer works (viem, getTransactionReceipt, ERC-20 Transfer decode)
- Chain ID replay guard
- Amount validation (USDC 6 decimals)
- Block timestamp vs expiresAt
- Network configuration table (testnet vs mainnet)
**Mintlify features**: Ordered steps, comparison table

### 3.7 Deployment

#### `deployment/docker.mdx`
**Source material**: `README.md` § "Standalone Mode" (Quick Start through Docker Image)
**Content**:
- Docker image tags (latest, semver, canary)
- docker run one-liner
- Docker Compose profiles (none / redis / postgres / full)
- Building from source
- Docker volume (key0-config)
- Managed infrastructure auto-detection
**Mintlify features**: Tabs, code blocks

#### `deployment/setup-ui.mdx`
**Source material**: `docs/setup-ui.md` (full file)
**Content**:
- Architecture diagram
- Three modes: Setup Mode, Running Mode, Standalone
- Config flow (form → POST /api/setup → exit 42 → restart)
- Plans encoding (PLANS_B64)
- UI sections table
- Docker volume persistence
- Security note (unprotected /api/setup in Docker)
**Mintlify features**: Steps, diagrams, callouts

#### `deployment/storage.mdx`
**Source material**: `docs/FLOW.md` (Redis Schema), `README.md` (Storage section)
**Content**:
- Redis backend: key naming, Lua scripts, TTLs, sorted sets
- Postgres backend: same interface, row-level locking
- IAuditStore (optional audit trail)
- Health check (store.healthCheck())
- Redis commands per operation table
- Configuring TTLs
**Mintlify features**: Tabs (Redis / Postgres), tables

#### `deployment/environment-variables.mdx`
**Source material**: `README.md` (both env var tables — Standalone + Embedded)
**Content**:
- Full table: Variable, Required, Default, Description
- Standalone-specific vars (ISSUE_TOKEN_API, KEY0_MANAGED_INFRA, etc.)
- Embedded-specific vars (ACCESS_TOKEN_SECRET, CDP keys, etc.)
- Refund cron vars
- Storage vars
**Mintlify features**: Large table, Tabs (Standalone / Embedded)

### 3.8 Guides

#### `guides/building-a-seller.mdx`
**Source material**: `SPEC.md` (section 10), `README.md` (all seller sections)
**Content**:
- End-to-end tutorial: from zero to a payment-gated API
- Step 1: Install SDK
- Step 2: Configure wallet + network
- Step 3: Define plans
- Step 4: Implement fetchResourceCredentials
- Step 5: Set up storage (Redis)
- Step 6: Mount router
- Step 7: Protect routes
- Step 8: Go to mainnet
- Wallet management recommendations
**Mintlify features**: Steps, full code examples

#### `guides/building-a-client-agent.mdx`
**Source material**: `README.md` (Clients section), example: `examples/client-agent/`
**Content**:
- How client agents interact with Key0 (discovery → pay → access)
- No SDK needed — standard HTTP + on-chain USDC
- Example using the client-agent code
- Payment signing with a wallet
**Mintlify features**: Steps, code walkthrough

#### `guides/claude-code-integration.mdx`
**Source material**: `README.md` (Coding Agents + MCP sections), `docs/mcp-integration.md`
**Content**:
- Setting up Key0 as an MCP server
- Connecting from Claude Code (.mcp.json)
- Using payments-mcp for wallet signing
- Full flow: discover → pay → use
- Demo scenario
**Mintlify features**: Steps, JSON config blocks

#### `guides/custom-payment-adapter.mdx`
**Source material**: `SPEC.md` (section 8), `CLAUDE.md` (adapter layer)
**Content**:
- IPaymentAdapter interface
- issueChallenge + verifyProof contracts
- VerificationResult type
- Example: skeleton of a Stripe adapter
- How to wire it into createKey0
**Mintlify features**: Code blocks, interface reference

### 3.9 SDK Reference

#### `sdk-reference/overview.mdx`
**Content**: Package exports table, subpath imports (`@key0ai/key0`, `@key0ai/key0/express`, etc.), install instructions.

#### `sdk-reference/seller-config.mdx`
**Source material**: `README.md` (SellerConfig table), `SPEC.md` (section 6.7)
**Content**: Full SellerConfig type with every field, default, description. Plan type. IssueTokenParams type.

#### `sdk-reference/challenge-engine.mdx`
**Source material**: `docs/FLOW.md` (Payment Flow), `CLAUDE.md`
**Content**: ChallengeEngine class API — requestAccess, requestHttpAccess, submitProof, processHttpPayment, cancelChallenge. Constructor params. Return types.

#### `sdk-reference/access-token-issuer.mdx`
**Source material**: `docs/FLOW.md` (Token Issuance)
**Content**: Constructor options, sign(), verify(), verifyWithFallback(). JWT claims table.

#### `sdk-reference/x402-adapter.mdx`
**Source material**: `SPEC.md` (sections 7–8)
**Content**: X402Adapter class, constructor (network), verifyTransfer internals.

#### `sdk-reference/storage.mdx`
**Source material**: `docs/FLOW.md` (Redis Schema), `CLAUDE.md`
**Content**: IChallengeStore, ISeenTxStore, IAuditStore interfaces. RedisChallengeStore, RedisSeenTxStore, RedisAuditStore, PostgresChallengeStore, etc. Configuration. TTLs. transition() method.

#### `sdk-reference/factory.mdx`
**Content**: createKey0() function signature, params, return value ({ requestHandler, agentCard, engine, executor }).

#### `sdk-reference/middleware.mdx`
**Content**: validateAccessToken (Express, Hono, Fastify), validateKey0Token (standalone). How decoded token is attached to the request.

#### `sdk-reference/auth-helpers.mdx`
**Source material**: `CLAUDE.md` (Auth Helpers)
**Content**: noAuth, createSharedSecretAuth, createJwtAuth, createOAuthAuth. RemoteVerifier, RemoteTokenIssuer.

#### `sdk-reference/error-codes.mdx`
**Source material**: `docs/FLOW.md` (Error Codes Reference)
**Content**: Full Key0ErrorCode table with HTTP status, when thrown. Error shape.

### 3.10 API Reference

#### `api-reference/overview.mdx`
**Content**: All HTTP endpoints at a glance. Base paths. Authentication.

#### `api-reference/agent-card.mdx`
**Source material**: `SPEC.md` (section 6.1)
**Content**: GET /.well-known/agent.json — full response shape, AgentCard type, AgentSkill, SkillPricing.

#### `api-reference/a2a-jsonrpc.mdx`
**Source material**: `SPEC.md` (section 7.1), `docs/FLOW.md` (Transport 3)
**Content**: POST {basePath}/jsonrpc — request-access skill, submit-proof skill. JSON-RPC request/response. Error codes.

#### `api-reference/x402-access.mdx`
**Source material**: `docs/FLOW.md` (Transport 1)
**Content**: POST /x402/access — three cases (discovery, challenge, settlement). Full request/response for each.

#### `api-reference/mcp-tools.mdx`
**Source material**: `docs/mcp-integration.md`
**Content**: discover_plans tool, request_access tool. Input/output schemas.

#### `api-reference/data-models.mdx`
**Source material**: `SPEC.md` (section 6)
**Content**: All TypeScript types: AccessRequest, X402Challenge, PaymentProof, AccessGrant, ChallengeRecord, ChallengeState.

### 3.11 Examples

Each example page follows the same template:
1. What it demonstrates
2. Prerequisites
3. Directory structure
4. Key files walkthrough
5. How to run it
6. Expected output

**Source material**: `examples/` directory code + `README.md` examples table.

---

## 4. Source Material → Page Mapping

| Source File | Pages That Draw From It |
|---|---|
| `README.md` | overview, two-modes, quickstart/*, integrations/express+hono+fastify, payments/a2a-flow, payments/x402-http-flow, payments/refunds, deployment/docker, deployment/environment-variables, guides/building-a-seller, guides/building-a-client-agent, sdk-reference/seller-config, examples/* |
| `SPEC.md` | overview, how-it-works, architecture/payment-flow, payments/a2a-flow, security/on-chain-verification, guides/building-a-seller, guides/custom-payment-adapter, sdk-reference/seller-config, api-reference/agent-card, api-reference/a2a-jsonrpc, api-reference/data-models |
| `docs/FLOW.md` | architecture/payment-flow, architecture/state-machine, architecture/settlement-strategies, payments/x402-http-flow, security/invariants, security/token-issuance, deployment/storage, sdk-reference/challenge-engine, sdk-reference/error-codes, api-reference/x402-access |
| `docs/mcp-integration.md` | integrations/mcp, guides/claude-code-integration, api-reference/mcp-tools |
| `docs/plan-config-spec.md` | payments/plans-and-pricing |
| `docs/Refund_flow.md` | payments/refunds |
| `docs/setup-ui.md` | deployment/setup-ui |
| `docs/REVIEW-timeouts-retries.md` | (internal reference — informs security/invariants + sdk-reference/challenge-engine timeout/retry docs) |
| `CONTRIBUTING.md` | (link from docs, not duplicated) |
| `BEST_PRACTICES.md` | (internal reference — informs security/invariants) |
| `SECURITY.md` | (link from docs footer) |
| `CLAUDE.md` | architecture/project-structure, sdk-reference/* (architecture source of truth) |
| `examples/*` | examples/* pages, quickstart/*, guides/* |

---

## 5. Mintlify Features to Use

| Feature | Where |
|---|---|
| **Hero** | introduction/overview (main landing) |
| **CardGroup** | introduction/overview (protocols, payment rails), quickstart index |
| **Steps** | quickstart/*, guides/*, security/secret-rotation |
| **Tabs** | introduction/two-modes, integrations/*, payments/x402-http-flow, deployment/* |
| **CodeGroup** | quickstart/embedded (Express/Hono/Fastify tabs), all code examples |
| **Mermaid** | architecture/payment-flow, architecture/state-machine, architecture/settlement-strategies |
| **Callout (Note/Warning/Info)** | security pages (invariant warnings), deployment (env var gotchas) |
| **Accordion** | security/invariants (expand per invariant), sdk-reference (method details) |
| **API Playground** | api-reference/* (if we add OpenAPI spec later) |
| **Icons** | navigation anchors (npm, docker) |
| **Footer** | GitHub social link |

---

## 6. Writing Guidelines

1. **Lead with the "what" and "why"** — every page should answer "what does this do?" and "why would I use it?" in the first paragraph.
2. **Code first** — show working code before explaining it. Developers skim for code blocks.
3. **One concept per page** — don't mix A2A flow with x402 flow. Cross-link instead.
4. **Keep SDK reference pages thin** — type signature + one-line description + example. Link to architecture pages for the "how" and "why."
5. **Use Mintlify components** — Steps for tutorials, Tabs for alternatives, CodeGroup for multi-framework, Callouts for warnings.
6. **Don't duplicate README** — restructure and expand. The docs should be the source of truth; README should link to docs.
7. **Test all code blocks** — every code example should be copy-pasteable and runnable (or clearly marked as pseudo-code).
8. **Reference source material by heading, not line number** — use section headings or anchor names (e.g. `README.md § "Embedded Mode"`, `SPEC.md § 9.2 Replay Attack Prevention`) instead of line numbers, which drift on every edit.
9. **Verify against source code** — when documenting runtime behavior (retry logic, state transitions, timeout handling), always cross-check `src/` implementation. The `.md` spec files describe intent; the code is the source of truth for actual behavior.

---

## 7. QA & Maintenance

### CI Checks (add to GitHub Actions)

| Check | Tool | Purpose |
|---|---|---|
| **Mintlify build** | `mintlify build` (or `npx mintlify build`) | Catches broken MDX syntax, missing pages referenced in `mint.json`, invalid frontmatter |
| **Link validation** | `mintlify build` (built-in) + `markdown-link-check` for cross-references | Catches dead internal links (`/architecture/state-machine` → renamed page) |
| **Code block extraction** | Custom script: extract fenced code blocks, run through `tsc --noEmit` | Catches stale imports, renamed APIs in code examples |
| **Source drift detection** | Custom script: compare `src/types/challenge.ts` ChallengeState union against `architecture/state-machine.mdx` state list | Catches new states added in code but missing from docs |

### Ownership

- Each docs section should have a designated reviewer (same person who owns the corresponding `src/` code).
- PRs that touch `src/core/`, `src/adapter/`, `src/integrations/` should include a label check: "Does this change need a docs update?" (similar to the existing pre-push README hook).

### Stale-Reference Prevention

- Source material references in this spec use **section headings** (not line numbers) so they survive edits.
- When documenting runtime behavior (retry logic, state transitions, timeouts), the content author must verify against `src/` implementation, not just the spec `.md` files. Add a comment in the `.mdx` frontmatter: `source_verified: src/core/challenge-engine.ts@<git-short-hash>` so reviewers can check for drift.

---

## 8. Diagrams to Create

| Diagram | Type | Page(s) |
|---|---|---|
| System architecture (ChallengeEngine + adapters + transports) | Architecture diagram | introduction/how-it-works, architecture/project-structure |
| A2A payment sequence | Sequence diagram (Mermaid) | payments/a2a-flow |
| x402 HTTP payment sequence (3 cases) | Sequence diagram (Mermaid) | payments/x402-http-flow |
| MCP payment flow (Path A + Path B) | Sequence diagram (Mermaid) | integrations/mcp |
| State machine (full: PENDING → … → REFUNDED) | State diagram (Mermaid) | architecture/state-machine |
| Settlement comparison (Facilitator vs Gas Wallet) | Flow diagram | architecture/settlement-strategies |
| Standalone vs Embedded architecture | Architecture diagram | introduction/two-modes |
| Docker Setup UI flow | Flow diagram | deployment/setup-ui |
| Refund cron lifecycle | Sequence diagram | payments/refunds |

---

## 9. Implementation Order

Priority order for filling content (high-traffic pages first):

### Phase 1 — Core (Day 1)
1. `introduction/overview.mdx`
2. `introduction/how-it-works.mdx`
3. `introduction/two-modes.mdx`
4. `quickstart/embedded.mdx`
5. `quickstart/standalone.mdx`

### Phase 2 — Architecture + Payments (Day 2)
6. `architecture/payment-flow.mdx`
7. `architecture/state-machine.mdx`
8. `architecture/settlement-strategies.mdx`
9. `payments/a2a-flow.mdx`
10. `payments/x402-http-flow.mdx`
11. `payments/plans-and-pricing.mdx`
12. `payments/refunds.mdx`

### Phase 3 — Integrations + Security (Day 3)
13. `integrations/express.mdx`
14. `integrations/hono.mdx`
15. `integrations/fastify.mdx`
16. `integrations/mcp.mdx`
17. `security/invariants.mdx`
18. `security/token-issuance.mdx`
19. `security/on-chain-verification.mdx`
20. `security/secret-rotation.mdx`

### Phase 4 — Deployment + Guides (Day 4)
21. `deployment/docker.mdx`
22. `deployment/setup-ui.mdx`
23. `deployment/storage.mdx`
24. `deployment/environment-variables.mdx`
25. `guides/building-a-seller.mdx`
26. `guides/building-a-client-agent.mdx`
27. `guides/claude-code-integration.mdx`
28. `guides/custom-payment-adapter.mdx`

### Phase 5 — Reference (Day 5)
29. `sdk-reference/*` (all 10 pages)
30. `api-reference/*` (all 6 pages)
31. `examples/*` (all 6 pages)
32. `architecture/project-structure.mdx`

### Phase 6 — Polish
33. Create all diagrams (images/)
34. Copy logos to images/
35. Review cross-links between pages
36. README.md update to link to docs site
37. Add OpenAPI spec for API playground (future)

---

## 10. Open Decisions

| # | Question | Options |
|---|---|---|
| 1 | Docs URL | `docs.key0.ai` (custom domain) vs `key0.mintlify.app` (default) |
| 2 | Versioning | Single version for now vs multi-version when we hit v1.0 |
| 3 | API Playground | Add OpenAPI spec for interactive testing in Mintlify? |
| 4 | Blog/Changelog | Add a changelog tab for releases? |
| 5 | Search | Mintlify built-in search is fine, or add Algolia? |
| 6 | Analytics | Enable Mintlify analytics or use separate (Posthog, etc.)? |
| 7 | Existing docs/ folder | Move internal .md files to separate `docs/internal/` or keep as-is? |

---

*End of Docs Spec v1.1*
