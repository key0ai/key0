---
"@key0ai/key0": minor
---

---

## "@key0ai/key0": minor

- Add a dedicated `GET /discovery` endpoint that returns `200` with a machine-readable X402 discovery payload, and inject discovery hints into the agent card to improve agent discoverability.
- Change `POST /x402/access` without `planId` to return `400` pointing clients to `GET /discovery`, and align e2e tests and examples with the new discovery flow.
- Overhaul documentation to match the unified `/x402/access` endpoint and discovery flow, update README and agent card docs, and remove a vulnerable dependency.
