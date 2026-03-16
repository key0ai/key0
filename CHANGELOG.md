# @key0ai/key0

## 0.2.0

### Minor Changes

---

## "@key0ai/key0": minor

- Add a dedicated `GET /discovery` endpoint that returns `200` with a machine-readable X402 discovery payload, and inject discovery hints into the agent card to improve agent discoverability.
- Change `POST /x402/access` without `planId` to return `400` pointing clients to `GET /discovery`, and align e2e tests and examples with the new discovery flow.
- Overhaul documentation to match the unified `/x402/access` endpoint and discovery flow, update README and agent card docs, and remove a vulnerable dependency.

### Patch Changes

- 6a0926b: Unified x402 payment endpoint: consolidate `/a2a/jsonrpc` and x402 HTTP flows into a single `/x402/access` endpoint with header-based routing (`X-A2A-Extensions`). Removes `x402-http-middleware.ts` bridge file. Adds full `/x402/access` implementation to Hono and Fastify integrations. Updates settlement `resourceUrl`, challenge descriptions, tests, and examples.
