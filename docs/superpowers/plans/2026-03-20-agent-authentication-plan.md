# Seller Agent Authentication Plan

Date: 2026-03-20
Status: Proposed
Owner: TBD

## Goal

Add first-class seller-side agent authentication to Key0 without conflating:

- payment proof
- caller authentication
- purchased access authorization

Key0 already proves payment and can issue a post-purchase access token. What it does not yet provide is a unified way for a seller to authenticate the calling agent across its protocol surfaces and advertise those requirements in the protocol-native way.

## Recommendation

Implement an OAuth-first, protocol-aware authentication layer with one shared verification core and protocol-specific adapters:

1. Use OAuth 2.1 style bearer tokens as the default seller-side agent auth model.
2. Treat Key0 as a resource server, not a built-in authorization server.
3. Support both JWT validation via JWKS and opaque token introspection.
4. Advertise auth requirements in:
   - A2A `securitySchemes` and `security`
   - MCP Protected Resource Metadata
   - HTTP `WWW-Authenticate` responses where applicable
5. Keep anonymous purchase support possible for `/x402/access`, but allow sellers to require agent auth there.
6. Stage sender-constrained tokens after the base rollout:
   - Phase 1: bearer
   - Phase 2: DPoP
   - Phase 3: mTLS
7. Treat token exchange and delegated user context as a later phase, not the base implementation.

## Why This Approach

This matches the direction of the current agent protocols instead of inventing a Key0-specific auth system:

- MCP authorization is now explicitly OAuth-based and requires Protected Resource Metadata for discovery.
- A2A now has first-class security advertisement on the Agent Card and an authenticated extended card flow.
- OAuth gives Key0 a practical path to support both machine agents and user-delegated agents.

The architectural principle should be:

- payment proves the caller paid
- seller auth proves who the caller is
- issued access tokens prove the caller may use the purchased resource

## Research Summary

### MCP

Current MCP authorization guidance is OAuth-based. HTTP MCP servers act as protected resources and clients are expected to send `Authorization: Bearer <token>` on every request. The latest MCP authorization spec also requires Protected Resource Metadata and authorization server discovery instead of ad hoc auth configuration.

Implication for Key0:

- `/mcp` should become an optional OAuth-protected resource
- Key0 should expose Protected Resource Metadata for MCP
- `/.well-known/mcp.json` can stay public, while tool execution on `/mcp` can require auth

### A2A

Current A2A guidance keeps authentication at the HTTP transport layer and requires requirements to be declared on the Agent Card. The spec now includes:

- `securitySchemes`
- `security`
- `supportsAuthenticatedExtendedCard`
- `GET /agent/authenticatedExtendedCard`

Implication for Key0:

- the current agent card model is behind the newer A2A auth shape
- Key0 should advertise supported auth schemes on the public card
- Key0 should optionally serve an authenticated extended card for enterprise sellers

### OAuth/OIDC

OAuth 2.1 is still an active draft, but it is the right implementation target. For Key0, the practical server responsibilities are:

- validate audience-bound access tokens
- discover authorization servers via metadata
- optionally introspect opaque tokens
- optionally support sender-constrained tokens

### Sender-Constrained Tokens

DPoP is the most practical next step after bearer tokens because it works at the HTTP layer and does not require the operational complexity of mutual TLS everywhere. mTLS still matters for enterprise deployments and should remain on the roadmap.

### Delegation

OAuth token exchange is relevant when an agent acts on behalf of a user or another service, but it should be treated as a phase after the core resource-server implementation is solid.

## Current Repo Gaps

1. `src/types/agent-card.ts` does not model modern A2A auth fields like top-level `securitySchemes`, top-level `security`, or `supportsAuthenticatedExtendedCard`.
2. `src/core/agent-card.ts` cannot advertise seller auth requirements today.
3. `src/integrations/mcp.ts` exposes MCP tools but does not implement OAuth resource-server behavior or Protected Resource Metadata.
4. `src/integrations/express.ts` and `src/integrations/hono.ts` do not have a shared inbound agent-auth layer for protocol endpoints.
5. `src/middleware.ts` validates Key0-issued access tokens for protected resources, but that is different from authenticating the inbound calling agent.
6. `SellerConfig` has outbound backend auth options, but no inbound seller auth model for agents.

## Proposed Architecture

### 1. Add a Shared Inbound Auth Core

Create a new auth module for inbound seller-side agent authentication, separate from existing outbound auth helpers.

Suggested new area:

- `src/auth/`
- `src/auth/types.ts`
- `src/auth/verify.ts`
- `src/auth/jwks.ts`
- `src/auth/introspection.ts`
- `src/auth/dpop.ts`
- `src/auth/http.ts`

Core responsibilities:

- parse auth from the inbound request
- verify JWT access tokens via discovery or explicit JWKS
- optionally introspect opaque tokens
- enforce issuer, audience, expiry, and scope
- normalize an `AuthenticatedAgentPrincipal`
- optionally verify sender constraints
- return protocol-neutral error details for adapters to map into HTTP, MCP, and A2A responses

Suggested principal shape:

```ts
type AuthenticatedAgentPrincipal = {
  subject: string;
  clientId?: string;
  issuer: string;
  scopes: string[];
  audience: string[];
  actor?: Record<string, unknown>;
  tokenType: "jwt" | "opaque";
  cnf?: Record<string, unknown>;
  rawClaims?: Record<string, unknown>;
};
```

### 2. Add Seller Auth Config

Extend `SellerConfig` with an inbound auth section. Exact naming is flexible, but the shape should separate:

- auth source
- enforcement policy
- protocol exposure

Suggested direction:

```ts
type SellerAgentAuthConfig = {
  mode: "disabled" | "oauth";
  oauth?: {
    issuer?: string;
    authorizationServers?: string[];
    audience: string | string[];
    discovery: "oauth-metadata" | "oidc" | "manual";
    jwksUri?: string;
    introspection?: {
      url: string;
      clientId?: string;
      clientSecret?: string;
      authMethod?: "client_secret_basic" | "private_key_jwt";
    };
    tokenFormat?: "jwt" | "opaque" | "auto";
    binding?: "bearer" | "dpop" | "mtls";
  };
  enforcement?: {
    mcp?: "required" | "optional" | "off";
    a2a?: "required" | "optional" | "off";
    x402Access?: "required" | "optional" | "off";
    authenticatedExtendedCard?: boolean;
  };
  scopes?: {
    mcpDiscover?: string[];
    mcpAccess?: string[];
    a2aDiscover?: string[];
    a2aInvoke?: string[];
    x402Access?: string[];
    planAccess?: Record<string, string[]>;
    routeAccess?: Record<string, string[]>;
  };
};
```

Design rules:

- default remains backward-compatible: auth disabled
- auth should be configurable once and reused by all integrations
- auth on `/x402/access` should be opt-in at first

### 3. Upgrade the Agent Card Model

Update `AgentCard` typing and generation to support modern A2A auth advertisement.

Changes:

- add top-level `securitySchemes`
- add top-level `security`
- add `supportsAuthenticatedExtendedCard`
- keep existing skill-level `security` support where useful, but do not rely on that alone

Recommended seller behavior:

- public card remains minimal and fetchable anonymously by default
- if configured, authenticated callers can fetch a richer card at `/agent/authenticatedExtendedCard`
- enterprise-only skills or higher-sensitivity metadata live on the authenticated card

### 4. Protect MCP as an OAuth Resource Server

Add MCP auth support in a spec-aligned way.

Deliverables:

- require bearer tokens on `/mcp` when MCP auth is enabled
- return `401` or `403` with proper OAuth-style errors
- expose Protected Resource Metadata for the MCP resource
- point clients to one or more authorization servers
- enforce audience and scopes per tool

Recommended scope model:

- `mcp:discover`
- `mcp:access`
- optional per-plan scopes like `plan:basic`

The simplest first cut is:

- `discover` requires `mcp:discover`
- `access` requires `mcp:access`
- optionally also require `plan:{planId}` or `route:{routeId}` for gated tools

### 5. Add A2A Auth Enforcement

For Express first, then Hono, add inbound auth enforcement for:

- `/.well-known/agent.json` only if explicitly configured
- `/agent/authenticatedExtendedCard`
- A2A JSON-RPC requests routed via `/x402/access` with `X-A2A-Extensions`

Recommended policy:

- public card stays public
- authenticated extended card requires auth
- actual A2A task execution can require auth by default when A2A auth is enabled

This preserves discoverability while letting sellers protect execution.

### 6. Add Optional Auth for `/x402/access`

Do not make authenticated purchase mandatory for all sellers. Instead:

- keep current anonymous payment flow as the default
- allow sellers to require agent auth for challenge creation and payment submission
- record the authenticated principal on the challenge record for audit and downstream policy checks

This supports both:

- open commerce endpoints
- enterprise sellers that only want known agents to buy or invoke access

### 7. Audit and Policy Hooks

Once auth exists, sellers will want to make policy decisions from identity.

Add optional hooks:

- `onAgentAuthenticated(principal, requestContext)`
- `authorizeAgent(principal, actionContext)`

This avoids hardcoding all authorization rules into Key0 itself.

Potential uses:

- block certain client IDs
- require plan-specific scopes
- restrict route access by tenant
- enforce user-present vs service-only calls

## Implementation Phases

### Phase 1: Shared Auth Core and Config

Scope:

- add config types
- add inbound auth verifier
- support JWT via OIDC/OAuth discovery and explicit JWKS
- support opaque token introspection
- normalize principal object
- add tests for token validation and error mapping

Success criteria:

- protocol adapters can call one shared auth function
- auth can be enabled without changing payment logic

### Phase 2: A2A Card and Authenticated Extended Card

Scope:

- expand `AgentCard` types
- update `buildAgentCard()`
- add authenticated extended card route
- enforce auth for A2A invocation surfaces
- update A2A docs and tests

Success criteria:

- Key0 advertises A2A auth requirements correctly
- authenticated extended card is functional

### Phase 3: MCP OAuth Resource Server Support

Scope:

- protect `/mcp`
- expose Protected Resource Metadata
- add tool-level scope enforcement
- return correct `401` and `403` behaviors
- document supported OAuth flows for agent clients

Success criteria:

- an OAuth-enabled MCP client can discover auth servers and call tools with bearer tokens

### Phase 4: Optional `/x402/access` Seller Auth

Scope:

- add optional auth requirement for challenge creation and settlement submission
- persist principal metadata on the challenge
- expose identity to token-issuance and fetch-resource callbacks

Success criteria:

- sellers can require authenticated buyers without breaking current anonymous flows

### Phase 5: Sender-Constrained Tokens

Scope:

- add DPoP verification
- bind access token proof to request
- add mTLS hooks for frameworks that can surface client certs reliably

Recommendation:

- do DPoP before mTLS
- keep mTLS as an enterprise mode for Express and Fastify first

### Phase 6: Delegation and Token Exchange

Scope:

- support composite actor chains
- surface `act` claims in principals
- document user-on-behalf-of-agent patterns

This phase should only happen after the base OAuth resource-server layer is production-ready.

## Data Model and Callback Changes

Consider extending challenge records and callback params with auth context.

Possible additions:

- `authenticatedPrincipalSubject`
- `authenticatedClientId`
- `authenticatedIssuer`
- `authenticatedScopes`

This would let:

- `fetchResourceCredentials`
- `fetchResource`
- audit logging
- refunds and investigations

reason about who initiated the purchase.

## Files Likely Touched

- `src/types/config.ts`
- `src/types/agent-card.ts`
- `src/core/agent-card.ts`
- `src/factory.ts`
- `src/integrations/express.ts`
- `src/integrations/hono.ts`
- `src/integrations/mcp.ts`
- `src/middleware.ts`
- `src/types/challenge.ts`
- `src/types/index.ts`
- `docs/mintlify/api-reference/agent-card.mdx`
- `docs/mintlify/protocol/a2a-flow.mdx`
- `docs/mintlify/protocol/mcp.mdx`
- `README.md`

New files:

- `src/auth/*`
- protocol-specific tests
- example seller configs for OAuth-protected MCP and A2A

## Test Plan

Add unit and integration coverage for:

- JWT validation via discovery and JWKS
- opaque token introspection
- audience and issuer rejection
- scope-based `403`
- MCP `401` challenge behavior
- A2A public card plus authenticated extended card flow
- optional `/x402/access` auth requirement
- DPoP replay and hash validation in later phase

Priority test files:

- `src/auth/__tests__/verify.test.ts`
- `src/integrations/__tests__/mcp-auth.test.ts`
- `src/__tests__/a2a-auth.test.ts`
- `src/__tests__/x402-auth.test.ts`

## Open Questions

1. Should Key0 ship only resource-server behavior, or also an opinionated built-in OAuth server?
   Recommendation: resource server only.

2. Should public discovery stay anonymous?
   Recommendation: yes for public card and MCP discovery docs; use authenticated extended card for richer metadata.

3. Should `/x402/access` require auth by default once the feature exists?
   Recommendation: no. Keep opt-in to avoid breaking open commerce use cases.

4. Should per-plan and per-route authorization be expressed only in seller hooks, or also in built-in scope mapping?
   Recommendation: both. Ship a simple built-in scope mapper plus override hooks.

5. Do we need to upgrade `@a2a-js/sdk` to align with the latest A2A auth fields?
   Recommendation: yes, or patch around the current version temporarily while planning an upgrade.

## Recommended Order of Work

1. Add shared inbound auth types and verifier.
2. Expand config surface.
3. Upgrade Agent Card generation to advertise auth.
4. Add authenticated extended card route.
5. Protect `/mcp` and publish Protected Resource Metadata.
6. Add optional auth to `/x402/access`.
7. Add DPoP.
8. Add mTLS.
9. Add token exchange and delegated actor support.

## Non-Goals for the First Iteration

- building a full authorization server
- inventing a Key0-specific agent identity format
- requiring auth for all existing public flows
- solving cross-chain payment identity
- shipping mTLS across every runtime from day one

## Suggested Issue Title

`feat: add seller-side agent authentication across MCP, A2A, and x402`

## Sources

- MCP Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- A2A Specification: https://a2aproject.github.io/A2A/latest/specification/
- A2A Enterprise Features: https://a2aproject.github.io/A2A/latest/topics/enterprise-ready/
- OAuth 2.1 draft: https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
- RFC 9728 Protected Resource Metadata: https://www.rfc-editor.org/rfc/rfc9728
- RFC 8414 Authorization Server Metadata: https://www.rfc-editor.org/rfc/rfc8414
- RFC 9068 JWT Profile for OAuth 2.0 Access Tokens: https://www.rfc-editor.org/rfc/rfc9068
- RFC 7662 Token Introspection: https://www.rfc-editor.org/rfc/rfc7662.html
- RFC 9449 DPoP: https://www.rfc-editor.org/rfc/rfc9449.html
- RFC 8705 OAuth mTLS: https://www.rfc-editor.org/rfc/rfc8705.html
- RFC 8693 Token Exchange: https://www.rfc-editor.org/rfc/rfc8693
