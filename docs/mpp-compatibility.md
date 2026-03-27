# MPP (Machine Payments Protocol) — Key0 Compatibility Notes

[MPP](https://mpp.dev/overview) is an open, IETF-proposed standard for machine-to-machine payments
over HTTP. It generalises exactly what x402 does today: a `402 Payment Required` challenge/credential
round-trip that is payment-rail agnostic.

This document captures everything relevant to Key0 for a potential MPP-compatibility layer or migration.

---

## What MPP Is

MPP standardises HTTP 402 "Payment Required" as a proper authentication scheme, similar to how
`WWW-Authenticate: Bearer` works for tokens but for payments.

Three parties:

- **Developers / Agents** — clients that discover, pay for, and call APIs without pre-signup.
- **Services** — APIs that accept payments with zero onboarding friction.
- **Payment Methods** — pluggable rails (Tempo stablecoins, Stripe, Lightning, custom).

---

## Core Flow (identical in spirit to Key0 x402)

```
Client  →  GET /resource
Server  ←  402  WWW-Authenticate: Payment id="…", method="tempo", intent="charge", request="…"
Client  →  GET /resource  Authorization: Payment <base64url-credential>
Server  ←  200  Payment-Receipt: <base64url-receipt>
```

Key0's current x402 flow (`AccessRequest → X402Challenge → PaymentProof → AccessGrant`) maps
directly onto the MPP Challenge/Credential/Receipt primitives.

---

## Protocol Concepts

### HTTP 402

- Return `402` when a resource requires payment **and** a challenge can be provided.
- Return `401` only for token auth failures (not payment-related).
- Return `403` if payment succeeded but policy denies access.
- Always include `Cache-Control: no-store` on `402` responses.
- Failed credential validation also returns `402` (fresh challenge + Problem Details RFC 9457 body).

Error types (`https://paymentauth.org/problems/{code}`):

| Code | Meaning |
|---|---|
| `payment-required` | Resource requires payment |
| `payment-insufficient` | Amount too low |
| `payment-expired` | Challenge or authorization expired |
| `verification-failed` | Proof invalid |
| `method-unsupported` | Method not accepted |
| `malformed-credential` | Invalid credential format |
| `invalid-challenge` | Challenge ID unknown, expired, or already used |

### Challenges (`WWW-Authenticate: Payment …`)

```
WWW-Authenticate: Payment id="qB3wErTyU7iOpAsD9fGhJk",
                  realm="mpp.dev",
                  method="tempo",
                  intent="charge",
                  expires="2025-01-15T12:05:00Z",
                  request="<base64url-JSON>"
```

**Required fields:** `id`, `realm`, `method`, `intent`, `request`
**Optional:** `expires`, `description`

`request` is a base64url-encoded JSON object with method-specific fields:

```json
{
  "amount": "1000",
  "currency": "usd",
  "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
}
```

**Security:** The `id` must be cryptographically bound (e.g., HMAC) to the challenge parameters
to prevent clients from reusing an ID with modified payment terms.

**Multiple challenges:** Servers can emit multiple `WWW-Authenticate: Payment` headers (one per
method), and clients pick one.

**Request body binding:** For POST/PUT/PATCH, servers can include a `digest` param (RFC 9530
`Content-Digest`) to bind the challenge to the request body, preventing body substitution attacks.

### Credentials (`Authorization: Payment …`)

The credential is a `base64url`-encoded JSON object sent in `Authorization: Payment <token>`:

```json
{
  "challenge": { "id": "…", "realm": "…", "method": "tempo", "intent": "charge", "request": "…", "expires": "…" },
  "source": "0x1234…",
  "payload": { "signature": "0xabc…" }
}
```

Each credential is **single-use** — servers must reject replays.

### Receipts (`Payment-Receipt: …`)

Optional header on `200` responses; base64url-encoded JSON:

```json
{
  "challengeId": "qB3wErTyU7iOpAsD9fGhJk",
  "method": "tempo",
  "reference": "0xtx789abc…",
  "settlement": { "amount": "1000", "currency": "usd" },
  "status": "success",
  "timestamp": "2025-01-15T12:00:00Z"
}
```

Enables auditing, dispute resolution, and reconciliation on the client side.

---

## Transports

### HTTP (primary)

| Direction | Header | Purpose |
|---|---|---|
| Server → Client | `WWW-Authenticate: Payment …` | Challenge |
| Client → Server | `Authorization: Payment …` | Credential |
| Server → Client | `Payment-Receipt: …` | Receipt |

### MCP / JSON-RPC

MPP encodes the same Challenge/Credential/Receipt primitives in MCP JSON-RPC:

| MPP Concept | MCP Encoding |
|---|---|
| Challenge | JSON-RPC error code `-32042` |
| Credential | `_meta["org.paymentauth/credential"]` in `tools/call` params |
| Receipt | `_meta["org.paymentauth/receipt"]` in result |

**Challenge (server → agent):**
```json
{
  "jsonrpc": "2.0", "id": 1,
  "error": {
    "code": -32042,
    "message": "Payment Required",
    "data": {
      "httpStatus": 402,
      "challenges": [{ "id": "ch_abc123", "realm": "…", "method": "tempo", "intent": "charge", "request": { … } }]
    }
  }
}
```

**Credential (agent → server):**
```json
{
  "jsonrpc": "2.0", "id": 2,
  "method": "tools/call",
  "params": {
    "name": "web-search",
    "arguments": { "query": "…" },
    "_meta": { "org.paymentauth/credential": { "challenge": { … }, "source": "0x…", "payload": { … } } }
  }
}
```

Key0 already has a `mcp: true` integration mode. An MPP-native MCP transport would swap the
custom `structuredContent`/`isError` signalling for the standard `-32042` error code and
`_meta.org.paymentauth/*` fields.

---

## Payment Methods & Intents

**Available methods (production):** `tempo` (TIP-20 stablecoins, sub-second settlement), `stripe`
**In-spec:** `card`, `lightning`

**Intent types:**
- `charge` — one-time immediate settlement
- `session` — streaming payment over a payment channel

Key0 currently implements x402 with Base/USDC — this maps to the `tempo` method concept.

### Custom Methods

Anyone can define a new method by specifying:
1. Method identifier (lowercase ASCII)
2. `request` schema (what the server asks for)
3. `payload` schema (what the client provides as proof)
4. Verification procedure
5. Settlement procedure

A Key0-compatible custom MPP method could wrap the existing ERC-20 Transfer + viem verification
in `src/adapter/`.

---

## Security Invariants (aligned with Key0 SPEC.md)

MPP's spec mandates the same invariants Key0 already enforces:

| Invariant | MPP Requirement | Key0 Implementation |
|---|---|---|
| Single-use proofs | Credentials valid for exactly one request; replay must be rejected | `ISeenTxStore.markUsed()` atomic SET NX |
| No side effects before payment | Servers must not perform side effects for unpaid requests | `preSettlementCheck()` guard |
| Amount verification | Clients must verify amount, recipient, currency, validity window | Client-side before signing |
| TLS required | TLS 1.2+ required for all Payment flows | Standard HTTPS deployment |
| No credential logging | Payment credentials must not appear in logs/errors/analytics | Key0 does not log raw proofs |
| Challenge binding | `id` must be cryptographically bound to parameters | Key0 uses HMAC-bound challenge IDs |
| Idempotency | Non-idempotent methods should accept `Idempotency-Key` | x402 challenges are idempotent by design |

---

## Key Differences vs Key0's Current x402

| Dimension | Key0 x402 Today | MPP |
|---|---|---|
| Header scheme | Custom `X-402-*` headers + `PaymentRequirements` JSON body | Standard `WWW-Authenticate: Payment` / `Authorization: Payment` |
| Challenge encoding | JSON body in `402` response | `auth-params` in `WWW-Authenticate` header |
| Credential encoding | Custom `PaymentPayload` object | `base64url` JSON in `Authorization: Payment` header |
| Receipt | `AccessGrant` JWT | `Payment-Receipt` base64url-JSON header (optional) |
| Payment method | ERC-20 USDC on Base | Any rail via pluggable `method` param |
| Error codes | HTTP-level + problem strings | RFC 9457 Problem Details with typed URIs |
| MCP binding | Custom `isError`+`structuredContent` | Standard `-32042` + `_meta` |
| Multi-method | Single method per endpoint | Multiple `WWW-Authenticate` headers, client picks |

---

## Migration / Compatibility Surface in Key0

The following components would need updates to speak native MPP:

### `src/core/challenge-engine.ts`
- `requestHttpAccess` / `processHttpPayment`: emit `WWW-Authenticate: Payment …` instead of custom response body.
- Error responses: wrap in RFC 9457 Problem Details with typed `https://paymentauth.org/problems/…` URIs.

### `src/integrations/` (Express, Hono, Fastify, MCP)
- HTTP middleware: parse `Authorization: Payment <base64url>` instead of current `PaymentPayload` format.
- MCP integration: replace custom `structuredContent`/`isError` with JSON-RPC error `-32042` and `_meta.org.paymentauth/*`.

### `src/adapter/` (`X402Adapter`)
- Verification interface stays the same; only the credential envelope changes (MPP `payload` object instead of current `PaymentPayload`).

### `src/integrations/settlement.ts`
- `buildHttpPaymentRequirements`: emit MPP-format `WWW-Authenticate` header string.
- `decodePaymentSignature`: decode from MPP credential JSON instead of current format.

### New: Receipt header
- Key0 currently issues a signed JWT (`AccessGrant`) as the grant mechanism.
- Under MPP, the `200` response would carry a `Payment-Receipt` header, and the application credential (JWT/API key) would be issued separately or embedded in the receipt's `reference` field.

---

## Opportunity: Key0 as MPP Server

Key0's architecture is a near-perfect fit for an MPP server implementation:

- The state machine (`PENDING → PAID → DELIVERED`) maps to the MPP request/challenge/credential/receipt lifecycle.
- `IChallengeStore` can store MPP-format challenges directly.
- `ISeenTxStore` satisfies MPP's single-use credential requirement.
- The existing `X402Adapter` verifies on-chain transfers — this becomes the `verify` procedure for a custom `key0-usdc` MPP method.
- `IAuditStore` provides the audit trail MPP receipts are designed for.

A future `createMppKey0()` factory could expose a fully MPP-compliant server while reusing
all existing storage, adapter, and token-issuance infrastructure.

---

## References

- [MPP Overview](https://mpp.dev/overview)
- [MPP Protocol Concepts](https://mpp.dev/protocol)
- [MPP HTTP Transport](https://mpp.dev/protocol/transports/http)
- [MPP MCP Transport](https://mpp.dev/protocol/transports/mcp)
- [MPP Custom Methods](https://mpp.dev/payment-methods/custom)
- [IETF Specification](https://paymentauth.org/)
- [mppx TypeScript SDK](https://mpp.dev/sdk)
