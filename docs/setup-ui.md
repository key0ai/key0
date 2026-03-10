# Setup UI — How It Works

The Setup UI is a browser-based configuration wizard for Key2a's Standalone (Docker) mode. It runs in two contexts:

1. **Inside Docker** — configure and launch Key2a directly from the browser
2. **Standalone** — generate `.env` files, `docker run` commands, or `docker-compose.yml` to copy

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Docker Container                                                    │
│                                                                      │
│  entrypoint.sh (loop)                                                │
│    │                                                                 │
│    ├── source /app/config/.env.runtime  (if exists)                  │
│    ├── bun run docker/server.ts                                      │
│    │     │                                                           │
│    │     ├── No config? → Setup Mode                                 │
│    │     │     ├── GET  /          → redirect to /setup              │
│    │     │     ├── GET  /setup     → serves React SPA (ui/dist/)    │
│    │     │     ├── GET  /api/setup/status → { configured: false }   │
│    │     │     └── POST /api/setup → writes .env.runtime, exit(42)  │
│    │     │                                                           │
│    │     └── Has config? → Running Mode                              │
│    │           ├── Full Key2a server (agent card, A2A, x402, MCP)   │
│    │           ├── GET  /setup     → still serves UI for reconfig   │
│    │           ├── GET  /api/setup/status → { configured: true }    │
│    │           └── POST /api/setup → writes .env.runtime, exit(42)  │
│    │                                                                 │
│    └── exit code 42? → restart loop (picks up new .env.runtime)     │
│                                                                      │
│  /app/config/  ← Docker volume (key2a-config), persists across      │
│                  docker compose down/up cycles                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|---|---|
| `docker/server.ts` | Express server — Setup Mode + Running Mode |
| `docker/entrypoint.sh` | Shell loop: sources `.env.runtime`, runs server, restarts on exit 42 |
| `docker/docker-compose.yml` | Compose file with Redis + config volume |
| `docker/.env.example` | Annotated env var reference |
| `ui/src/App.tsx` | React SPA root — form + output panel |
| `ui/src/components/PlanEditor.tsx` | Plan configuration form (features, tags, duration presets) |
| `ui/src/generate.ts` | Generates `.env`, `docker run`, and `docker-compose.yml` output |
| `ui/src/types.ts` | `Config` and `Plan` TypeScript types for the UI |

---

## Modes

### 1. Setup Mode (no config)

When required env vars (`KEY2A_WALLET_ADDRESS`, `ISSUE_TOKEN_API`, `REDIS_URL`) are missing, the server boots into Setup Mode:

- `GET /` redirects to `/setup`
- `/setup` serves the React SPA from `ui/dist/`
- `/api/setup/status` returns `{ configured: false }` — the UI reads this and shows the "Not Configured" badge
- `POST /api/setup` accepts the full config JSON, writes `/app/config/.env.runtime`, and exits with code 42

The entrypoint shell script detects exit code 42, sources the new `.env.runtime`, and restarts the server — which now has all required env vars and boots into Running Mode.

### 2. Running Mode (configured)

The full Key2a server starts with all endpoints:

- `/.well-known/agent.json` — agent card with pricing
- `/x402/access` — x402 HTTP payment flow
- `/a2a/jsonrpc` — A2A protocol endpoint
- `/health` — health check
- `/setup` — Setup UI still available for reconfiguration

**Note:** In Running Mode, `POST /api/setup` is currently unprotected — anyone who can reach the server can reconfigure it. This is acceptable for Docker-internal use where the port is not exposed publicly. For production deployments, restrict access to `/api/setup` via network policy or a reverse proxy.

### 3. Standalone Mode (outside Docker)

When the UI is opened directly (e.g. `cd ui && bun run dev`), the `/api/setup/status` fetch fails. The UI falls back to **standalone mode** — a pure config generator with no save button. Instead, the right panel shows three output tabs:

| Tab | Output |
|---|---|
| `.env` | Environment file ready to copy into `docker/.env` |
| `docker run` | One-liner with all `-e` flags |
| `docker-compose.yml` | Full compose file including Redis (and Postgres if selected) |

---

## Config Flow (Docker)

```
User fills form → clicks "Save & Launch"
    │
    ▼
POST /api/setup  { walletAddress, issueTokenApi, plans, ... }
    │
    ▼
server.ts:
  1. Builds .env content (shell-safe quoting, base64 for plans)
  2. Writes /app/config/.env.runtime
  3. Responds { success: true }
  4. Exits with code 42 after 500ms
    │
    ▼
entrypoint.sh:
  1. Detects exit code 42
  2. Sources .env.runtime (set -a / . / set +a)
  3. Restarts: bun run docker/server.ts
    │
    ▼
server.ts (Running Mode):
  - Reads PLANS_B64, decodes to Plan[]
  - Initializes Redis/Postgres storage
  - Mounts key2aRouter with full config
  - Starts refund cron (BullMQ)
```

### Plans Encoding

Plans are serialized as **base64-encoded JSON** in the env var `PLANS_B64` to avoid shell quoting issues with nested JSON:

```
UI form → JSON.stringify(plans) → Buffer.from(...).toString("base64") → PLANS_B64=eyJwbGFu...
```

On startup, `docker/server.ts` decodes:
```typescript
if (process.env.PLANS_B64) {
  plans = JSON.parse(Buffer.from(process.env.PLANS_B64, "base64").toString("utf-8"));
} else if (process.env.PLANS) {
  plans = JSON.parse(process.env.PLANS);
} else {
  plans = _DEFAULT_PLANS;
}
```

Both `PLANS` (raw JSON) and `PLANS_B64` (base64) are supported. The Setup UI always uses `PLANS_B64`.

---

## Plan Configuration

Each plan supports:

| Field | UI Control | Required |
|---|---|---|
| `planId` | Text input | Yes |
| `displayName` | Text input | Yes |
| `description` | Text input | No |
| `unitAmount` | Text input (e.g. `$15.00`) | Yes |
| `resourceType` | Hidden (defaults to `api-access`) | Auto |
| `expiresIn` | Duration preset dropdown | No |
| `features` | Textarea (one per line) | No |
| `tags` | Pill buttons (`most-popular`, `recommended`, `new`, `best-value`) | No |

### Duration Presets

The UI offers a dropdown for common durations instead of a raw seconds input:

| Label | Value (seconds) |
|---|---|
| Single-use | _(empty)_ |
| 1 hour | 3600 |
| 24 hours | 86400 |
| 7 days | 604800 |
| 30 days (Monthly) | 2592000 |
| 365 days (Yearly) | 31536000 |
| Custom | Manual input |

### Features

Features are plain strings — one per line in a textarea. They're purely for discovery and display (agent card, MCP `discover_plans`, buyer-facing UI). Key2a does not enforce features; the seller's backend handles quota, concurrency, and gating.

Example:
```
1,650 requests/month
10 concurrent agents
100 requests/minute
Priority email support
```

### Tags

Tags are metadata for UI badges. Clicking a tag pill toggles it on/off:

- `most-popular` — renders a "Most Popular" badge on the plan card
- `recommended` — "Recommended" badge
- `new` — "New" badge
- `best-value` — "Best Value" badge

---

## UI Sections

The form is organized into collapsible sections:

| Section | Fields | Default State |
|---|---|---|
| Wallet & Network | Wallet address, network | Open |
| Token Issuance | Issue Token API, auth strategy, API secret | Open |
| Pricing Plans | Plan editor (add/remove plans) | Open |
| Agent Identity | Name, description, URL, provider | Collapsed |
| Server & Storage | Port, base path, storage backend, Redis/Postgres URL, challenge TTL | Collapsed |
| Settlement | Gas wallet private key | Collapsed |
| Refund Cron | Wallet private key, scan interval, min age | Collapsed |

The right panel shows live-generated output (`.env` / `docker run` / `docker-compose.yml`) that updates as you type.

---

## Docker Volume

The `docker-compose.yml` mounts a named volume `key2a-config` at `/app/config/`:

```yaml
volumes:
  - key2a-config:/app/config
```

This persists `.env.runtime` across container restarts. To reset configuration, remove the volume:

```bash
docker compose -f docker/docker-compose.yml down -v
```
