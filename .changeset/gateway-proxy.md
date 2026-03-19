---
"@key0ai/key0": minor
---

Add pay-per-request mode and gateway proxy with free plans, per-plan routing, internal auth, and refund-on-failure.

### Pay-per-request mode
- New `mode: "per-request"` plan option: clients pay per API call instead of subscribing — no JWT is issued, the backend response is returned inline.
- `payPerRequest(planId)` middleware factory for embedded route-level gating — settles payment inline and calls `next()`.
- Standalone gateway support via `POST /x402/access` with `resource: { method, path }` — Key0 proxies to the backend after settlement and returns the response as a `ResourceResponse`.
- Full MCP transport support: `request_access` tool accepts per-request plans and returns the proxied response via `structuredContent`.

### Gateway proxy
- **Free plans**: Plans with `free: true` bypass the 402 challenge flow entirely — requests are proxied immediately with no payment. Discovery surfaces `free: true` and `amount: "0"`.
- **Per-plan `proxyPath`**: Each plan can define its own `proxyPath` with URL template interpolation (e.g. `/api/weather/:city`), enabling a single Key0 gateway to proxy to multiple backend routes.
- **Internal auth (`proxySecret`)**: `proxyTo.proxySecret` injects an `X-Key0-Internal-Token` header on proxied requests so backends can verify requests originated from Key0.
- **Refund-on-failure**: Paid per-request proxy calls that receive a non-2xx backend response or timeout automatically transition to `REFUND_PENDING`, protecting buyers from paying for failed requests.
- **Proxy-only mode**: Key0 can act as a complete API gateway for language-agnostic backends without requiring a `fetchResourceCredentials` callback.

### Engine & internals
- New engine methods: `assertPaidState()`, `initiateRefund()`, `recordPerRequestPayment()`, `markDelivered()`.
- New settlement helpers: `settleViaFacilitator`, `settleViaGasWallet`, unified `settlePayment` entry point with auto-strategy selection and `withGasWalletLock` serialisation.
- URL template interpolation utility with path traversal protection.
- `rpcUrl` config option to override the public RPC for all on-chain operations.
