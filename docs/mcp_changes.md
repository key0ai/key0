# MCP x402 Native Adoption — Change Specification

## Summary

Refactor the MCP integration (`src/integrations/mcp.ts`) to use the x402 MCP transport spec natively. Instead of a custom two-step tool-argument flow, payment signaling uses `isError: true` + `structuredContent` and payment is completed via the HTTPS x402 endpoint.

**No config changes required.** `mcp: true` + `products: [...]` remains the seller API.

Reference spec: https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md

---

## Tools

| Tool | Gated? | Purpose |
|------|--------|---------|
| `discover_products` | Free | Browse catalog: tiers, prices, wallet, chainId |
| `request_access` | x402-gated | Purchase an access token for a tier |

`request_product_access` is renamed to `request_access` for brevity.

---

## Payment Flow

Two paths are supported for completing payment:

### Path A: HTTP x402 (current MCP clients — Claude, Cursor, etc.)

Current MCP clients are NOT natively x402-aware. They can't inject `_meta["x402/payment"]`.
Instead, payment is routed through the HTTPS x402 endpoint using `payments-mcp`.

```
1. Agent calls discover_products → gets catalog (free)
2. Agent calls request_access(tierId) → gets isError with PaymentRequired
   - Response includes x402PaymentUrl (HTTPS) and paymentInstructions
   - resource.url points to the HTTPS x402 endpoint
3. Agent uses payments-mcp make_http_request_with_x402:
   - URL: x402PaymentUrl (e.g. https://server.com/x402/access)
   - method: POST
   - body: { tierId, resourceId }
   - paymentRequirements: the accepts array from step 2
4. payments-mcp signs EIP-3009, sends PAYMENT-SIGNATURE header
5. Server settles, returns access grant with JWT
```

### Path B: Native x402 MCP (future x402-aware clients)

For clients that implement the x402 MCP transport spec (e.g. Cloudflare `withX402Client`):

```
1. Agent calls request_access(tierId) → gets isError with structuredContent
2. Client automatically signs EIP-3009 and retries with _meta["x402/payment"]
3. Server settles via settlePayment(), returns grant + _meta["x402/payment-response"]
```

---

## Response Format

### Step 1 — Request access (no payment)

```
Client → tools/call("request_access", { tierId: "basic" })
```

Server returns x402 PaymentRequired:

```json
{
  "isError": true,
  "structuredContent": {
    "x402Version": 2,
    "error": "Payment required to access this resource",
    "resource": {
      "url": "https://server.com/x402/access",
      "description": "Access to default",
      "mimeType": "application/json"
    },
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:84532",
        "amount": "990000",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "payTo": "0xSellerWallet",
        "maxTimeoutSeconds": 300,
        "extra": {
          "name": "USDC",
          "version": "2",
          "description": "Basic Access — $0.99 USDC"
        }
      }
    ]
  },
  "content": [
    {
      "type": "text",
      "text": "<structuredContent + x402PaymentUrl + paymentInstructions>"
    }
  ]
}
```

The `content[0].text` includes additional fields for non-x402-native clients:
- `x402PaymentUrl`: the HTTPS endpoint to POST to with `payments-mcp`
- `paymentInstructions`: human-readable instructions for the agent

### Step 2 — Complete payment

**Via HTTP (Path A):** Agent uses `make_http_request_with_x402` to POST to `x402PaymentUrl`.

**Via _meta (Path B):** Agent retries `request_access` with `_meta["x402/payment"]`.

Both paths return an access grant with JWT.

---

## What Changes in Code

### `src/integrations/mcp.ts`

1. **`discover_products` tool** — No change. Stays free.

2. **`request_product_access` → `request_access`** — Rewritten:
   - Remove `txHash` and `fromAddress` from inputSchema (payment comes via HTTP or `_meta`)
   - On call without `_meta["x402/payment"]`:
     - Build `X402PaymentRequiredResponse` using `buildHttpPaymentRequirements()`
     - `resource.url` points to the HTTPS x402 endpoint (not `mcp://`)
     - `content[0].text` includes `x402PaymentUrl` and `paymentInstructions` for agent guidance
     - Return `isError: true` + `structuredContent`
   - On call with `_meta["x402/payment"]` (Path B):
     - Extract `X402PaymentPayload` from `_meta["x402/payment"]`
     - Call `settlePayment()` then `engine.processHttpPayment()`
     - Return grant + `_meta["x402/payment-response"]`

3. **Error handling** — Payment failures return `isError: true` + `structuredContent` with the error message and accepts array (so client can retry). `PROOF_ALREADY_REDEEMED` returns cached grant.

4. **Tool description** — Explicitly guides the agent to use `make_http_request_with_x402` with the `x402PaymentUrl`.

### Existing code reused (no changes)

- `settlement.ts` — `settlePayment()`, `buildHttpPaymentRequirements()`
- `x402-extension.ts` — All x402 types
- `challenge-engine.ts` — `requestHttpAccess()`, `processHttpPayment()`
- `config.ts` — `SellerConfig` unchanged
- `mountMcpRoutes()` — Routes unchanged

---

## Migration Notes

- `request_product_access` tool name changes to `request_access`. Clients using the old name will get "tool not found".
- The `txHash` / `fromAddress` tool arguments are removed.
- Payment is now completed via the HTTPS x402 endpoint (`/x402/access`) using `payments-mcp`, or via `_meta["x402/payment"]` for native x402 MCP clients.
- `discover_products` is unchanged and fully backward compatible.
