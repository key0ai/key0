# @key0ai/key0

## 0.4.0

### Minor Changes

- Add Agent CLI builder and branded binary distribution.

  ### CLI builder (`./cli` subpath)

  - `buildCli(opts)` compiles a standalone branded binary with the service URL baked in — sellers distribute it so agents can install and use their API by name without any SDK setup.
  - `cli-template.ts` implements `discover`, `request`, `install`, `help`, and `version` commands; all output is machine-readable JSON.
  - Exit code `42` signals a 402 payment challenge (payment required); `0` is success.
  - `--install` writes the binary to `~/.local/bin/<name>` and reports whether it is on `$PATH`.
  - New `./cli` subpath export in `package.json`.

- fd880a1: Add pay-per-request mode and gateway proxy with free plans, per-plan routing, internal auth, and refund-on-failure.

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

## 0.2.0

### Minor Changes

---

## "@key0ai/key0": minor

- Add a dedicated `GET /discovery` endpoint that returns `200` with a machine-readable X402 discovery payload, and inject discovery hints into the agent card to improve agent discoverability.
- Change `POST /x402/access` without `planId` to return `400` pointing clients to `GET /discovery`, and align e2e tests and examples with the new discovery flow.
- Overhaul documentation to match the unified `/x402/access` endpoint and discovery flow, update README and agent card docs, and remove a vulnerable dependency.

### Patch Changes

- 6a0926b: Unified x402 payment endpoint: consolidate `/a2a/jsonrpc` and x402 HTTP flows into a single `/x402/access` endpoint with header-based routing (`X-A2A-Extensions`). Removes `x402-http-middleware.ts` bridge file. Adds full `/x402/access` implementation to Hono and Fastify integrations. Updates settlement `resourceUrl`, challenge descriptions, tests, and examples.
