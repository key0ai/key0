---
"@key0ai/key0": patch
---

Unified x402 payment endpoint: consolidate `/a2a/jsonrpc` and x402 HTTP flows into a single `/x402/access` endpoint with header-based routing (`X-A2A-Extensions`). Removes `x402-http-middleware.ts` bridge file. Adds full `/x402/access` implementation to Hono and Fastify integrations. Updates settlement `resourceUrl`, challenge descriptions, tests, and examples.
