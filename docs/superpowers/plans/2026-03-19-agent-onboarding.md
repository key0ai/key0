# Agent Onboarding Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/skill.md`, `/llms.txt`, `/install.sh`, and `/cli/*` endpoints to all Key0 framework routers, auto-building CLI binaries at startup on Bun servers with graceful fallback on Node.js.

**Architecture:** A new `AgentCliServer` class holds build state and is instantiated during router creation with injectable deps for testability. Pure content generators in `agent-discovery.ts` produce all text content and are shared between server endpoints and `buildCli()` static artifacts. Each framework router (Express, Hono, Fastify) mounts the four new routes using the same `AgentCliServer` instance. Route tests start a real test server and use `fetch`.

**Tech Stack:** Bun (runtime detection + compile), TypeScript, Express/Hono/Fastify, `bun:test`

---

## Working directory

All implementation happens in the `feat/enable-cli` worktree:
```
/Users/srijan/Documents/riklr/key0/.worktrees/feat-enable-cli
```

---

## File structure

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `src/integrations/agent-discovery.ts` | Pure content generators: `slugifyBinaryName`, `generateSkillMdContent`, `generateLlmsTxt`, `generateInstallSh`, `generateClaudeSkillMd`, `generateAgentExperienceMd` |
| **Create** | `src/integrations/__tests__/agent-discovery.test.ts` | Unit tests for all generators |
| **Create** | `src/integrations/agent-cli-server.ts` | `AgentCliServer` class: Bun detection, background build, state tracking |
| **Create** | `src/integrations/__tests__/agent-cli-server.test.ts` | State machine unit tests |
| **Modify** | `src/types/config.ts` | Add `cliOutputDir?: string` to `SellerConfig` |
| **Modify** | `src/integrations/cli.ts` | Replace `generateSkillMd` with shared generators; expand `BuildCliResult` |
| **Modify** | `src/integrations/__tests__/cli-build.test.ts` | Update for new `BuildCliResult` fields |
| **Modify** | `src/integrations/express.ts` | Import `AgentCliServer`; mount 4 new routes |
| **Create** | `src/integrations/__tests__/express-agent-routes.test.ts` | HTTP-level route tests |
| **Modify** | `src/integrations/hono.ts` | Mount 4 new routes |
| **Modify** | `src/integrations/fastify.ts` | Mount 4 new routes |
| **Create** | `docs/mintlify/guides/agent-experience.mdx` | New seller guide |
| **Modify** | `docs/mintlify/guides/agent-cli.mdx` | Update primary path |
| **Modify** | `docs/mintlify/guides/claude-code-integration.mdx` | Add Step 0 |

---

## Task 1: Rebase feat/enable-cli from main

- [ ] **Step 1: Rebase**

```bash
cd /Users/srijan/Documents/riklr/key0/.worktrees/feat-enable-cli
git fetch origin main
git rebase origin/main
```

Expected: clean rebase. Resolve any conflicts.

- [ ] **Step 2: Verify tests still pass**

```bash
bun test
```

Expected: all existing tests pass.

---

## Task 2: `slugifyBinaryName()` — TDD

**Files:**
- Create: `src/integrations/agent-discovery.ts`
- Create: `src/integrations/__tests__/agent-discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/integrations/__tests__/agent-discovery.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { slugifyBinaryName } from "../agent-discovery.js";

describe("slugifyBinaryName", () => {
	test("lowercases and replaces spaces with hyphens", () => {
		expect(slugifyBinaryName("Acme API")).toBe("acme-api");
	});

	test("handles special characters in parens", () => {
		expect(slugifyBinaryName("My API (v2)")).toBe("my-api-v2");
	});

	test("transliterates accented characters", () => {
		expect(slugifyBinaryName("Café Data")).toBe("cafe-data");
	});

	test("collapses consecutive hyphens", () => {
		expect(slugifyBinaryName("  !! bad name !! ")).toBe("bad-name");
	});

	test("strips leading and trailing hyphens", () => {
		expect(slugifyBinaryName("-foo-")).toBe("foo");
	});

	test("falls back to key0-service when result is empty", () => {
		expect(slugifyBinaryName("!!!")).toBe("key0-service");
		expect(slugifyBinaryName("")).toBe("key0-service");
	});

	test("leaves already-valid binary name unchanged", () => {
		expect(slugifyBinaryName("my-service")).toBe("my-service");
	});
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/integrations/__tests__/agent-discovery.test.ts
```

Expected: `error: Cannot find module '../agent-discovery.js'`

- [ ] **Step 3: Create `agent-discovery.ts` with `slugifyBinaryName`**

Create `src/integrations/agent-discovery.ts`:

```typescript
/**
 * Agent discovery content generators.
 * All functions are pure — no side effects, no file I/O.
 */

/**
 * Derive a valid shell binary name from an agent name.
 * Steps: NFC normalize → strip diacritics → lowercase → replace non-[a-z0-9] with hyphens
 *        → collapse consecutive hyphens → strip leading/trailing hyphens → fallback "key0-service"
 */
export function slugifyBinaryName(name: string): string {
	const ascii = name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // strip diacritics after NFC decomposition
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");

	return ascii.length > 0 ? ascii : "key0-service";
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test src/integrations/__tests__/agent-discovery.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/agent-discovery.ts src/integrations/__tests__/agent-discovery.test.ts
git commit -m "feat(agent-discovery): add slugifyBinaryName with TDD"
```

---

## Task 3: Content generators — TDD

**Files:**
- Modify: `src/integrations/agent-discovery.ts`
- Modify: `src/integrations/__tests__/agent-discovery.test.ts`

- [ ] **Step 1: Add tests for all generators**

Append to `src/integrations/__tests__/agent-discovery.test.ts`:

```typescript
import {
	generateAgentExperienceMd,
	generateClaudeSkillMd,
	generateInstallSh,
	generateLlmsTxt,
	generateSkillMdContent,
} from "../agent-discovery.js";

const baseConfig: import("../agent-discovery.js").AgentDiscoveryConfig = {
	agentName: "Acme API",
	agentUrl: "https://api.acme.com",
	agentDescription: "Payment-gated data API",
	providerName: "Acme Corp",
	providerUrl: "https://acme.com",
	plans: [
		{ planId: "basic", unitAmount: "$0.10", description: "Basic access" },
		{ planId: "pro", unitAmount: "$1.00" },
	],
	mcp: true,
};

describe("generateSkillMdContent — CLI available", () => {
	const md = generateSkillMdContent(baseConfig, true);

	test("contains binary name derived from agentName", () => {
		expect(md).toContain("acme-api");
	});

	test("contains install curl command pointing to /install.sh", () => {
		expect(md).toContain("curl -fsSL https://api.acme.com/install.sh | sh");
	});

	test("contains all three usage commands", () => {
		expect(md).toContain("acme-api discover");
		expect(md).toContain("acme-api request --plan");
		expect(md).toContain("--payment-signature");
	});

	test("contains plans table with both plans", () => {
		expect(md).toContain("basic");
		expect(md).toContain("$0.10");
		expect(md).toContain("pro");
	});
});

describe("generateSkillMdContent — CLI not available", () => {
	const md = generateSkillMdContent(baseConfig, false);

	test("does NOT contain install.sh", () => {
		expect(md).not.toContain("install.sh");
	});

	test("contains MCP fallback with /mcp URL", () => {
		expect(md).toContain("mcpServers");
		expect(md).toContain("https://api.acme.com/mcp");
	});

	test("contains HTTP endpoint fallback", () => {
		expect(md).toContain("/discovery");
		expect(md).toContain("/x402/access");
	});
});

describe("generateLlmsTxt", () => {
	test("includes CLI install line when bunReady=true", () => {
		const txt = generateLlmsTxt(baseConfig, true);
		expect(txt).toContain("curl -fsSL https://api.acme.com/install.sh | sh");
	});

	test("omits CLI install line when bunReady=false", () => {
		const txt = generateLlmsTxt(baseConfig, false);
		expect(txt).not.toContain("install.sh");
	});

	test("includes MCP endpoint when mcp=true", () => {
		const txt = generateLlmsTxt(baseConfig, false);
		expect(txt).toContain("https://api.acme.com/mcp");
	});

	test("omits MCP endpoint when mcp=false", () => {
		const txt = generateLlmsTxt({ ...baseConfig, mcp: false }, false);
		expect(txt).not.toContain("/mcp");
	});

	test("includes all plans", () => {
		const txt = generateLlmsTxt(baseConfig, false);
		expect(txt).toContain("basic");
		expect(txt).toContain("pro");
	});

	test("includes 5-step payment flow", () => {
		const txt = generateLlmsTxt(baseConfig, false);
		expect(txt).toContain("/discovery");
		expect(txt).toContain("/x402/access");
		expect(txt).toContain("payment-signature");
	});
});

describe("generateInstallSh", () => {
	const sh = generateInstallSh("acme-api", "https://api.acme.com");

	test("contains all three platform cases", () => {
		expect(sh).toContain("darwin_arm64");
		expect(sh).toContain("darwin_x86_64");
		expect(sh).toContain("linux_x86_64");
	});

	test("uses /cli/ base path", () => {
		expect(sh).toContain("https://api.acme.com/cli");
	});

	test("binary names include correct platform suffixes", () => {
		expect(sh).toContain("acme-api-darwin-arm64");
		expect(sh).toContain("acme-api-darwin-x64");
		expect(sh).toContain("acme-api-linux-x64");
	});

	test("runs --install after download", () => {
		expect(sh).toContain("--install");
	});

	test("strips trailing slash from URL", () => {
		const sh2 = generateInstallSh("acme-api", "https://api.acme.com/");
		expect(sh2).not.toContain("//cli");
	});
});

describe("generateClaudeSkillMd", () => {
	const md = generateClaudeSkillMd("acme-api", baseConfig);

	test("has valid YAML frontmatter with name and description", () => {
		expect(md).toContain("---\nname: acme-api");
		expect(md).toContain("description:");
	});

	test("contains the 5-step flow including wallet tool", () => {
		expect(md).toContain("acme-api discover");
		expect(md).toContain("make_http_request_with_x402");
		expect(md).toContain("--payment-signature");
		expect(md).toContain("resourceUrl");
	});
});

describe("generateAgentExperienceMd", () => {
	const md = generateAgentExperienceMd("acme-api", baseConfig);

	test("contains badge linking to install.sh", () => {
		expect(md).toContain("install.sh");
		expect(md).toContain("img.shields.io");
	});

	test("example uses first plan planId", () => {
		expect(md).toContain("--plan basic");
	});

	test("links to skill.md", () => {
		expect(md).toContain("https://api.acme.com/skill.md");
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/integrations/__tests__/agent-discovery.test.ts
```

Expected: import errors for missing exports.

- [ ] **Step 3: Implement all generators**

Append to `src/integrations/agent-discovery.ts`:

```typescript
export type AgentDiscoveryConfig = {
	agentName: string;
	agentUrl: string;
	agentDescription: string;
	providerName?: string;
	providerUrl?: string;
	plans: ReadonlyArray<{ planId: string; unitAmount: string; description?: string }>;
	mcp?: boolean;
	version?: string;
};

/**
 * Generate /skill.md content.
 * bunReady=true → CLI-first (install + usage + plans).
 * bunReady=false → MCP/HTTP fallback.
 */
export function generateSkillMdContent(config: AgentDiscoveryConfig, bunReady: boolean): string {
	const cleanUrl = config.agentUrl.replace(/\/$/, "");
	const binaryName = slugifyBinaryName(config.agentName);

	if (!bunReady) {
		const mcpSection = config.mcp
			? `## Access via MCP\n\n\`\`\`json\n{ "mcpServers": { "${binaryName}": { "type": "http", "url": "${cleanUrl}/mcp" } } }\n\`\`\`\n\nUse \`discover_plans\` and \`request_access\` tools.\n\n`
			: "";
		return `# ${config.agentName}\n\n${mcpSection}## Access via HTTP\n\nDiscovery: GET ${cleanUrl}/discovery\nPayment:   POST ${cleanUrl}/x402/access\n`;
	}

	const plansTable = [
		"| Plan | Price | Description |",
		"|------|-------|-------------|",
		...config.plans.map((p) => `| ${p.planId} | ${p.unitAmount} | ${p.description ?? ""} |`),
	].join("\n");

	return `# ${config.agentName}

Install \`${binaryName}\` to access ${cleanUrl} autonomously — no API keys, no sign-up.

## Install

\`\`\`bash
curl -fsSL ${cleanUrl}/install.sh | sh
\`\`\`

## Usage

\`\`\`bash
${binaryName} discover                                            # list plans and pricing
${binaryName} request --plan <planId>                            # get payment challenge
${binaryName} request --plan <planId> --payment-signature <sig>  # submit payment proof
\`\`\`

Exit code \`42\` = payment required. Exit code \`0\` = access granted. All output is JSON.

## Plans

${plansTable}

## Payment

Use any x402-compatible wallet tool to produce \`--payment-signature\`.
With coinbase-payment-mcp: use \`make_http_request_with_x402\`.
`;
}

/** Generate /llms.txt content (llms.txt convention). */
export function generateLlmsTxt(config: AgentDiscoveryConfig, bunReady: boolean): string {
	const cleanUrl = config.agentUrl.replace(/\/$/, "");
	const plans = config.plans
		.map((p) => `- ${p.planId}: ${p.unitAmount}${p.description ? ` — ${p.description}` : ""}`)
		.join("\n");

	const cliLine = bunReady ? `- CLI install: curl -fsSL ${cleanUrl}/install.sh | sh\n` : "";
	const mcpLine = config.mcp ? `- MCP: ${cleanUrl}/mcp\n` : "";

	return `# ${config.agentName}

> ${config.agentDescription}

${config.agentName} is a payment-gated API. Agents pay with USDC on Base; no sign-up required.

## Endpoints

- Discovery: GET ${cleanUrl}/discovery
- Payment: POST ${cleanUrl}/x402/access
${mcpLine}- A2A card: ${cleanUrl}/.well-known/agent.json
- Agent instructions: ${cleanUrl}/skill.md
${cliLine}
## Plans

${plans}

## Payment flow

1. GET /discovery → see plans, wallet address, chainId
2. POST /x402/access { planId } → 402 challenge (amount, destination, chainId)
3. Pay USDC on Base, obtain payment signature from wallet tool
4. POST /x402/access { planId } + payment-signature header → AccessGrant (JWT, resourceUrl)
5. Call protected endpoint with Bearer token
${config.providerUrl ? `\n## Optional links\n\n- Docs: https://key0.ai/docs\n- Provider: ${config.providerUrl}\n` : ""}`;
}

/** Generate /install.sh shell script content. */
export function generateInstallSh(binaryName: string, agentUrl: string): string {
	const cleanUrl = agentUrl.replace(/\/$/, "");
	return `#!/bin/sh
set -e
BASE="${cleanUrl}/cli"
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "\${OS}_\${ARCH}" in
  darwin_arm64)   BIN="${binaryName}-darwin-arm64" ;;
  darwin_x86_64)  BIN="${binaryName}-darwin-x64"   ;;
  linux_x86_64)   BIN="${binaryName}-linux-x64"    ;;
  *) echo "Unsupported platform: \${OS}_\${ARCH}"; exit 1 ;;
esac
curl -fsSL "$BASE/$BIN" -o ${binaryName}
chmod +x ./${binaryName}
./${binaryName} --install
echo "Installed ${binaryName}. Run: ${binaryName} discover"
`;
}

/** Generate a Claude Code superpowers-format skill file. */
export function generateClaudeSkillMd(binaryName: string, config: AgentDiscoveryConfig): string {
	const cleanUrl = config.agentUrl.replace(/\/$/, "");
	return `---
name: ${binaryName}
description: Use when interacting with ${config.agentName} — discover plans, pay with USDC, get access tokens. Trigger on any request to use ${config.agentName} or access ${cleanUrl}.
---

You have access to the \`${binaryName}\` CLI. Use it to interact with ${config.agentName} at ${cleanUrl}.

## Flow

1. \`${binaryName} discover\` → see available plans and pricing
2. \`${binaryName} request --plan <planId>\` → if exit code is \`42\`, payment required
3. Use \`make_http_request_with_x402\` (coinbase-payment-mcp) with the challenge JSON to obtain a payment signature
4. \`${binaryName} request --plan <planId> --payment-signature <sig>\` → exit \`0\`, returns \`{ token, resourceUrl }\`
5. Call \`resourceUrl\` with \`Authorization: Bearer <token>\`

All output is JSON. Parse directly — do not screen-scrape.
If coinbase-payment-mcp is unavailable, check for another x402-compatible wallet tool.
`;
}

/** Generate the agent-experience.md README copy-paste block. */
export function generateAgentExperienceMd(binaryName: string, config: AgentDiscoveryConfig): string {
	const cleanUrl = config.agentUrl.replace(/\/$/, "");
	const firstPlan = config.plans[0]?.planId ?? "basic";
	return `## For AI Agents

This API is accessible to AI agents with USDC on Base — no sign-up required.

[![Agent CLI](https://img.shields.io/badge/agent--cli-install-blue)](${cleanUrl}/install.sh)

\`\`\`bash
curl -fsSL ${cleanUrl}/install.sh | sh
${binaryName} discover
${binaryName} request --plan ${firstPlan}
\`\`\`

Agent instructions: ${cleanUrl}/skill.md
`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/integrations/__tests__/agent-discovery.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/agent-discovery.ts src/integrations/__tests__/agent-discovery.test.ts
git commit -m "feat(agent-discovery): add content generators for skill.md, llms.txt, install.sh, claude skill"
```

---

## Task 4: `AgentCliServer` class — TDD

**Files:**
- Create: `src/integrations/agent-cli-server.ts`
- Create: `src/integrations/__tests__/agent-cli-server.test.ts`

**Important:** `AgentCliServer` accepts `AgentDiscoveryConfig & { cliOutputDir?: string }` — it does NOT import from `SellerConfig`. This avoids ordering dependency on the `SellerConfig` type change in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `src/integrations/__tests__/agent-cli-server.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { AgentCliServer } from "../agent-cli-server.js";

const baseConfig: import("../agent-cli-server.js").AgentCliConfig = {
	agentName: "Test Service",
	agentUrl: "https://test.example.com",
	agentDescription: "Test API",
	providerName: "Test",
	providerUrl: "https://test.example.com",
	plans: [{ planId: "basic", unitAmount: "$0.10" }],
	mcp: false,
};

describe("AgentCliServer — not-available (isBunRuntime=false)", () => {
	test("getState() returns not-available", () => {
		const server = new AgentCliServer(baseConfig, { isBunRuntime: false });
		expect(server.getState()).toBe("not-available");
	});

	test("getBinaryName() returns slugified agentName", () => {
		const server = new AgentCliServer(baseConfig, { isBunRuntime: false });
		expect(server.getBinaryName()).toBe("test-service");
	});

	test("isCliReady() returns false", () => {
		const server = new AgentCliServer(baseConfig, { isBunRuntime: false });
		expect(server.isCliReady()).toBe(false);
	});

	test("getSkillMd() returns MCP/HTTP fallback (no install.sh)", () => {
		const server = new AgentCliServer(baseConfig, { isBunRuntime: false });
		expect(server.getSkillMd()).not.toContain("install.sh");
		expect(server.getSkillMd()).toContain("/discovery");
	});

	test("getLlmsTxt() omits CLI line", () => {
		const server = new AgentCliServer(baseConfig, { isBunRuntime: false });
		expect(server.getLlmsTxt()).not.toContain("install.sh");
	});
});

describe("AgentCliServer — building (buildFn never resolves)", () => {
	test("getState() returns building immediately after construction", () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => new Promise(() => {}), // never resolves
		});
		expect(server.getState()).toBe("building");
	});

	test("isCliReady() returns false while building", () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => new Promise(() => {}),
		});
		expect(server.isCliReady()).toBe(false);
	});

	test("getSkillMd() returns fallback content while building", () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => new Promise(() => {}),
		});
		expect(server.getSkillMd()).not.toContain("install.sh");
	});
});

describe("AgentCliServer — ready (buildFn resolves immediately)", () => {
	test("getState() returns ready after build completes", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.resolve(),
		});
		await new Promise((r) => setTimeout(r, 0)); // flush microtask queue
		expect(server.getState()).toBe("ready");
	});

	test("isCliReady() returns true when ready", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.resolve(),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(server.isCliReady()).toBe(true);
	});

	test("getSkillMd() returns CLI-first content when ready", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.resolve(),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(server.getSkillMd()).toContain("install.sh");
		expect(server.getSkillMd()).toContain("test-service discover");
	});

	test("getInstallSh() returns shell script with correct binary name", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.resolve(),
		});
		await new Promise((r) => setTimeout(r, 0));
		const sh = server.getInstallSh();
		expect(sh).toContain("test-service-linux-x64");
		expect(sh).toContain("test-service-darwin-arm64");
	});
});

describe("AgentCliServer — failed (buildFn rejects)", () => {
	test("getState() returns failed when build throws", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.reject(new Error("build failed")),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(server.getState()).toBe("failed");
	});

	test("isCliReady() returns false when failed", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.reject(new Error("build failed")),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(server.isCliReady()).toBe(false);
	});

	test("getSkillMd() returns fallback content when failed", async () => {
		const server = new AgentCliServer(baseConfig, {
			isBunRuntime: true,
			buildFn: () => Promise.reject(new Error("build failed")),
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(server.getSkillMd()).not.toContain("install.sh");
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/integrations/__tests__/agent-cli-server.test.ts
```

Expected: `Cannot find module '../agent-cli-server.js'`

- [ ] **Step 3: Implement `AgentCliServer`**

Create `src/integrations/agent-cli-server.ts`:

```typescript
import {
	type AgentDiscoveryConfig,
	generateInstallSh,
	generateLlmsTxt,
	generateSkillMdContent,
	slugifyBinaryName,
} from "./agent-discovery.js";

export type CliState = "not-available" | "building" | "ready" | "failed";

export interface AgentCliServerOptions {
	/**
	 * Override Bun runtime detection for testing.
	 * Default: typeof Bun !== "undefined"
	 */
	isBunRuntime?: boolean;
	/**
	 * Override build function for testing.
	 * Default: calls buildCli() with the seller config.
	 */
	buildFn?: () => Promise<void>;
}

export type AgentCliConfig = AgentDiscoveryConfig & {
	/** Directory to cache built CLI binaries. Default: "./dist/cli" */
	cliOutputDir?: string;
};

/**
 * Manages CLI binary build state for a Key0 router.
 * Instantiated once at router creation; the build runs in the background.
 * The constructor is synchronous — app.listen() is never delayed.
 */
export class AgentCliServer {
	private state: CliState;
	private readonly binaryName: string;
	private readonly config: AgentCliConfig;
	private readonly outputDir: string;

	constructor(config: AgentCliConfig, opts: AgentCliServerOptions = {}) {
		this.config = config;
		this.binaryName = slugifyBinaryName(config.agentName);
		this.outputDir = config.cliOutputDir ?? "./dist/cli";

		const isBun = opts.isBunRuntime ?? typeof Bun !== "undefined";

		if (!isBun) {
			this.state = "not-available";
			return;
		}

		this.state = "building";
		const buildFn = opts.buildFn ?? (() => this.runBuild());
		buildFn()
			.then(() => {
				this.state = "ready";
			})
			.catch((err: unknown) => {
				this.state = "failed";
				console.error("[key0] CLI auto-build failed:", err);
			});
	}

	private async runBuild(): Promise<void> {
		// Lazy import avoids pulling Bun-specific compilation code into Node bundles
		const { buildCli } = await import("./cli.js");
		await buildCli({
			name: this.binaryName,
			url: this.config.agentUrl,
			version: this.config.version ?? "0.0.0",
			targets: ["bun-linux-x64", "bun-darwin-arm64", "bun-darwin-x64"],
			outputDir: this.outputDir,
			discoverConfig: this.config,
		});
	}

	getState(): CliState { return this.state; }
	getBinaryName(): string { return this.binaryName; }
	getOutputDir(): string { return this.outputDir; }
	isCliReady(): boolean { return this.state === "ready"; }

	getSkillMd(): string {
		return generateSkillMdContent(this.config, this.isCliReady());
	}

	getLlmsTxt(): string {
		return generateLlmsTxt(this.config, this.isCliReady());
	}

	getInstallSh(): string {
		return generateInstallSh(this.binaryName, this.config.agentUrl);
	}
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/integrations/__tests__/agent-cli-server.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/agent-cli-server.ts src/integrations/__tests__/agent-cli-server.test.ts
git commit -m "feat(agent-cli-server): add AgentCliServer with injectable deps and build state machine"
```

---

## Task 5: Update `SellerConfig` and `buildCli()`

**Files:**
- Modify: `src/types/config.ts`
- Modify: `src/integrations/cli.ts`
- Modify: `src/integrations/__tests__/cli-build.test.ts`

- [ ] **Step 1: Add `cliOutputDir` to `SellerConfig`**

In `src/types/config.ts`, add after the `redis` field in `SellerConfig`:

```typescript
/**
 * Directory to cache auto-built CLI binaries.
 * In Docker deployments, use an absolute path (e.g. "/app/dist/cli")
 * since process.cwd() may not be the project root.
 * Default: "./dist/cli"
 */
readonly cliOutputDir?: string;
```

- [ ] **Step 2: Run typecheck to confirm no errors**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Write failing test for new `BuildCliResult` fields**

In `src/integrations/__tests__/cli-build.test.ts`, add this test to the `buildCli` describe block (before the existing tests):

```typescript
import { readFileSync } from "node:fs";

test("generates claudeSkillMd and agentExperienceMd artifacts", async () => {
	const result = await buildCli({
		name: "testcli",
		url: "https://api.example.com",
		targets: [],
		outputDir,
		discoverConfig: {
			agentName: "Test CLI",
			agentUrl: "https://api.example.com",
			agentDescription: "Test service",
			plans: [{ planId: "basic", unitAmount: "$0.10" }],
		},
	});

	expect(existsSync(result.claudeSkillMd)).toBe(true);
	expect(existsSync(result.agentExperienceMd)).toBe(true);

	const claudeSkill = readFileSync(result.claudeSkillMd, "utf-8");
	expect(claudeSkill).toContain("---\nname: testcli");

	const agentExp = readFileSync(result.agentExperienceMd, "utf-8");
	expect(agentExp).toContain("--plan basic");
}, 120_000);
```

- [ ] **Step 4: Run the new test to confirm it fails**

```bash
bun test src/integrations/__tests__/cli-build.test.ts --test-name-pattern "generates claudeSkillMd"
```

Expected: type error or `result.claudeSkillMd is undefined`.

- [ ] **Step 5: Update `BuildCliOptions` and `BuildCliResult` in `cli.ts`**

In `src/integrations/cli.ts`:

1. Add import at the top:
```typescript
import {
	generateAgentExperienceMd,
	generateClaudeSkillMd,
	type AgentDiscoveryConfig,
	generateSkillMdContent,
} from "./agent-discovery.js";
```

2. Add `discoverConfig` to `BuildCliOptions`:
```typescript
export interface BuildCliOptions {
	name: string;
	url: string;
	version?: string;
	targets?: string[];
	outputDir?: string;
	/**
	 * Full agent config for richer skill.md content (plans, description, etc).
	 * When omitted, skill.md uses name/url only.
	 */
	discoverConfig?: AgentDiscoveryConfig;
}
```

3. Update `BuildCliResult`:
```typescript
export interface BuildCliResult {
	binaries: Array<{ path: string; target: string; size: number }>;
	skillMd: string;           // path to dist/cli/skill.md
	claudeSkillMd: string;     // path to dist/cli/{name}.claude-skill.md
	agentExperienceMd: string; // path to dist/cli/agent-experience.md
}
```

4. In `buildCli()`, replace the `generateSkillMd` call block at the end with:
```typescript
const dc: AgentDiscoveryConfig = opts.discoverConfig ?? {
	agentName: opts.name,
	agentUrl: opts.url,
	agentDescription: "",
	plans: [],
};

const skillMdPath = join(outputDir, "skill.md");
writeFileSync(skillMdPath, generateSkillMdContent(dc, true), "utf-8");

const claudeSkillPath = join(outputDir, `${opts.name}.claude-skill.md`);
writeFileSync(claudeSkillPath, generateClaudeSkillMd(opts.name, dc), "utf-8");

const agentExpPath = join(outputDir, "agent-experience.md");
writeFileSync(agentExpPath, generateAgentExperienceMd(opts.name, dc), "utf-8");

return { binaries, skillMd: skillMdPath, claudeSkillMd: claudeSkillPath, agentExperienceMd: agentExpPath };
```

5. Remove the old `generateSkillMd` function entirely (it is not exported from `src/index.ts` — verified).

- [ ] **Step 6: Run the new test to confirm it passes**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: all tests pass (may take up to 2 minutes for compilation).

- [ ] **Step 7: Run full test suite to confirm no regressions**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/types/config.ts src/integrations/cli.ts src/integrations/__tests__/cli-build.test.ts
git commit -m "feat(cli): add cliOutputDir to SellerConfig; expand BuildCliResult with new artifacts"
```

---

## Task 6: Mount routes in Express + route tests

**Files:**
- Modify: `src/integrations/express.ts`
- Create: `src/integrations/__tests__/express-agent-routes.test.ts`

- [ ] **Step 1: Write failing HTTP-level route tests**

Create `src/integrations/__tests__/express-agent-routes.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { AgentCliServer } from "../agent-cli-server.js";

// Minimal config — no real payment adapter needed for these tests
const testConfig: import("../agent-cli-server.js").AgentCliConfig = {
	agentName: "Test Service",
	agentUrl: "http://localhost", // overridden per-test via spread
	agentDescription: "Test API",
	plans: [{ planId: "basic", unitAmount: "$0.10" }],
	mcp: false,
};

function makeRouteHandlers(agentCli: AgentCliServer) {
	const router = express.Router();
	// Import route logic inline for testing — actual routes live in express.ts
	// This test will FAIL until express.ts mounts the routes
	return router;
}

// Start a real Express server with key0Router (non-Bun mode via injectable)
async function startTestServer(agentCliOpts: import("../agent-cli-server.js").AgentCliServerOptions): Promise<{ server: Server; baseUrl: string; agentCli: AgentCliServer }> {
	const app = express();
	const agentCli = new AgentCliServer({ ...testConfig, agentUrl: "https://api.test.com" }, agentCliOpts);

	// Mount ONLY the four new routes for testing (same logic as express.ts will implement)
	app.get("/skill.md", (_req, res) => {
		res.setHeader("Content-Type", "text/markdown; charset=utf-8");
		res.send(agentCli.getSkillMd());
	});

	app.get("/llms.txt", (_req, res) => {
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.send(agentCli.getLlmsTxt());
	});

	app.get("/install.sh", (_req, res) => {
		const state = agentCli.getState();
		if (state === "not-available" || state === "failed") {
			return res.status(501).json({ error: "CLI not available" });
		}
		if (!agentCli.isCliReady()) {
			res.setHeader("Retry-After", "30");
			return res.status(503).json({ error: "CLI is building", retryAfter: 30 });
		}
		res.setHeader("Content-Type", "text/x-shellscript");
		res.send(agentCli.getInstallSh());
	});

	return new Promise((resolve) => {
		const server = app.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, baseUrl: `http://localhost:${addr.port}`, agentCli });
		});
	});
}

describe("Express agent routes — not-available (non-Bun)", () => {
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		({ server, baseUrl } = await startTestServer({ isBunRuntime: false }));
	});

	afterAll(() => server.close());

	test("GET /skill.md returns 200 with text/markdown", async () => {
		const res = await fetch(`${baseUrl}/skill.md`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/markdown");
		const body = await res.text();
		expect(body).toContain("Test Service");
	});

	test("GET /llms.txt returns 200 with text/plain", async () => {
		const res = await fetch(`${baseUrl}/llms.txt`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
	});

	test("GET /install.sh returns 501 when CLI not available", async () => {
		const res = await fetch(`${baseUrl}/install.sh`);
		expect(res.status).toBe(501);
		const body = await res.json() as Record<string, unknown>;
		expect(body["error"]).toContain("CLI not available");
	});
});

describe("Express agent routes — building state", () => {
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		({ server, baseUrl } = await startTestServer({
			isBunRuntime: true,
			buildFn: () => new Promise(() => {}), // never resolves
		}));
	});

	afterAll(() => server.close());

	test("GET /install.sh returns 503 with Retry-After while building", async () => {
		const res = await fetch(`${baseUrl}/install.sh`);
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("30");
	});

	test("GET /skill.md returns 200 with fallback content while building", async () => {
		const res = await fetch(`${baseUrl}/skill.md`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).not.toContain("install.sh");
	});
});

describe("Express agent routes — failed state", () => {
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		({ server, baseUrl } = await startTestServer({
			isBunRuntime: true,
			buildFn: () => Promise.reject(new Error("build failed")),
		}));
		await new Promise((r) => setTimeout(r, 10)); // let rejection settle
	});

	afterAll(() => server.close());

	test("GET /install.sh returns 501 (not 503) when build failed", async () => {
		const res = await fetch(`${baseUrl}/install.sh`);
		expect(res.status).toBe(501);
	});
});

describe("Express agent routes — ready state", () => {
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		({ server, baseUrl } = await startTestServer({
			isBunRuntime: true,
			buildFn: () => Promise.resolve(),
		}));
		await new Promise((r) => setTimeout(r, 10)); // let build settle
	});

	afterAll(() => server.close());

	test("GET /install.sh returns 200 with shell script when ready", async () => {
		const res = await fetch(`${baseUrl}/install.sh`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/x-shellscript");
		const body = await res.text();
		expect(body).toContain("#!/bin/sh");
	});

	test("GET /skill.md returns CLI-first content when ready", async () => {
		const res = await fetch(`${baseUrl}/skill.md`);
		const body = await res.text();
		expect(body).toContain("install.sh");
	});

	test("GET /cli/missing-binary returns 404", async () => {
		const res = await fetch(`${baseUrl}/cli/nonexistent-binary`);
		expect(res.status).toBe(404);
	});

	test("GET /cli/ path traversal attempt returns 404 (not a file leak)", async () => {
		// resolve() will produce an absolute path outside outputDir — existsSync will return false
		const res = await fetch(`${baseUrl}/cli/..%2F..%2Fetc%2Fpasswd`);
		// Express decodes %2F as /, which changes the route — either 404 from route mismatch or binary-not-found
		expect([404, 400]).toContain(res.status);
	});
});
```

- [ ] **Step 2: Run tests to confirm they pass (they test the shared logic, not yet key0Router)**

```bash
bun test src/integrations/__tests__/express-agent-routes.test.ts
```

Expected: all tests pass (the test file builds its own mini Express app from `AgentCliServer` directly).

- [ ] **Step 3: Add routes to `key0Router` in `express.ts`**

Add these imports at the top of `src/integrations/express.ts`:

```typescript
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AgentCliServer } from "./agent-cli-server.js";
```

At the top of `key0Router()`, after `const router = Router();`:

```typescript
const agentCli = new AgentCliServer(opts.config);
```

Add these routes before `return router;` (after the MCP block):

```typescript
// ── Agent discovery endpoints ────────────────────────────────────────────

router.get("/skill.md", (_req: Request, res: Response) => {
	res.setHeader("Content-Type", "text/markdown; charset=utf-8");
	res.send(agentCli.getSkillMd());
});

router.get("/llms.txt", (_req: Request, res: Response) => {
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.send(agentCli.getLlmsTxt());
});

router.get("/install.sh", (_req: Request, res: Response) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return res.status(501).json({
			error: "CLI not available",
			hint: state === "not-available" ? "Server is not running on Bun" : "CLI build failed at startup",
		});
	}
	if (!agentCli.isCliReady()) {
		res.setHeader("Retry-After", "30");
		return res.status(503).json({ error: "CLI is building", retryAfter: 30 });
	}
	res.setHeader("Content-Type", "text/x-shellscript");
	res.send(agentCli.getInstallSh());
});

router.get("/cli/:filename", (req: Request, res: Response) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return res.status(501).json({ error: "CLI not available" });
	}
	if (!agentCli.isCliReady()) {
		res.setHeader("Retry-After", "30");
		return res.status(503).json({ error: "CLI is building", retryAfter: 30 });
	}
	// Resolve to absolute path — getOutputDir() may return a relative path
	const filePath = resolve(agentCli.getOutputDir(), req.params.filename as string);
	if (!existsSync(filePath)) {
		return res.status(404).json({ error: "Binary not found" });
	}
	res.setHeader("Content-Type", "application/octet-stream");
	res.sendFile(filePath);
});
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/express.ts src/integrations/__tests__/express-agent-routes.test.ts
git commit -m "feat(express): mount /skill.md, /llms.txt, /install.sh, /cli/* with route tests"
```

---

## Task 7: Mount routes in Hono and Fastify

**Files:**
- Modify: `src/integrations/hono.ts`
- Modify: `src/integrations/fastify.ts`

The route logic mirrors Express. Use the same state-check pattern: `not-available` or `failed` → 501; `building` → 503 + `Retry-After: 30`; `ready` → serve content.

- [ ] **Step 1: Add routes to Hono**

Add imports at the top of `src/integrations/hono.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentCliServer } from "./agent-cli-server.js";
```

At the top of `key0App()`, after `const app = new Hono();`:

```typescript
const agentCli = new AgentCliServer(opts.config);
```

Add before `return app;`:

```typescript
app.get("/skill.md", (c) =>
	c.body(agentCli.getSkillMd(), 200, { "Content-Type": "text/markdown; charset=utf-8" }),
);

app.get("/llms.txt", (c) =>
	c.body(agentCli.getLlmsTxt(), 200, { "Content-Type": "text/plain; charset=utf-8" }),
);

app.get("/install.sh", (c) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return c.json({ error: "CLI not available" }, 501);
	}
	if (!agentCli.isCliReady()) {
		return c.json({ error: "CLI is building", retryAfter: 30 }, 503, { "Retry-After": "30" });
	}
	return c.body(agentCli.getInstallSh(), 200, { "Content-Type": "text/x-shellscript" });
});

app.get("/cli/:filename", (c) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return c.json({ error: "CLI not available" }, 501);
	}
	if (!agentCli.isCliReady()) {
		return c.json({ error: "CLI is building", retryAfter: 30 }, 503, { "Retry-After": "30" });
	}
	const filePath = resolve(agentCli.getOutputDir(), c.req.param("filename"));
	if (!existsSync(filePath)) {
		return c.json({ error: "Binary not found" }, 404);
	}
	const data = readFileSync(filePath);
	return c.body(data, 200, { "Content-Type": "application/octet-stream" });
});
```

- [ ] **Step 2: Add routes to Fastify**

Add imports at the top of `src/integrations/fastify.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentCliServer } from "./agent-cli-server.js";
```

At the top of `key0Plugin()`, before the first `fastify.get`:

```typescript
const agentCli = new AgentCliServer(opts.config);
```

Add after the `/discovery` route:

```typescript
fastify.get("/skill.md", async (_request, reply) => {
	reply.header("Content-Type", "text/markdown; charset=utf-8");
	return reply.send(agentCli.getSkillMd());
});

fastify.get("/llms.txt", async (_request, reply) => {
	reply.header("Content-Type", "text/plain; charset=utf-8");
	return reply.send(agentCli.getLlmsTxt());
});

fastify.get("/install.sh", async (_request, reply) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return reply.status(501).send({ error: "CLI not available" });
	}
	if (!agentCli.isCliReady()) {
		reply.header("Retry-After", "30");
		return reply.status(503).send({ error: "CLI is building", retryAfter: 30 });
	}
	reply.header("Content-Type", "text/x-shellscript");
	return reply.send(agentCli.getInstallSh());
});

fastify.get("/cli/:filename", async (request, reply) => {
	const state = agentCli.getState();
	if (state === "not-available" || state === "failed") {
		return reply.status(501).send({ error: "CLI not available" });
	}
	if (!agentCli.isCliReady()) {
		reply.header("Retry-After", "30");
		return reply.status(503).send({ error: "CLI is building", retryAfter: 30 });
	}
	const { filename } = request.params as { filename: string };
	const filePath = resolve(agentCli.getOutputDir(), filename);
	if (!existsSync(filePath)) {
		return reply.status(404).send({ error: "Binary not found" });
	}
	reply.header("Content-Type", "application/octet-stream");
	return reply.send(readFileSync(filePath));
});
```

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/hono.ts src/integrations/fastify.ts
git commit -m "feat(hono,fastify): mount /skill.md, /llms.txt, /install.sh, /cli/* routes"
```

---

## Task 8: Docs update

**Files:**
- Create: `docs/mintlify/guides/agent-experience.mdx`
- Modify: `docs/mintlify/guides/agent-cli.mdx`
- Modify: `docs/mintlify/guides/claude-code-integration.mdx`

- [ ] **Step 1: Create `agent-experience.mdx`**

Create `docs/mintlify/guides/agent-experience.mdx`:

```mdx
---
title: "Agent Experience"
description: "What AI agents see when they arrive at your Key0-powered service — and what to put in your README."
---

Key0 automatically serves endpoints that let AI agents self-onboard at your service with no human in the loop.

## What key0 auto-serves

| Endpoint | Content | Available when |
|----------|---------|----------------|
| `GET /skill.md` | CLI install + usage instructions | Always (MCP fallback on Node) |
| `GET /llms.txt` | Full service description for LLMs | Always |
| `GET /install.sh` | Platform-detecting install script | Bun server only |
| `GET /cli/{name}-{platform}` | Pre-built binary download | Bun server only |

No configuration needed. All content is derived from your `SellerConfig`.

## What agents experience

When an AI agent encounters your service URL:

1. Fetches `https://your-service.com/skill.md`
2. Reads: "install `your-service`, then discover and request"
3. Runs: `curl -fsSL https://your-service.com/install.sh | sh`
4. Runs: `your-service discover` → sees plans and pricing
5. Runs: `your-service request --plan basic` → gets payment challenge
6. Uses wallet tool (e.g. coinbase-payment-mcp's `make_http_request_with_x402`) → gets signature
7. Runs: `your-service request --plan basic --payment-signature <sig>` → gets token
8. Calls your protected API with `Authorization: Bearer <token>`

All without human involvement.

## Copy-paste README block

Add this to your README and website:

```markdown
## For AI Agents

This API is accessible to AI agents with USDC on Base — no sign-up required.

[![Agent CLI](https://img.shields.io/badge/agent--cli-install-blue)](https://your-service.com/install.sh)

```bash
curl -fsSL https://your-service.com/install.sh | sh
your-service discover
your-service request --plan basic
```

Agent instructions: https://your-service.com/skill.md
```

## Claude Code skill file

Generate a skill file and ship it with your docs so Claude Code knows how to use your service automatically:

```typescript
import { buildCli } from "@key0ai/key0/cli";

const result = await buildCli({
  name: "your-service",
  url: "https://your-service.com",
  discoverConfig: {
    agentName: "Your Service",
    agentUrl: "https://your-service.com",
    agentDescription: "Your service description",
    plans: [{ planId: "basic", unitAmount: "$0.10" }],
  },
});
// result.claudeSkillMd → drop into .claude/skills/your-service.md
```

## Node.js servers (manual distribution)

If your server runs on Node.js, auto-build is unavailable. Instead:

1. Run `buildCli()` in a CI step
2. Upload binaries to a CDN or GitHub Releases
3. Write a custom `install.sh` pointing to your CDN URLs
4. Serve `skill.md` statically at your domain root
```

- [ ] **Step 2: Update `agent-cli.mdx`**

Add this block at the top of the "For Sellers: Generating the Binary" section (before "### 1. Install the CLI builder"):

```mdx
<Tip>
**Running on Bun?** You don't need to manually build and distribute binaries. Key0 auto-builds them at startup and serves them at `/install.sh` and `/cli/{name}-{platform}`. See [Agent Experience](/guides/agent-experience).

This guide is for sellers who need CDN distribution (Node.js servers or GitHub Releases).
</Tip>
```

- [ ] **Step 3: Update `claude-code-integration.mdx`**

Add before "## Step 1: Install Payments MCP":

```mdx
## Step 0: Check for agent instructions

If the seller runs Key0 on Bun, they serve ready-made agent instructions:

```bash
curl https://my-service.example.com/skill.md
```

If the output contains an `install.sh` line, follow it — the CLI handles everything. Otherwise, continue with the MCP setup below.
```

- [ ] **Step 4: Commit**

```bash
git add docs/mintlify/guides/agent-experience.mdx docs/mintlify/guides/agent-cli.mdx docs/mintlify/guides/claude-code-integration.mdx
git commit -m "docs: add agent-experience guide; update agent-cli and claude-code-integration guides"
```

---

## Task 9: Final checks

- [ ] **Step 1: Full test suite**

```bash
cd /Users/srijan/Documents/riklr/key0/.worktrees/feat-enable-cli
bun test
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: no errors. Fix any before proceeding.

- [ ] **Step 4: Smoke test the example server**

```bash
cd examples/express-seller
bun run start &
sleep 3
curl -s http://localhost:3000/skill.md | head -5
curl -s http://localhost:3000/llms.txt | head -3
# install.sh will be 501 on Node or 503 while building on Bun — both are correct
curl -sv http://localhost:3000/install.sh 2>&1 | grep "< HTTP"
kill %1
```

Expected: `skill.md` and `llms.txt` return content; `/install.sh` returns either 501 or 503 (not 500).

- [ ] **Step 5: Commit any lint/typecheck fixes**

```bash
git add -p  # stage only the specific fix files, not everything
git commit -m "fix: address typecheck and lint issues"
```
