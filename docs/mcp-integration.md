# MCP Integration

`src/integrations/mcp.ts` exposes AgentGate's payment-gated products as MCP tools. Any MCP client — Claude Desktop, Cursor, Claude Code, or custom agents — can discover products and purchase access tokens through the x402 payment protocol.

Reference spec: https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md

---

## Architecture

```
MCP Client (Claude/Cursor/Claude Code)
    │
    │  POST /mcp  (JSON-RPC over Streamable HTTP)
    ▼
┌─────────────────────────────────────────────────────┐
│  Express Router                                      │
│  └─ POST /mcp handler                               │
│       │                                              │
│       ├─ new McpServer()          ← fresh per request│
│       ├─ new Transport({})           (stateless)     │
│       ├─ server.connect(transport)                   │
│       └─ transport.handleRequest()                   │
│            │                                         │
│            ▼                                         │
│       Tool dispatch                                  │
│       ├─ discover_products        ← free, reads config
│       └─ request_access           ← x402 payment-gated
│            │                                         │
│            ├─ No payment? → isError + PaymentRequired│
│            │                    ↓                    │
│            │   Agent uses payments-mcp to POST       │
│            │   to /x402/access with PAYMENT-SIGNATURE│
│            │                                         │
│            └─ Has _meta["x402/payment"]?             │
│                 → settlePayment() → processHttpPayment()
│                 → AccessGrant + _meta["x402/payment-response"]
│                                                      │
│       ChallengeEngine  ← shared instance, Redis-backed
└─────────────────────────────────────────────────────┘
```

### Exports

1. **`createMcpServer(engine, config)`** — Creates an `McpServer` with two tools registered.
2. **`mountMcpRoutes(router, engine, config)`** — Mounts the MCP transport + discovery endpoint onto an Express Router.

### Seller Config

No new config fields. Set `mcp: true` in `SellerConfig` and define `products` as usual:

```ts
const config: SellerConfig = {
  mcp: true,
  products: [{ tierId: "basic", amount: "$0.99", label: "Basic Access", resourceType: "api-call" }],
  // ... standard config
};
```

---

## Tools

| Tool | Gated? | Purpose |
|------|--------|---------|
| `discover_products` | Free | Browse catalog: tiers, prices, wallet, chainId |
| `request_access` | x402 | Purchase an access token for a tier |

---

## Payment Flow

Two paths are supported. Both produce the same result: an `AccessGrant` with a JWT.

### Path A: HTTP x402 (current MCP clients)

Current MCP clients (Claude, Cursor) are NOT natively x402-aware — they can't inject `_meta["x402/payment"]`. Instead, the agent uses `payments-mcp` to complete payment via the HTTPS x402 endpoint.

```
1. Agent → discover_products
   ← catalog JSON (free)

2. Agent → request_access({ tierId: "basic" })
   ← isError: true + structuredContent (x402 PaymentRequired)
     includes x402PaymentUrl and paymentInstructions

3. Agent → payments-mcp make_http_request_with_x402:
     URL:    x402PaymentUrl (e.g. https://server.com/x402/access)
     method: POST
     body:   { tierId: "basic", resourceId: "default" }
     paymentRequirements: accepts array from step 2

4. payments-mcp signs EIP-3009 off-chain, sends PAYMENT-SIGNATURE header

5. /x402/access settles on-chain, returns AccessGrant with JWT
```

### Path B: Native x402 MCP (future x402-aware clients)

For clients implementing the x402 MCP transport spec (e.g. Cloudflare `withX402Client`):

```
1. Agent → request_access({ tierId: "basic" })
   ← isError: true + structuredContent (x402 PaymentRequired)

2. Client automatically signs EIP-3009 and retries with _meta["x402/payment"]

3. Server settles via settlePayment()
   ← AccessGrant + _meta["x402/payment-response"]
```

---

## Response Formats

### PaymentRequired (no payment provided)

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

`structuredContent` follows the x402 MCP spec exactly. `content[0].text` adds two extra fields for non-x402-native clients:
- `x402PaymentUrl` — the HTTPS endpoint to POST to with `payments-mcp`
- `paymentInstructions` — human-readable instructions for the agent

### AccessGrant (payment successful)

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"status\":\"access_granted\",\"accessToken\":\"eyJ...\",\"expiresAt\":\"...\",\"txHash\":\"0x...\",\"explorerUrl\":\"...\"}"
    }
  ],
  "_meta": {
    "x402/payment-response": {
      "success": true,
      "transaction": "0xabc...",
      "network": "eip155:84532",
      "payer": "0xPayer"
    }
  }
}
```

### Error Cases

| Error | Response |
|-------|----------|
| Payment failed / settlement error | `isError: true` + `structuredContent` with error message and `accepts[]` (client can retry) |
| Already redeemed (`PROOF_ALREADY_REDEEMED`) | Returns cached `AccessGrant` (idempotent) |
| Tier not found | `isError: true` + `AgentGateError` JSON |
| Unknown error | Re-thrown (MCP SDK returns JSON-RPC error) |

---

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/.well-known/mcp.json` | GET | MCP discovery document (name, version, transport URL) |
| `/mcp` | POST | Streamable HTTP transport — handles all JSON-RPC messages |
| `/mcp` | GET | 405 — SSE not supported in stateless mode |
| `/mcp` | DELETE | 405 — session management not supported in stateless mode |

---

## Transport: Streamable HTTP (Stateless)

### Why Streamable HTTP?

| Transport | How it works | Use case |
|-----------|-------------|----------|
| **stdio** | stdin/stdout pipes | Local CLI tools (subprocess) |
| **SSE** (legacy) | HTTP POST + Server-Sent Events | Older remote servers (deprecated) |
| **Streamable HTTP** | HTTP POST for everything | Remote servers (current standard) |

We use Streamable HTTP because:
- Server runs on a URL, not as a subprocess (stdio impossible)
- Works behind load balancers, proxies, CDNs
- Claude Desktop, Cursor, Claude Code all support `"type": "http"`
- Mounts naturally onto Express alongside A2A and x402 routes

### Why Stateless?

Every `POST /mcp` creates a fresh `McpServer` + `StreamableHTTPServerTransport`:

```ts
router.post("/mcp", async (req, res) => {
    const server = createMcpServer(engine, config);
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    await server.close();
});
```

Reasons:
- Tools are pure request/response — no conversation state, no streaming
- All state lives in Redis (ChallengeStore, SeenTxStore), not the MCP layer
- Scales horizontally without sticky sessions
- No memory leaks from abandoned sessions
- MCP SDK enforces it: stateless transports cannot be reused across requests

Each tool call is an independent HTTP POST. No WebSocket, no keep-alive. The client sends `initialize` → `tools/list` → `tools/call`, each as separate requests.

### Object Allocation Per Request

Every POST creates ~2 objects (server + transport) and ~2 `registerTool` calls. This is trivial — AgentGate's MCP flow is 2-3 requests per purchase. The expensive work (on-chain settlement, Redis) happens in the shared `ChallengeEngine`.

---

## Implementation Details

### Code Reuse

The MCP integration reuses existing infrastructure with no changes:

| Component | From | Purpose |
|-----------|------|---------|
| `buildHttpPaymentRequirements()` | `settlement.ts` | Builds x402 v2 `accepts[]` array |
| `settlePayment()` | `settlement.ts` | Facilitator or gas wallet settlement |
| `engine.processHttpPayment()` | `challenge-engine.ts` | Full lifecycle: create challenge → verify → issue token |
| `X402PaymentPayload`, `X402SettleResponse` | `x402-extension.ts` | x402 protocol types |

### Request IDs

Each `request_access` call generates `mcp-${crypto.randomUUID()}`. In Path A (HTTP x402), the MCP tool only returns payment requirements — the actual payment goes through `/x402/access` which generates its own request ID. In Path B (native `_meta`), the same request ID is used for settlement and token issuance.

### Testing with curl

The MCP SDK validates headers strictly:

```bash
curl -X POST https://server.com/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Without both `Accept` values, the SDK returns 406.
