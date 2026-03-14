---
tags:
  - prd
  - layer-2-artifact
document_type: prd
artifact_type: PRD
layer: 2
architecture_approaches:
  - saas
  - open-source-sdk
  - event-driven
  - webhook-based
  - on-chain-verification
priority: primary
development_status: draft
---

# Key0 Platform PRD

---

## 1. Document Control

| Field | Value |
|---|---|
| Status | Draft |
| Version | 0.3 |
| Date Created | 2026-03-14 |
| Last Updated | 2026-03-14 |
| Author | Srijan |
| Reviewer | Pending |
| Approver | Pending |
| BRD Reference | N/A — standalone PRD (no upstream BRD) |
| SYS-Ready Score | 78/100 (Target: ≥90) |
| EARS-Ready Score | 78/100 (Target: ≥90) |

> **Note**: SYS-Ready and EARS-Ready scores are estimated post-structural-fix. Re-run `/doc-prd-audit` after filling §13 (Implementation Approach) and §15 (Budget & Resources) stubs to confirm final scores.

### Document Revision History

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 | 2026-03-14 | Srijan | Initial draft — commerce lifecycle, personas, Part 1 Agent-Ready |
| 0.2 | 2026-03-14 | Srijan | Added Part 2 Network (registry, reputation, buyer SDK, platform integrations) |
| 0.3 | 2026-03-14 | Srijan | Restructured to standard 17-section MVP template; added all required metadata |

---

## 2. Executive Summary

Key0 is a **SaaS platform** that makes any seller agent-ready. Sellers connect their existing business — an API, a digital storefront, a task service, a Shopify store — and Key0 provides everything needed to transact with AI agents: hosted infrastructure, agent card, payment processing, order lifecycle management, and dispute handling. No servers to run, no Redis to configure, no SDK to integrate for most sellers. Sign up, configure, go live.

For developers and enterprises who want full control, an open-source self-hosted SDK remains available. But the primary product surface is the managed platform.

The platform has two capability areas:

**Part 1 — Agent-Ready** describes what any seller needs to transact with AI agents that already have intent and a wallet. An agent knows what it wants to buy and can pay; the seller just needs to be ready to receive it.

**Part 2 — The Network** describes the marketplace and platform layer: how agents find sellers they don't already know, how trust is established at scale, and how agent platforms can embed Key0 as their native commerce layer.

---

## 3. Problem Statement

Every seller of goods and services has built their commerce infrastructure for human users: browser signups, OAuth flows, credit-card checkouts, and human-readable UIs. AI agents cannot navigate these flows. They can't click "agree to terms," verify an email, or complete a Stripe checkout.

This is not a future problem. Agent platforms are already provisioning agents with verified identity, on-chain wallets, and payment credentials. An agent running a task today can discover a data provider, pay for access, retrieve the result, and continue — without a human in the loop. The bottleneck is not agent capability. It is seller infrastructure.

**Key0 solves the seller side.** Any seller — an API team, a digital goods vendor, a task shop, a physical service provider, or a Shopify store owner — can connect to Key0 and immediately accept orders from any AI agent with a wallet. Sellers connect their existing fulfillment logic via webhooks. Key0 hosts and runs all the agent-facing infrastructure. No changes to existing business logic. No human-facing flows removed. Agents get a structured, machine-readable interface; existing human customers are unaffected.

### What "Agent-Ready" Means

An agent-ready seller can handle the full commerce lifecycle autonomously:

- The agent discovers what's for sale and at what price.
- The agent pays on-chain and receives a confirmation.
- The seller fulfills — instantly or asynchronously.
- The agent receives and verifies delivery.
- If something goes wrong, the agent can dispute without a human intermediary.
- For variable-priced work, the agent can request and accept a quote before paying.

### Market Context

AI agents are becoming autonomous economic actors. Platforms now provision agents with verifiable identity, on-chain wallets funded with USDC, payment credentials, and task execution autonomy across multi-step workflows.

Three forces converge making this the right moment:

1. **Protocol standardization**: A2A (v1.0, Linux Foundation, March 2026) and MCP are widely adopted. The interface for agent-facing APIs is now predictable.
2. **Payment rail readiness**: x402 with USDC on Base provides a native payment primitive agents can execute without card networks or invoicing.
3. **Platform growth**: Agent platforms are actively provisioning agents with spending credentials. The buyers exist; sellers need to be ready for them.

The gap between what sellers expose and what agents can consume is an active revenue loss. Sellers who are not agent-ready will lose this traffic to competitors who are.

### Competitive Gap

| Capability | Key0 | Stripe / Processors | OpenAI Actions | Shopify |
|---|---|---|---|---|
| Agent-native payment (no human card flow) | Yes (x402/USDC) | No | No | No |
| A2A and MCP protocol support | Yes | No | MCP only | No |
| Async fulfillment lifecycle | Planned | No | No | Yes (human-facing) |
| On-chain payment verification | Yes | No | No | No |
| Negotiation / quoting | Planned | No | No | No |
| Agent-facing dispute resolution | Planned | Partial (human) | No | No |

---

## 4. Target Audience & User Personas

### API Operator

A developer or small team that owns a REST API — stock data feeds, weather APIs, AI inference endpoints. They gate access today via API keys issued after human signup.

**Pain**: Agent traffic hits their signup wall and bounces. There is no way to issue API keys programmatically to agents that cannot click through a signup flow. Revenue from agent platforms is zero.

**Success**: Three lines of configuration. Within days of deployment, they receive USDC payments from agent buyers with no human intervention. Their existing API key issuance logic is called from a callback, unchanged.

---

### Digital Goods Vendor

Sells research reports, datasets, AI model weights, or code packages. Orders are fulfilled asynchronously — a research report takes hours to produce.

**Pain**: No structured way to tell an agent "I received your payment, I'm working on it, here is the result." Agents cannot poll an email inbox. There is no proof-of-receipt mechanism.

**Success**: They declare their service as async, implement a fulfillment callback, and Key0 handles the order lifecycle. The agent polls for status or receives a webhook when the item is ready.

---

### Task Seller

Deep research shops, code generation services, competitive intelligence agencies. Each job requires inputs before a price can be quoted. Pricing is variable.

**Pain**: No way to accept a job description, quote a price, wait for acceptance, collect payment, and return output — all without human involvement. The negotiation step does not exist in current agent-commerce primitives.

**Success**: They implement a quote callback. The agent receives a binding quote with a TTL, accepts it, pays, and the fulfillment flow proceeds automatically.

---

### Physical / IRL Service Provider

Concierge services, drone delivery, print-on-demand, shipping brokers. Fulfillment involves real-world coordination and status transitions over hours or days.

**Pain**: No escrow mechanism. No structured order tracking for agents. No agent-facing dispute channel.

**Success**: Payment is held in escrow until they confirm delivery. The agent receives a tracking identifier. If delivery fails, the agent files a dispute and receives a resolution timeline.

---

### Non-Technical Seller

Shopify store owners, WhatsApp Business accounts, website owners. They want to accept agent orders the same way they accept human orders today — without running infrastructure or writing code.

**Pain**: Completely excluded from agent commerce. No managed service exists to expose their catalog and order flow to agents.

**Success**: Key0's managed platform is the answer. They sign up, connect their fulfillment backend via a Shopify app or a webhook URL, and go live. No infrastructure to manage, no code to write.

---

### Agent Buyer

Any AI agent executing a task that requires purchasing goods or services. The agent has a verifiable identity, an on-chain wallet funded with USDC, and must operate without falling back to human oversight.

**Pain**: Even when a structured agent interface exists, agents can only purchase instant-delivery items. They cannot request a quote for variable-priced work, track async fulfillment, confirm or reject delivery, or file a dispute. Any of these gaps forces human intervention and breaks the autonomous workflow.

**What agents need**:
- A machine-readable description of what's for sale, at what price, and with what delivery characteristics.
- A single flow to pay and initiate an order.
- Structured order status they can poll or receive via webhook.
- The ability to confirm or reject delivery.
- A dispute path when something goes wrong.
- For variable-priced work: the ability to request a quote and accept it before paying.

All of this must be available through standard A2A skills and MCP tools.

### Agent Identity Model (Tiered)

| Tier | Verification | Compatible With |
|---|---|---|
| A — Unverified | Self-asserted string. Logged, not verified. | Internal networks, development |
| B — OAuth-verified | `sub`/`client_id` from a validated OAuth 2.1 Bearer token | A2A, MCP, all enterprise agent platforms |
| C — DID-verified | `did:web:` URI; Key0 issues a nonce, buyer signs with DID key, Key0 verifies | Open-internet agents, maximum assurance |

The wallet address and OAuth sub together form a compound identity sufficient for commerce: the wallet proves "I paid," the OAuth token proves "I am who I claim to be."

---

## 5. Success Metrics (KPIs)

| ID | KPI | Target |
|---|---|---|
| `PRD.01.08.01` | Seller onboarding | First agent payment received in < 30 minutes from account creation |
| `PRD.01.08.02` | Order acknowledgment | < 500ms for `submit-order` |
| `PRD.01.08.03` | Delivery notification | Agent notified within 30 seconds of seller marking delivery complete |
| `PRD.01.08.04` | SLA enforcement | Order transitions to `OVERDUE` within 60 seconds of SLA breach |
| `PRD.01.08.05` | Backward compatibility | Zero breaking changes to existing seller contracts |
| `PRD.01.08.06` | Protocol coverage | All capabilities available as both A2A skills and MCP tools |
| `PRD.01.08.07` | Registry search latency | Results returned within 200ms p99 |
| `PRD.01.08.08` | Reputation propagation | Seller/buyer scores updated within 60 minutes of order finalization |
| `PRD.01.08.09` | Escrow release | Funds released within 60 seconds of `confirm-delivery` or auto-confirm |
| `PRD.01.08.10` | Dispute acknowledgment | `file-dispute` returns dispute record within 500ms |

---

## 6. Scope & Requirements

### In Scope

**Part 1 — Agent-Ready** (core platform):
- Negotiation: `request-quote`, `accept-quote` with binding TTL and rate limiting
- Transaction: x402/USDC payment flow, `submit-order` returning order + challenge, escrow mode, fiat rail abstraction, full audit logging
- Fulfillment: order state machine, webhook delivery, SLA enforcement, `cancel-order`
- Verification: `confirm-delivery`, `reject-delivery`, auto-confirm timeout, signed commerce receipts
- Dispute: `file-dispute`, `get-dispute-status`, pluggable arbitration, auto-escalation
- No-code onboarding: Shopify app (first connector), generic webhook adapter
- Seller dashboard: service configuration, order management, dispute handling, revenue reporting, event stream

**Part 2 — The Network**:
- Discovery registry at `registry.key0.ai`: capability search, reputation scores, quote comparison
- Bilateral reputation: per-seller and per-buyer metrics, immutable audit entries, minimum threshold enforcement
- Buyer SDK (`@key0ai/client`): full commerce lifecycle client for agent developers
- Platform integrations: OAuth token passthrough, wallet compatibility, registry delegation

### Out of Scope

See Section 11 (Constraints & Assumptions) for the full non-goals list.

---

## 7. User Stories & User Roles

### Roles

| Role | Description |
|---|---|
| Task Seller | Provides variable-priced services requiring a negotiation step |
| Digital Goods Vendor | Sells asynchronously-fulfilled digital products |
| Physical Service Provider | Delivers real-world goods/services with escrow and tracking |
| Shopify Seller | Non-technical seller using platform connector |
| Agent Buyer | AI agent purchasing goods or services autonomously |
| Platform Operator | Agent platform integrating Key0 as native commerce layer |

### User Stories

**`PRD.01.09.01`** As a **Task Seller**, I want to receive a job description, return a binding price quote with a TTL, and proceed to payment only if the agent accepts, so that I can handle variable-priced work without fixed plan pricing.

**`PRD.01.09.02`** As a **Digital Goods Vendor**, I want to accept payment for a research report and fulfill it asynchronously, so that agents can purchase long-running deliverables.

**`PRD.01.09.03`** As a **Physical Service Provider**, I want payment held in escrow until I confirm delivery, so that agents trust my service knowing their funds are protected.

**`PRD.01.09.04`** As an **Agent Buyer**, I want to dispute a non-delivery so that my funds are returned if the seller does not fulfill.

**`PRD.01.09.05`** As a **Shopify store owner**, I want to install a Key0 plugin that reads my catalog and exposes an agent-facing storefront, so I can accept agent orders without writing code.

**`PRD.01.09.06`** As an **Agent Buyer**, I want all seller-facing capabilities available as both A2A skills and MCP tools with identical typed schemas, so that I can interact with any Key0 seller regardless of my platform.

**`PRD.01.09.07`** As a **Platform Operator**, I want to integrate Key0 using my existing OAuth infrastructure and wallet layer, so that every agent on my platform gains commerce capabilities without per-agent configuration.

---

## 8. Functional Requirements

### Negotiation

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.01` | `request-quote` accepts a job description and returns a binding quote | Quote includes amount, currency, expiry, and description |
| `PRD.01.01.02` | Quote TTL enforced server-side | Expired quotes rejected regardless of client-supplied timestamps; ≤ 30 seconds clock skew tolerance |
| `PRD.01.01.03` | Accepted quotes are single-use | Second acceptance returns `QUOTE_ALREADY_ACCEPTED` |
| `PRD.01.01.04` | `accept-quote` returns a payment challenge using the exact quoted amount | Amount is exact; no rounding |
| `PRD.01.01.05` | Sellers declare negotiation support in their agent card | Agents can check before requesting; unsupported sellers return `NEGOTIATION_NOT_SUPPORTED` |
| `PRD.01.01.06` | `request-quote` is rate-limited per buyer identity | Max 10 requests per buyer per seller per hour; excess returns `RATE_LIMIT_EXCEEDED` |

### Transaction

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.07` | Existing x402 challenge-proof flow unchanged | All existing seller contracts, challenges, and access grants work without modification |
| `PRD.01.01.08` | `submit-order` creates the order and issues a payment challenge in a single response | Order is not in a payable state until the challenge is returned; no separate prior `request-access` call needed |
| `PRD.01.01.09` | Escrow mode holds funds until delivery confirmation | Funds are not moved to the seller wallet until `confirm-delivery` or auto-confirm timeout |
| `PRD.01.01.10` | Payment rail abstraction supports fiat as well as crypto | A Stripe fiat adapter can be substituted for plans that declare a fiat payment rail |
| `PRD.01.01.11` | All payment events logged to the audit store | Every state transition has an immutable audit entry |

### Fulfillment

State machine:
```
PENDING → PROCESSING → READY → DELIVERED
                             ↘ DELIVERY_REJECTED → DISPUTED
         → OVERDUE → DISPUTED
         → CANCELLED
```

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.12` | `get-order-status` returns current state and full history | State history includes timestamps for every transition; response within 200ms |
| `PRD.01.01.13` | Webhook delivery on status change | If a callback URL is registered, a POST is sent within 30 seconds; retried on failure with exponential backoff |
| `PRD.01.01.14` | Seller SLA triggers `OVERDUE` automatically | Transition happens within 60 seconds of SLA expiry; buyer can file dispute immediately |
| `PRD.01.01.15` | `cancel-order` accepted before fulfillment begins; rejected after | Rejection includes current state |
| `PRD.01.01.16` | Callback URLs validated at order creation | Private IPs, loopback, link-local, and non-HTTPS rejected with `INVALID_CALLBACK_URL` |
| `PRD.01.01.17` | Seller delivery endpoint is authenticated | The endpoint the seller calls to mark an order ready requires the seller's own credentials; unauthenticated calls are rejected |

### Verification

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.18` | `confirm-delivery` transitions order to `DELIVERED` and triggers escrow release | Release within 60 seconds |
| `PRD.01.01.19` | `reject-delivery` transitions order to `DELIVERY_REJECTED` with a reason | Reason stored on the order and included in any subsequent dispute |
| `PRD.01.01.20` | Auto-confirm timeout releases escrow to seller if buyer is unresponsive | Configurable (default 72 hours); atomic and logged |
| `PRD.01.01.21` | Delivery actions are idempotent | Calling twice returns existing state without side effects |
| `PRD.01.01.22` | Delivery payload stored on the order | Accessible via `get-order-status` after the seller marks ready |

### Signed Commerce Receipts

Every completed order generates a structured, cryptographically-signed receipt — signed by Key0 — that the agent can store, present as proof of purchase, or share with third parties. The receipt is machine-verifiable without trusting Key0 directly: the signature can be checked against Key0's published public key. The receipt covers the full chain: who paid, how much, to whom, what was delivered, and when.

### Dispute

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.23` | `file-dispute` accepts a reason and optional evidence | Returns dispute record with seller response deadline within 500ms |
| `PRD.01.01.24` | Supported reason codes | Non-delivery, SLA breach, wrong item, quality issue, unauthorized charge |
| `PRD.01.01.25` | Seller must respond within deadline | Auto-escalates to arbitration if seller does not respond |
| `PRD.01.01.26` | `get-dispute-status` returns current state and full timeline | All transitions and resolution details included |
| `PRD.01.01.27` | Resolution triggers escrow release to winning party | Refund to buyer or release to seller within 60 seconds |
| `PRD.01.01.28` | Arbitration mechanism is pluggable | Interface defined; specific backend is configurable |

### No-Code Seller Onboarding

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.29` | Shopify app reads catalog and exposes agent-facing storefront | Setup wizard results in a live agent card within 15 minutes |
| `PRD.01.01.30` | Catalog sync | Agent card reflects active catalog and updates within 5 minutes of a catalog change in Shopify admin |
| `PRD.01.01.31` | Order routing | An agent order creates an equivalent order in Shopify admin within 30 seconds |
| `PRD.01.01.32` | No theme impact | No changes required to the seller's storefront or theme |

### Discovery Registry

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.33` | Sellers register their agent card | Registration returns a registry ID within 1 second |
| `PRD.01.01.34` | Registry supports capability keyword search | Results returned within 200ms p99 |
| `PRD.01.01.35` | Registry returns seller reputation score alongside listing | Score reflects completion rate, dispute rate, and delivery SLA adherence |
| `PRD.01.01.36` | Agent card schema extended with service type, delivery method, and SLA fields | All new fields optional; existing agent cards remain valid |
| `PRD.01.01.37` | Sellers update listings without re-registering | Old listing replaced atomically |
| `PRD.01.01.38` | Registry is self-hostable | No dependency on the hosted registry for private deployments |
| `PRD.01.01.39` | Registration is rate-limited | Max 10 attempts per IP per hour; max 3 listings per verified identity without a staking deposit |

### Reputation

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.40` | Registry stores per-seller metrics | Order count, completion rate, dispute rate, average delivery vs. declared SLA |
| `PRD.01.01.41` | Seller score updated on every order finalization | Propagates to registry within 60 minutes |
| `PRD.01.01.42` | Score formula documented and deterministic | Same inputs always produce the same output; formula is published |
| `PRD.01.01.43` | Seller records are immutable | Audit store entries are write-only; no delete or update on history |
| `PRD.01.01.44` | Registry search sortable by seller reputation | Agents can rank results by reliability |
| `PRD.01.01.45` | Registry stores per-buyer metrics | Order count, dispute rate (disputes filed / orders placed), confirmation rate (confirmed / delivered), cancellation rate |
| `PRD.01.01.46` | Buyer score updated on every order finalization | Propagates within 60 minutes |
| `PRD.01.01.47` | Buyer reputation tied to verified identity | Tier A buyers have no reputation. Tier B/C buyers accumulate reputation against their OAuth sub or DID |
| `PRD.01.01.48` | Sellers can set a minimum buyer reputation threshold | Orders from buyers below the threshold rejected with `BUYER_REPUTATION_INSUFFICIENT` |
| `PRD.01.01.49` | Buyers cannot alter their own reputation records | Score and aggregate metrics readable; underlying audit entries not modifiable |

### Buyer SDK

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.50` | `@key0ai/client` wraps full commerce lifecycle | Exposes: `search`, `requestQuote`, `acceptQuote`, `waitForDelivery`, `confirmDelivery`, `fileDispute` |
| `PRD.01.01.51` | Package is independent of seller SDK | Sellers must not need to install buyer dependencies |
| `PRD.01.01.52` | All capabilities available via A2A skills and MCP tools | Identical typed input/output schemas across both protocols |

### Platform Integrations

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.53` | OAuth token passthrough | Platform agent OAuth tokens accepted as Tier B identity |
| `PRD.01.01.54` | Wallet compatibility | Platform wallet infrastructure must sign and submit USDC transfers on Base (x402 compatible) |
| `PRD.01.01.55` | Registry delegation | Platform can optionally expose a curated view of the Key0 registry |

### Seller Dashboard

| ID | Requirement | Measurable Criterion |
|---|---|---|
| `PRD.01.01.56` | Dashboard is itself an agent | Seller dashboard exposes a seller-facing MCP server and A2A agent for account management |
| `PRD.01.01.57` | Observability event stream | Every significant event surfaced in dashboard and exportable to external stacks (Datadog, Grafana, CloudWatch) |

---

## 9. Quality Attributes

### Performance

| ID | Attribute | Target |
|---|---|---|
| `PRD.01.02.01` | `submit-order` response latency | < 500ms p99 |
| `PRD.01.02.02` | `get-order-status` response latency | < 200ms p99 |
| `PRD.01.02.03` | Registry search latency | < 200ms p99 |
| `PRD.01.02.04` | Delivery webhook dispatch | Within 30 seconds of seller marking delivery complete |
| `PRD.01.02.05` | OVERDUE transition latency | Within 60 seconds of SLA expiry |
| `PRD.01.02.06` | Escrow release latency | Within 60 seconds of `confirm-delivery` or resolution |
| `PRD.01.02.07` | `file-dispute` response latency | Within 500ms |

### Availability

| ID | Attribute | Target |
|---|---|---|
| `PRD.01.02.08` | Payment-path availability | Registry is advisory and not in the critical payment path; sellers retain self-hosted agent cards as fallback |
| `PRD.01.02.09` | Registry availability | CDN-cache search results; outage must not block ongoing payments |

### Security

| ID | Attribute | Target |
|---|---|---|
| `PRD.01.02.10` | SSRF prevention | Callback URLs validated at order creation — private IPs, loopback, link-local, and non-HTTPS rejected in production |
| `PRD.01.02.11` | Authenticated delivery endpoint | Unauthenticated seller delivery endpoint calls rejected |
| `PRD.01.02.12` | Double-spend prevention | Transaction hash idempotency check via atomic SET NX; second submission returns `TX_ALREADY_REDEEMED` |
| `PRD.01.02.13` | Atomic state transitions | All order/challenge/quote/dispute transitions use compare-and-swap; no direct writes |

### Backward Compatibility

| ID | Attribute | Target |
|---|---|---|
| `PRD.01.02.14` | Existing seller contract stability | Zero breaking changes to any existing seller contract, challenge format, or access grant |

---

## 10. Architecture Requirements

@diagram: c4-l2
<!--
  intent: System context diagram for Key0 Platform
  scope: Key0 SaaS — seller infrastructure for agent commerce
  actors: Agent Buyer, Seller (API/Digital/Physical/Shopify), Key0 Platform, Base blockchain, External Agent Platforms, Registry
  focus: System boundary, major integrations, payment rail (x402/USDC), webhook callbacks, A2A/MCP protocol surface
-->

@diagram: dfd-l1
<!--
  intent: Level-1 data flow through Key0 Platform
  scope: Agent buyer → Key0 → Seller fulfillment
  flows:
    - Agent submits order → Key0 creates challenge → Agent submits payment proof → Key0 verifies on-chain → Order confirmed → Seller webhook → Seller marks ready → Agent confirms delivery → Escrow released
    - Dispute path: Agent rejects delivery → dispute filed → arbitration → resolution → escrow released to winning party
  data stores: ChallengeStore, OrderStore, SeenTxStore, AuditStore, ReputationStore
-->

@diagram: sequence-payment-flow
<!--
  intent: x402 payment and order lifecycle sequence
  participants: Agent, Key0 API, Base Chain, Seller Webhook
  happy-path:
    Agent → Key0: submit-order(planId, jobDescription?)
    Key0 → Agent: { order, challenge }
    Agent → Base Chain: transfer USDC
    Agent → Key0: submit proof(txHash)
    Key0 → Base Chain: verify ERC-20 Transfer event
    Base Chain → Key0: confirmed
    Key0 → Seller Webhook: order confirmed callback
    Key0 → Agent: order confirmed
  alt payment proof invalid:
    Key0 → Agent: error TX_INVALID
  else challenge expired:
    Key0 → Agent: error CHALLENGE_EXPIRED
  alt seller SLA breached:
    Key0 → Agent: order status OVERDUE (auto-transition)
    Agent → Key0: file-dispute
-->

### Architecture Topics

| ID | Topic | Decision |
|---|---|---|
| `PRD.01.32.01` | Backward compatibility | Every seller using Key0 today upgrades to any new version without changing a line of configuration or code. New capabilities added through optional config fields only. |
| `PRD.01.32.02` | One-flow payment+order | `submit-order` creates the order and issues the payment challenge in a single response. No two-step "get challenge then create order" flow. |
| `PRD.01.32.03` | State machines as source of truth | Every entity (challenges, orders, quotes, disputes) has a defined state machine. Transitions are atomic and enforced at the storage layer. No direct writes. |
| `PRD.01.32.04` | Agent identity: integrate, don't build | Key0 does not build or own agent identity infrastructure. Integrates with OAuth 2.1, W3C DID, SPIFFE/SPIRE, and Verifiable Credentials as the ecosystem matures. |
| `PRD.01.32.05` | Seller dashboard is itself an agent | Dashboard exposes a seller-facing MCP server and A2A agent for account management. Dogfoods the product. |
| `PRD.01.32.06` | Managed by default, open-source for power users | Primary product is managed SaaS. Open-source self-hosted SDK is functionally identical and remains available. |

---

## 11. Constraints & Assumptions

### Constraints (Non-Goals)

1. **No subscription / recurring billing** — Key0 is per-transaction. No subscription management, billing cycles, or seat licensing.
2. **No proprietary agent identity infrastructure** — No agent identity registry, credential issuance, or DID method. Key0 integrates with ecosystem standards.
3. **No fiat off-ramp** — Key0 receives USDC. Converting to fiat bank deposits is out of scope.
4. **No agent hosting or execution** — Key0 is infrastructure that agents call into. It does not run agents.
5. **No multi-party payment splitting** — Payments go to a single seller wallet per order.
6. **No content moderation of seller listings** — Key0 does not review seller product descriptions beyond schema validation.
7. **No order fulfillment execution** — Key0 provides the state machine and callbacks, not the actual fulfillment logic.
8. **No buyer wallet custody** — Key0 does not hold or manage buyer wallets.
9. **No cross-chain payments** — Only Base mainnet (chainId 8453) and Base Sepolia (chainId 84532) are supported.
10. **No KYC / real-world identity verification** — Reputation is computed from on-chain and in-system behavior only.

### Assumptions

1. A2A v1.0 (Linux Foundation) and MCP protocol interfaces are stable for the duration of this development cycle.
2. USDC on Base remains liquid and available as the primary payment rail.
3. Sellers implement the required callbacks (e.g., `fetchResourceCredentials`, fulfillment webhook) correctly.
4. Base blockchain RPC nodes are available and responsive within acceptable latency for on-chain verification.
5. The open-source SDK (`@key0ai/key0`) continues to serve as the reference implementation for the managed platform.
6. Escrow begins as an internal ledger hold; an on-chain smart contract adapter is a later opt-in once formally audited.

---

## 12. Risk Assessment

### Technical Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| `PRD.01.07.01` | **Escrow smart contract vulnerability** — bug in on-chain escrow causes irreversible fund loss | Medium | Critical | Formal audit before any on-chain escrow deployment. Start with trust-based (internal ledger) escrow. On-chain escrow as opt-in only after audit. |
| `PRD.01.07.02` | **Registry spam / Sybil listings** — bad actors create fake seller listings | High | High | Rate-limit registration. Small refundable USDC staking deposit to list. Auto-flag listings with zero orders after 30 days. |
| `PRD.01.07.03` | **Quote flooding / DoS** — agents spam `request-quote` at high volume | Medium | Medium | Rate-limit `request-quote` per buyer identity (max 10/hour/seller). Optional deposit requirement before quote is generated. |
| `PRD.01.07.04` | **Concurrent state transitions** — two simultaneous `confirm-delivery` calls for the same order | Low | High | All transitions use the same atomic compare-and-swap pattern as the existing challenge engine. |
| `PRD.01.07.05` | **Webhook delivery failures** — buyer's callback URL is unreachable | Medium | Medium | Retry with exponential backoff. `get-order-status` is the reliable source of truth; callback URL is best-effort. |
| `PRD.01.07.06` | **SSRF via callback URL** — buyer provides a URL pointing at internal infrastructure | High | Critical | Validate callback URLs at order creation. Block private IPs, loopback, link-local, and non-HTTPS in production. |
| `PRD.01.07.07` | **Unauthenticated seller delivery endpoint** — anyone who knows an order ID marks it delivered | Medium | High | Delivery endpoint requires the seller's bearer token. Unauthenticated calls rejected. |
| `PRD.01.07.08` | **Arbitration neutrality** — Key0-operated arbitration is perceived as biased | Medium | High | Default to neutral third-party arbitration. Key0-hosted arbitration only as a fallback. Backend is pluggable. |
| `PRD.01.07.09` | **Registry availability** — outage blocks discovery | Low | High | CDN-cache search results. Sellers retain self-hosted agent cards as fallback. Registry is advisory, not in the payment path. |

### Go-to-Market Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| `PRD.01.07.10` | **Agent buyer ecosystem too small early** — not enough agent traffic to prove seller ROI | High | High | Target API Operators first (existing technical Key0 users). Build pull from agent platforms directly. Developer evangelism before no-code onboarding. |
| `PRD.01.07.11` | **Competing commerce-for-agents product ships first** | Medium | High | x402/USDC rail and on-chain verifiability are defensible differentiators. Maintain protocol agnosticism (A2A + MCP). |
| `PRD.01.07.12` | **Regulatory uncertainty** — USDC transfers trigger MSB requirements | Low | High | Key0 does not custody funds — payments flow directly between buyer and seller wallets. Engage legal counsel before adding escrow custody. |
| `PRD.01.07.13` | **No-code adoption below target** | Medium | Medium | Launch with one high-fit vertical (digital goods on Shopify) before broader rollout. |

---

## 13. Implementation Approach

> **Status**: Stub — engineering input required to complete this section.

### Phase 1 — Core Order Lifecycle (Part 1, Baseline)

Extend the existing `@key0ai/key0` SDK and managed platform to support the full commerce lifecycle:

- Order state machine (`PENDING → PROCESSING → READY → DELIVERED / DELIVERY_REJECTED / OVERDUE / CANCELLED`)
- `submit-order` returning `{ order, challenge }` in a single response
- Webhook delivery with exponential backoff retry
- SLA enforcement timer (auto-`OVERDUE` transition)
- `confirm-delivery` / `reject-delivery` + auto-confirm timeout
- Internal ledger escrow (opt-in)
- Signed commerce receipts

Builds on: existing `challenge-engine.ts`, `storage/`, `access-token.ts`, x402 adapter.

### Phase 2 — Negotiation

- Quote engine: `request-quote`, `accept-quote`, quote TTL enforcement, single-use constraint, rate limiting per buyer identity
- Quote state machine integrated with existing challenge lifecycle

### Phase 3 — Dispute

- Dispute filing, status, seller response deadline
- Auto-escalation on seller non-response
- Pluggable arbitration interface (initial implementation: Key0-hosted manual review)

### Phase 4 — No-Code Onboarding

- Shopify app (native, for digital goods vertical): catalog sync, order routing, agent card generation
- Generic webhook adapter as DIY path

### Phase 5 — Network (Part 2)

- Registry (`registry.key0.ai`): registration, search, quote comparison brokering
- Bilateral reputation engine: per-seller and per-buyer scores, deterministic formula, 60-minute propagation
- Buyer SDK (`@key0ai/client`): composable typed client wrapping full lifecycle
- Platform integration: OAuth passthrough, wallet compatibility docs, registry delegation

### Open Questions (Engineering)

1. **OQ-1: Escrow Custody** — on-chain smart contract vs. internal ledger hold. Current thinking: ledger hold first, smart contract adapter after audit.
2. **OQ-2: Registry Governance** — open listing with USDC staking deposit. Auto-flag zero-order listings after 30 days.
3. **OQ-3: Dispute Arbitration Provider** — pluggable interface; initial: Key0-hosted manual. Neutral third-party (e.g., Kleros) on escalation based on volume.
4. **OQ-4: Buyer SDK Packaging** — separate `@key0ai/client`; shared types in `@key0ai/types`.
5. **OQ-5: No-Code Onboarding Architecture** — native Shopify app for digital goods; generic webhook adapter as DIY; WooCommerce/WhatsApp deferred by demand signal.

---

## 14. Acceptance Criteria

### Global Agent Buyer Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.01` | All seller-facing capabilities are available as both A2A skills and MCP tools with identical typed input/output schemas. |
| `PRD.01.06.02` | `submit-order` returns an order record and a payment challenge in a single response — one flow, not two. |
| `PRD.01.06.03` | `cancel-order` before fulfillment begins returns buyer funds within the refund SLA (default 24 hours; maximum 72 hours). |
| `PRD.01.06.04` | `file-dispute` returns a dispute record with a seller response deadline within 500ms. |
| `PRD.01.06.05` | All responses include a request ID echo and support idempotent retry — the same request ID submitted twice returns the same response without creating duplicate records. |
| `PRD.01.06.06` | Registry search returns structured results within 200ms p99. |

### Negotiation Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.07` | `request-quote` returns a quote with a unique ID, amount, and expiry within 5 seconds. |
| `PRD.01.06.08` | A quote past its expiry is rejected server-side with `QUOTE_EXPIRED`. |
| `PRD.01.06.09` | `accept-quote` returns a payment challenge using the exact quoted amount. |
| `PRD.01.06.10` | A quote accepted once cannot be accepted again (`QUOTE_ALREADY_ACCEPTED`). |
| `PRD.01.06.11` | Expired quotes leave no payment records or obligations. |

### Transaction Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.12` | `submit-order` returns `{ order, challenge }` within 500ms. |
| `PRD.01.06.13` | The same transaction hash submitted twice returns `TX_ALREADY_REDEEMED` on the second attempt. |

### Verification Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.14` | Escrow holds on payment; releases to seller on `confirm-delivery` within 60 seconds. |
| `PRD.01.06.15` | `reject-delivery` within the buyer rejection window initiates a refund. |
| `PRD.01.06.16` | Auto-confirm releases escrow if no response within the configured window (default 72 hours). |
| `PRD.01.06.17` | Physical orders surface a tracking identifier and carrier in order status. |

### Dispute Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.18` | `file-dispute` returns a dispute ID and seller response deadline within 500ms. |
| `PRD.01.06.19` | Non-response by the seller deadline auto-escalates the dispute. |
| `PRD.01.06.20` | Resolution triggers escrow release within 60 seconds. |

### No-Code Onboarding Acceptance Criteria

| ID | Criterion |
|---|---|
| `PRD.01.06.21` | Setup wizard results in a live agent card within 15 minutes of starting Shopify app install. |
| `PRD.01.06.22` | Agent card reflects active catalog and updates within 5 minutes of a catalog change in Shopify admin. |
| `PRD.01.06.23` | An agent order creates an equivalent order in Shopify admin within 30 seconds. |
| `PRD.01.06.24` | No changes required to the seller's storefront or theme. |

---

## 15. Budget & Resources

> **Status**: Stub — business input required to complete this section.

| Resource | Notes |
|---|---|
| Engineering | Phases 1–5 (see §13); estimate pending sprint planning |
| Infrastructure | Managed SaaS hosting: registry, audit store, webhook delivery workers |
| Legal | Counsel engagement before on-chain escrow custody goes live (escrow + MSB question) |
| Security audit | Required before on-chain smart contract escrow deployment |
| Shopify app review | App Store submission process; timeline TBD |

---

## 16. Traceability

> **Status**: Standalone PRD — no upstream BRD. `@brd: N/A`

| PRD Element | Upstream Reference | Notes |
|---|---|---|
| All requirements | N/A — standalone PRD | No BRD exists. Requirements are derived from product vision and market context in §3. |
| `PRD.01.01.07` (x402 flow unchanged) | `SPEC.md` security invariants | Must not break existing challenge-proof protocol |
| `PRD.01.01.11` (audit logging) | `SPEC.md` security invariants | Immutable audit trail is a stated security invariant |
| `PRD.01.02.13` (atomic transitions) | `SPEC.md` security invariants | State transition atomicity is a stated security invariant |
| `PRD.01.02.12` (double-spend) | `SPEC.md` security invariants | Double-spend prevention is a stated security invariant |

---

## 17. Glossary

| Term | Definition |
|---|---|
| **A2A** | Agent-to-Agent protocol (v1.0, Linux Foundation, March 2026). Defines how AI agents communicate and exchange structured tasks. |
| **x402** | HTTP payment protocol using the `402 Payment Required` status code. Enables machine-readable payment challenges and proofs over standard HTTP. |
| **MCP** | Model Context Protocol. Defines a structured tool interface for AI models to interact with external services. |
| **USDC** | USD Coin — a fiat-pegged stablecoin on Base (and other chains). The primary payment currency in Key0's x402 rail. |
| **Base** | An Ethereum L2 chain (Coinbase). Key0 supports Base mainnet (chainId 8453) and Base Sepolia testnet (chainId 84532). |
| **Escrow** | Payment held by Key0 pending delivery confirmation. Released to seller on `confirm-delivery` or auto-confirm; returned to buyer on dispute resolution in buyer's favour. |
| **Agent card** | A machine-readable JSON document describing a seller's available services, pricing plans, protocols supported, and delivery characteristics. Analogous to a DNS record for agent commerce. |
| **EARS** | Easy Approach to Requirements Syntax. A structured natural-language format for writing testable requirements. |
| **SYS** | System requirements artifact. Downstream of PRD; generated by `doc-sys-autopilot`. |
| **State machine** | A formal model where each entity (challenge, order, quote, dispute) has a defined set of states and allowed transitions. Key0 enforces all transitions atomically. |
| **Tier A/B/C identity** | Key0's three-tier agent identity model: A = unverified self-asserted, B = OAuth-verified, C = DID-verified. See §4. |
| **`@key0ai/key0`** | The open-source self-hosted Key0 SDK (npm package). Identical in capability to the managed SaaS platform. |
| **`@key0ai/client`** | The buyer-side SDK for agent developers. Wraps the full commerce lifecycle. |

---

## 18. Appendix A: Network Effect & Future Roadmap

### Network Effect Model

```
More platforms integrate Key0
  → More agents can transact with Key0 sellers
    → Being a Key0 seller is more valuable
      → More sellers register
        → Registry has more capabilities for agents to discover
          → More platforms integrate Key0
```

This flywheel does not start until the registry and buyer SDK exist. The registry must ship early rather than as an afterthought.

### Quote Comparison (Registry Feature)

The registry can actively broker quote requests on the agent's behalf. An agent submits a job description and budget to the registry once; the registry fans the request out to opted-in sellers in parallel and returns ranked quotes. Sellers opt in by declaring `supportsComparison: true` in their agent card.

### Deferred Platform Connectors

- WooCommerce connector
- WhatsApp Business connector

Timing: demand-signal driven; Shopify app is the first connector.

### Deferred Identity Integrations

- SPIFFE/SPIRE for enterprise workloads
- Verifiable Credentials (DIF Trusted AI Agents WG, IETF WIMSE, OpenID AI Identity Group)

---

*End of PRD-01 v0.3*
