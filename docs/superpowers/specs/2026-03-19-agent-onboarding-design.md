# Agent Onboarding Experience Design

**Date:** 2026-03-19
**Branch context:** extends `feat/enable-cli`
**Status:** Approved

---

## Problem

An AI agent (Claude with coinbase-payment-mcp, OpenClaw with a USDC wallet, or any x402-compatible agent) encounters a seller's URL and needs to self-onboard — discover plans, install tooling, pay, and get a token — with no human in the loop.

The trigger is always the same: **agent arrives cold at a URL** (from a README, a tool response, a human message). The agent needs to answer "how do I use this?" entirely from what the server serves.

Today the SDK serves `/discovery`, `/.well-known/agent.json`, and `/.well-known/mcp.json` — but there is no canonical entry point for an agent that doesn't already know which transport to use. There is also no working `/install.sh` (the CLI skill.md references one but it's not served).

---

## Design

### Three new SDK-served endpoints

Mounted by all framework routers — `key0Router` (Express), Hono router, Fastify plugin, and MCP integration. The Docker standalone server inherits them automatically via `key0Router`.

#### `GET /skill.md`

CLI-first agent instructions, generated from `SellerConfig`. This is the canonical cold-arrival entry point — an agent fetching `{agentUrl}/skill.md` gets everything it needs.

Content when `/install.sh` is available (Bun server):

```markdown
# {agentName}

Install `{binaryName}` to access {agentUrl} autonomously — no API keys, no sign-up.

## Install

```bash
curl -fsSL {agentUrl}/install.sh | sh
```

## Usage

```bash
{binaryName} discover                                            # list plans and pricing
{binaryName} request --plan <planId>                            # get payment challenge
{binaryName} request --plan <planId> --payment-signature <sig>  # submit payment proof
```

Exit code `42` = payment required. Exit code `0` = access granted. All output is JSON.

## Plans

| Plan | Price | Description |
|------|-------|-------------|
| {planId} | {unitAmount} | {description} |

## Payment

Use any x402-compatible wallet tool to produce `--payment-signature`.
With coinbase-payment-mcp: use `make_http_request_with_x402`.
```

Content when `/install.sh` is not available (Node.js server, Bun absent):

```markdown
# {agentName}

## Access via MCP

```json
{ "mcpServers": { "{binaryName}": { "type": "http", "url": "{agentUrl}/mcp" } } }
```

Use `discover_plans` and `request_access` tools.

## Access via HTTP

Discovery: GET {agentUrl}/discovery
Payment:   POST {agentUrl}/x402/access
```

The same generator function (`generateSkillMdContent(config, bunAvailable)`) is used for both the server-served `GET /skill.md` and the static `dist/cli/skill.md` emitted by `buildCli()`. These must never diverge. The existing `generateSkillMd(name, url)` function in `cli.ts` is superseded by `generateSkillMdContent` and removed from the public API.

Content-Type: `text/markdown`.

---

#### `GET /llms.txt`

Follows the [llms.txt convention](https://llmstxt.org). Richer than `/skill.md` — covers all endpoints and the full payment protocol shape. Intended for agents or developers scanning the site to understand the full surface area.

Lines marked **[bun-only]** are emitted only when Bun is available and the CLI has been built. Lines marked **[mcp-only]** are emitted only when `mcp: true` in `SellerConfig`.

```markdown
# {agentName}

> {agentDescription}

{agentName} is a payment-gated API. Agents pay with USDC on Base; no sign-up required.

## Endpoints

- Discovery: GET {agentUrl}/discovery
- Payment: POST {agentUrl}/x402/access
- MCP: {agentUrl}/mcp                               [mcp-only]
- A2A card: {agentUrl}/.well-known/agent.json
- Agent instructions: {agentUrl}/skill.md
- CLI install: curl -fsSL {agentUrl}/install.sh | sh  [bun-only]

## Plans

- {planId}: {unitAmount} — {description}

## Payment flow

1. GET /discovery → see plans, wallet address, chainId
2. POST /x402/access { planId } → 402 challenge (amount, destination, chainId)
3. Pay USDC on Base, obtain payment signature from wallet tool
4. POST /x402/access { planId } + payment-signature header → AccessGrant (JWT, resourceUrl)
5. Call protected endpoint with Bearer token

## Optional links

- Docs: https://key0.ai/docs
- Provider: {providerUrl}
```

Content-Type: `text/plain` (llms.txt convention).

---

#### `GET /install.sh`

Served only when Bun is available **and** the CLI build has completed successfully. Returns `503 Service Unavailable` with `Retry-After: 30` during the startup build window (see Startup behaviour). Returns `501 Not Implemented` if Bun is not in PATH.

Platform-detecting shell script. `{binaryName}` is derived from `agentName` via `slugifyBinaryName()` (defined below). `{agentUrl}` is the seller's public URL.

```sh
#!/bin/sh
set -e
BASE="{agentUrl}/cli"
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "${OS}_${ARCH}" in
  darwin_arm64)   BIN="{binaryName}-darwin-arm64" ;;
  darwin_x86_64)  BIN="{binaryName}-darwin-x64"   ;;
  linux_x86_64)   BIN="{binaryName}-linux-x64"    ;;
  *) echo "Unsupported platform: ${OS}_${ARCH}"; exit 1 ;;
esac
curl -fsSL "$BASE/$BIN" -o {binaryName}
chmod +x ./{binaryName}
./{binaryName} --install
echo "Installed {binaryName}. Run: {binaryName} discover"
```

Content-Type: `text/x-shellscript`.

Binary files are served at `GET /cli/{binaryName}-{platform}` — static file routes added alongside `/install.sh`, streaming from `cliOutputDir`.

---

### Slugify algorithm — `slugifyBinaryName(agentName: string): string`

Used to derive the binary name from `agentName`. Must be consistent across all code paths (server startup, `install.sh` generation, `skill.md` generation, binary filenames on disk).

```
1. Normalize to NFC
2. Transliterate non-ASCII to nearest ASCII equivalent (e.g. é→e, ü→u); drop if no equivalent
3. Lowercase
4. Replace any character that is not [a-z0-9] with a hyphen
5. Collapse consecutive hyphens to one
6. Strip leading and trailing hyphens
7. If result is empty, use "key0-service"
```

Examples:
- `"Acme API"` → `"acme-api"`
- `"My API (v2)"` → `"my-api-v2"`
- `"Café Data"` → `"cafe-data"`
- `"  !! bad name !! "` → `"bad-name"`

The slug is computed once at startup from `SellerConfig.agentName` and reused for all requests. It is not recomputed per request.

---

### Startup behaviour (Bun servers)

`key0Router` checks for the Bun runtime at module load time using `typeof Bun !== "undefined"`. This detects whether the server process itself is running under Bun — it does not check whether `bun` is installed on the host. If false, all CLI endpoints (`/install.sh`, `/cli/*`) are not mounted.

If Bun is present:

1. **Before `app.listen()`:** the router initiates `buildCli()` as a background Promise (does not block listen).
2. **`app.listen()` is called immediately** — the server is ready to handle `/skill.md`, `/llms.txt`, `/discovery`, etc. without delay.
3. **During the build window** (~15s): `/install.sh` and `/cli/{name}-{platform}` return `503 Service Unavailable` with header `Retry-After: 30` and body `{ "error": "CLI is building", "retryAfter": 30 }`. `/skill.md` returns **`200 OK`** with the MCP fallback content (not 503) — it is always available, just with degraded content during the build window.
4. **After build completes:** `/install.sh` and `/cli/*` become available. `/skill.md` switches to the CLI-first content.
5. **If build fails:** same as Bun absent — `/install.sh` and `/cli/*` return `501`. Log the error. `/skill.md` shows MCP fallback.

The build state is held as a module-level variable in the router (not persisted). Every restart rebuilds.

---

### Wiring `SellerConfig` → `buildCli()`

`key0Router` (and equivalent Hono/Fastify routers) derives build params from `SellerConfig` as follows:

```typescript
buildCli({
  name: slugifyBinaryName(config.agentName),
  url: config.agentUrl,           // e.g. "https://api.example.com" — no basePath suffix
  version: config.version ?? "0.0.0",
  targets: ["bun-linux-x64", "bun-darwin-arm64", "bun-darwin-x64"],
  outputDir: config.cliOutputDir ?? "./dist/cli",
})
```

Note: `url` is `agentUrl`, not `agentUrl + basePath`. The CLI template calls `/discovery` and `/x402/access` directly on the base URL — these paths are fixed and not affected by `basePath` (which controls the A2A sub-path only).

---

### Two generated artifacts from `buildCli()`

For sellers who want CDN/GitHub Releases distribution (Node.js servers, or preference for external hosting).

#### `dist/cli/skill.md`

Uses the same `generateSkillMdContent(config, bunAvailable: true)` function as the server-served endpoint. Sellers host this at their domain root.

#### `dist/cli/{name}.claude-skill.md`

A Claude Code superpowers-format skill file. Sellers drop this into `.claude/skills/` in their repo or documentation site.

```markdown
---
name: {binaryName}
description: Use when interacting with {agentName} — discover plans, pay with USDC, get access tokens. Trigger on any request to use {agentName} or access {agentUrl}.
---

You have access to the `{binaryName}` CLI. Use it to interact with {agentName} at {agentUrl}.

## Flow

1. `{binaryName} discover` → see available plans and pricing
2. `{binaryName} request --plan <planId>` → if exit code is `42`, payment required
3. Use `make_http_request_with_x402` (coinbase-payment-mcp) with the challenge JSON to obtain a payment signature
4. `{binaryName} request --plan <planId> --payment-signature <sig>` → exit `0`, returns `{ token, resourceUrl }`
5. Call `resourceUrl` with `Authorization: Bearer <token>`

All output is JSON. Parse directly — do not screen-scrape.
If coinbase-payment-mcp is unavailable, check for another x402-compatible wallet tool.
```

#### `dist/cli/agent-experience.md`

The seller copy-paste block for README and website.

```markdown
## For AI Agents

This API is accessible to AI agents with USDC on Base — no sign-up required.

[![Agent CLI](https://img.shields.io/badge/agent--cli-install-blue)]({agentUrl}/install.sh)

```bash
curl -fsSL {agentUrl}/install.sh | sh
{binaryName} discover
{binaryName} request --plan {plans[0].planId}
```

Agent instructions: {agentUrl}/skill.md
```

---

### Updated `BuildCliResult` type

```typescript
export interface BuildCliResult {
  binaries: Array<{
    path: string;
    target: string;
    size: number;
  }>;
  skillMd: string;             // path to dist/cli/skill.md
  claudeSkillMd: string;       // path to dist/cli/{name}.claude-skill.md
  agentExperienceMd: string;   // path to dist/cli/agent-experience.md
}
```

---

### Config changes

#### `SellerConfig` — new optional field

```typescript
/**
 * Directory to cache auto-built CLI binaries.
 * In Docker deployments, use an absolute path (e.g. "/app/dist/cli")
 * since process.cwd() may not be the project root.
 * Default: "./dist/cli"
 */
cliOutputDir?: string;
```

No other changes to `SellerConfig`. `/skill.md` and `/llms.txt` are fully derived from existing fields.

---

### Mintlify docs changes

**New page: `guides/agent-experience.mdx`** — "Agent Experience for Sellers"

Sections:
1. What key0 auto-serves (the three endpoints, content, when each is present)
2. What agents see step by step (cold arrival → install → discover → pay → token)
3. The copy-paste "For AI Agents" README block
4. The Claude Code skill file — where to put it, what it does
5. Manual distribution fallback (for Node.js servers: run `buildCli()`, upload binaries to a CDN or GitHub Releases, then write a custom `install.sh` pointing to the CDN URLs — key0 does not generate this for the manual path)

**Update `guides/agent-cli.mdx`**
- Primary path: "binaries are auto-built at startup and served at `/install.sh` on Bun servers — no manual distribution needed"
- Secondary path (existing): manual `buildCli()` for CDN distribution on Node.js servers

**Update `guides/claude-code-integration.mdx`**
- Add Step 0: "If the seller exposes a `/skill.md`, Claude Code can onboard without any manual config. Fetch `{seller-url}/skill.md` to see install instructions."

---

## Endpoint summary

| Endpoint | Always served | Bun + build complete | Content-Type |
|---|---|---|---|
| `GET /skill.md` | ✅ (MCP fallback) | ✅ (CLI-first) | `text/markdown` |
| `GET /llms.txt` | ✅ | ✅ | `text/plain` |
| `GET /install.sh` | — | ✅ | `text/x-shellscript` |
| `GET /cli/{name}-{platform}` | — | ✅ | `application/octet-stream` |

During startup build window: `/install.sh` and `/cli/*` return `503 Retry-After: 30`. `/skill.md` shows MCP fallback.

---

## Out of scope

- Agent marketplace / registry (seller discovery across domains)
- Windows support for auto-built CLI
- Binary signing / notarization
- Incremental builds (binaries always rebuilt on restart)
- Custom install.sh templates (e.g. for sellers who want GitHub Releases URLs instead of self-served)
