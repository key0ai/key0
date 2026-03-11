import type { Config, Plan } from "./types";

function _deriveAgentName(providerName: string): string {
	return providerName ? `${providerName} Agent` : "Key0 Server";
}

function _deriveAgentDescription(providerName: string): string {
	return providerName ? `Payment-gated API by ${providerName}` : "Payment-gated A2A endpoint";
}

const NETWORK_NAMES: Record<string, string> = {
	testnet: "base-sepolia",
	mainnet: "base",
};

const CHAIN_IDS: Record<string, number> = {
	testnet: 84532,
	mainnet: 8453,
};

/** Generate A2A Agent Card JSON preview — mirrors buildAgentCard() in src/core/agent-card.ts. */
export function generateAgentCard(config: Config): string {
	const baseUrl = (config.agentUrl || "http://localhost:3000").replace(/\/$/, "");
	const networkName = NETWORK_NAMES[config.network] ?? "base-sepolia";
	const chainId = CHAIN_IDS[config.network] ?? 84532;
	const agentName = _deriveAgentName(config.providerName);
	const agentDescription = _deriveAgentDescription(config.providerName);

	const skills = config.plans.map((tier) => ({
		id: tier.planId || "plan",
		name: tier.planId || "plan",
		description: `${tier.planId || "plan"} — ${tier.unitAmount || "$0.00"} USDC on ${networkName}. Access via JSON-RPC method 'message/send' with AccessRequest, or direct HTTP POST to the URL field.`,
		tags: ["x402", "payment"],
		url: `${baseUrl}/x402/access`,
		inputSchema: {
			type: "object",
			properties: {
				type: { type: "string", const: "AccessRequest" },
				planId: { type: "string" },
				requestId: { type: "string" },
				resourceId: { type: "string" },
			},
			required: ["type", "planId", "requestId"],
		},
		outputSchema: {
			type: "object",
			properties: {
				accessToken: { type: "string" },
				tokenType: { type: "string" },
				resourceEndpoint: { type: "string" },
				txHash: { type: "string" },
				explorerUrl: { type: "string" },
			},
		},
		pricing: [
			{
				planId: tier.planId || "plan",
				unitAmount: tier.unitAmount || "$0.00",
				...(tier.description ? { description: tier.description } : {}),
				asset: "USDC",
				chainId,
				walletAddress: config.walletAddress || "0x...",
			},
		],
	}));

	const card = {
		name: agentName,
		description: agentDescription,
		url: `${baseUrl}/x402/access`,
		version: "1.0.0",
		protocolVersion: "0.3.0",
		capabilities: {
			extensions: [
				{
					uri: "x402-payment-http://example.com",
					description: `Supports x402 payments with USDC on ${networkName}.`,
					required: true,
				},
			],
			pushNotifications: false,
			streaming: false,
			stateTransitionHistory: false,
		},
		defaultInputModes: ["text"],
		defaultOutputModes: ["application/json"],
		skills,
		provider: {
			organization: config.providerName || "Key0",
			url: config.providerUrl || "https://key0.ai",
		},
	};

	return JSON.stringify(card, null, 2);
}

/** Terminal session block used by both Agent Card and MCP previews. */
export interface TerminalBlock {
	kind:
		| "command"
		| "output"
		| "json"
		| "comment"
		| "table"
		| "prompt"
		| "status"
		| "collapsible-json";
	text: string;
	/** One-line summary shown when collapsed (for collapsible-json). */
	summary?: string;
}

/** @deprecated Use TerminalBlock */
export type McpTerminalBlock = TerminalBlock;

/* ── Helper: ASCII table ──────────────────────────────────────────────────── */

function truncate(s: string, max: number): string {
	const clean = s.replace(/[\r\n]+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const COL_MAX_WIDTHS: Record<string, number> = {
	Plan: 20,
	Price: 12,
	Details: 40,
};

function asciiTable(headers: string[], rows: string[][]): string {
	// Sanitize & truncate cells
	const cleaned = rows.map((r) =>
		r.map((cell, i) => truncate(cell, COL_MAX_WIDTHS[headers[i] ?? ""] ?? 40)),
	);

	const colWidths = headers.map((h, i) =>
		Math.max(h.length, ...cleaned.map((r) => (r[i] ?? "").length)),
	);

	const sep = (l: string, m: string, r: string, f: string) =>
		l + colWidths.map((w) => f.repeat(w + 2)).join(m) + r;

	const row = (cells: string[]) =>
		`│${cells.map((c, i) => ` ${c.padEnd(colWidths[i] ?? 0)} `).join("│")}│`;

	return [
		sep("┌", "┬", "┐", "─"),
		row(headers),
		sep("├", "┼", "┤", "─"),
		...cleaned.map((r) => row(r)),
		sep("└", "┴", "┘", "─"),
	].join("\n");
}

/** Generate Agent Card terminal walkthrough — mirrors the real A2A discovery experience. */
export function generateAgentCardTerminal(config: Config): TerminalBlock[] {
	const baseUrl = (config.agentUrl || "http://localhost:3000").replace(/\/$/, "");
	const agentName = _deriveAgentName(config.providerName);
	const agentDescription = _deriveAgentDescription(config.providerName);
	const networkName = NETWORK_NAMES[config.network] ?? "base-sepolia";
	const chainId = CHAIN_IDS[config.network] ?? 84532;
	const explorer = config.network === "mainnet" ? "basescan.org" : "sepolia.basescan.org";

	const blocks: TerminalBlock[] = [];

	// 1. Connect
	blocks.push({
		kind: "prompt",
		text: `connect to ${baseUrl}/.well-known/agent.json`,
	});

	blocks.push({
		kind: "status",
		text: `Fetch(${baseUrl}/.well-known/agent.json)\n  ⎿  Received (200 OK)`,
	});

	blocks.push({
		kind: "collapsible-json",
		summary: `{  agent.json  •  ${config.plans.length} plan${config.plans.length !== 1 ? "s" : ""}  }`,
		text: generateAgentCard(config),
	});

	// 2. Agent summary
	const planRows = config.plans
		.filter((p) => p.planId)
		.map((p) => [p.planId, p.unitAmount || "$0.00", p.description || "—"]);

	let summary = `Successfully connected. Here's a summary of the ${agentName} agent:\n\n`;
	summary += `  Name: ${agentName}\n`;
	summary += `  Description: ${agentDescription}\n`;
	summary += `  Protocol Version: 0.3.0\n`;
	summary += `  Payment: x402 payments with USDC on ${networkName} (chain ID ${chainId})\n`;
	summary += `  Wallet: ${config.walletAddress || "0x..."}`;

	blocks.push({ kind: "status", text: summary });

	// 3. Plans table
	blocks.push({ kind: "output", text: "  Available Plans\n" });
	if (planRows.length > 0) {
		blocks.push({
			kind: "table",
			text: asciiTable(["Plan", "Price", "Details"], planRows),
		});
	}

	// 4. How it works
	blocks.push({
		kind: "output",
		text: `  How it works\n\n  1. Send a POST to /x402/access with { planId, requestId, resourceId }\n  2. Server responds with HTTP 402 payment challenge\n  3. Include a PAYMENT-SIGNATURE header with the x402 payment payload\n  4. On success, receive a JWT access token + resource endpoint + tx hash\n\n  Would you like to interact with any of these plans?`,
	});

	// 5. User picks a plan
	const firstPlan = config.plans[0];
	if (firstPlan?.planId) {
		const planId = firstPlan.planId;
		const amount = firstPlan.unitAmount || "$0.00";

		blocks.push({ kind: "prompt", text: planId });

		blocks.push({
			kind: "status",
			text: `Let me discover the payment requirements and set up the x402 payment for the ${planId} plan.`,
		});

		// 6. Wallet balance check
		blocks.push({
			kind: "status",
			text: `payments-mcp - get_wallet_balance (MCP)(chain: "${networkName}")\n  ⎿  { "balances": { "USDC": "19.385", "ETH": "0.003" } }`,
		});

		// 7. x402 payment
		blocks.push({
			kind: "status",
			text: `payments-mcp - make_http_request_with_x402 (MCP)\n  baseURL: "${baseUrl}"\n  path: "/x402/access"\n  method: "POST"\n  body: ${JSON.stringify({ planId, requestId: "a1b2c3d4-...", resourceId: "default" })}`,
		});

		blocks.push({
			kind: "status",
			text: `  ⎿  { "result": { "status": 200, ... } }`,
		});

		// 8. Payment success
		let success = `Payment successful! Here's the summary:\n\n`;
		success += `  Payment: ${amount} USDC on ${networkName.charAt(0).toUpperCase() + networkName.slice(1)}\n`;
		success += `  Tx Hash:\n  https://${explorer}/tx/0x62d5b647...f8fc1191\n\n`;
		success += `  Access Grant:\n`;
		success += `  - Access Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOi... (JWT Bearer token)\n`;
		success += `  - Resource Endpoint: ${baseUrl}/api/default\n`;
		success += `  - Plan: ${planId}\n`;
		success += `  - Resource ID: default\n\n`;
		success += `  You can now use the Bearer token to authenticate against the resource endpoint.`;

		blocks.push({ kind: "status", text: success });
	}

	return blocks;
}

/** Generate MCP terminal session — simulates a real MCP client interaction. */
export function generateMcpTerminal(config: Config): McpTerminalBlock[] {
	const agentName = _deriveAgentName(config.providerName);
	const agentDescription = _deriveAgentDescription(config.providerName);
	const baseUrl = (config.agentUrl || "http://localhost:3000").replace(/\/$/, "");
	const chainId = CHAIN_IDS[config.network] ?? 84532;
	const networkName = NETWORK_NAMES[config.network] ?? "base-sepolia";

	const blocks: McpTerminalBlock[] = [];

	// 1. Discovery
	blocks.push({ kind: "comment", text: "# .well-known/mcp.json" });
	blocks.push({ kind: "command", text: `curl ${baseUrl}/.well-known/mcp.json` });
	blocks.push({
		kind: "json",
		text: JSON.stringify(
			{
				name: agentName,
				description: agentDescription,
				version: "1.0.0",
				transport: {
					type: "streamable-http",
					url: `${baseUrl}/mcp`,
				},
			},
			null,
			2,
		),
	});

	// 2. Connect
	blocks.push({ kind: "comment", text: "# Connect to MCP server" });
	blocks.push({ kind: "command", text: `mcp connect ${baseUrl}/mcp` });
	blocks.push({ kind: "output", text: `Connected to ${agentName}` });

	// 3. List tools
	blocks.push({ kind: "command", text: "mcp list-tools" });
	blocks.push({
		kind: "output",
		text: `2 tools available:\n  discover_plans  — List pricing plans (free)\n  request_access  — Purchase a plan via x402 payment`,
	});

	// 4. Call discover_plans
	blocks.push({ kind: "comment", text: "# Discover available plans" });
	blocks.push({ kind: "command", text: "mcp call discover_plans" });

	const discoverResult = {
		agent: agentName,
		description: agentDescription,
		network: config.network,
		chainId,
		walletAddress: config.walletAddress || "0x...",
		asset: "USDC",
		plans: config.plans.map((p) => ({
			planId: p.planId || "plan",
			unitAmount: p.unitAmount || "$0.00",
			...(p.description ? { description: p.description } : {}),
		})),
	};
	blocks.push({ kind: "json", text: JSON.stringify(discoverResult, null, 2) });

	// 5. Call request_access
	const firstPlan = config.plans[0];
	if (firstPlan) {
		const planId = firstPlan.planId || "plan";
		blocks.push({ kind: "comment", text: "# Request access to a plan" });
		blocks.push({
			kind: "command",
			text: `mcp call request_access --planId "${planId}"`,
		});
		blocks.push({
			kind: "json",
			text: JSON.stringify(
				{
					status: "payment_required",
					type: "X402Challenge",
					challengeId: "ch_xxxxxxxx",
					planId,
					amount: firstPlan.unitAmount || "$0.00",
					asset: "USDC",
					chainId,
					network: networkName,
					destination: config.walletAddress || "0x...",
					expiresAt: new Date(
						Date.now() + (Number(config.challengeTtlSeconds) || 900) * 1000,
					).toISOString(),
				},
				null,
				2,
			),
		});
		blocks.push({
			kind: "output",
			text: "Payment required — agent signs x402 payment and retries automatically",
		});

		// 6. After payment
		blocks.push({ kind: "comment", text: "# After x402 payment is settled on-chain" });
		blocks.push({
			kind: "json",
			text: JSON.stringify(
				{
					status: "access_granted",
					type: "AccessGrant",
					challengeId: "ch_xxxxxxxx",
					planId,
					accessToken: "eyJhbGciOiJIUzI1NiIs...",
					tokenType: "Bearer",
					txHash: "0xabc...def",
					explorerUrl: `https://${config.network === "mainnet" ? "basescan.org" : "sepolia.basescan.org"}/tx/0xabc...def`,
				},
				null,
				2,
			),
		});
	}

	return blocks;
}

/** Serialize a Plan to the JSON shape expected by Key0 config (strips empty optional fields). */
function serializePlan(p: Plan) {
	return {
		planId: p.planId,
		unitAmount: p.unitAmount,
		...(p.description ? { description: p.description } : {}),
	};
}

export function generateEnv(config: Config): string {
	const lines: string[] = [
		"# ──────────────────────────────────────────────────────────────────────────────",
		"# Key0 Docker — Generated Configuration",
		"# ──────────────────────────────────────────────────────────────────────────────",
		"",
		"# ── Required ──────────────────────────────────────────────────────────────────",
		"",
		`KEY0_WALLET_ADDRESS=${config.walletAddress}`,
		`ISSUE_TOKEN_API=${config.issueTokenApi}`,
		"",
		"# ── Network ───────────────────────────────────────────────────────────────────",
		"",
		`KEY0_NETWORK=${config.network}`,
		"",
		"# ── Storage ───────────────────────────────────────────────────────────────────",
		"",
		`STORAGE_BACKEND=${config.storageBackend}`,
		`REDIS_URL=${config.redisUrl}`,
	];

	if (config.storageBackend === "postgres" && config.databaseUrl) {
		lines.push(`DATABASE_URL=${config.databaseUrl}`);
	}

	lines.push(
		"",
		"# ── Server ────────────────────────────────────────────────────────────────────",
		"",
		`PORT=${config.port}`,
	);

	if (config.basePath && config.basePath !== "/a2a") {
		lines.push(`BASE_PATH=${config.basePath}`);
	}

	lines.push(
		"",
		"# ── Agent Card ────────────────────────────────────────────────────────────────",
		"",
	);
	lines.push(`AGENT_NAME=${_deriveAgentName(config.providerName)}`);
	lines.push(`AGENT_DESCRIPTION=${_deriveAgentDescription(config.providerName)}`);
	lines.push(`AGENT_URL=${config.agentUrl}`);

	if (config.providerName) {
		lines.push(`PROVIDER_NAME=${config.providerName}`);
	}
	if (config.providerUrl) {
		lines.push(`PROVIDER_URL=${config.providerUrl}`);
	}

	// Plans
	if (config.plans.length > 0) {
		const plansJson = JSON.stringify(config.plans.map(serializePlan), null, 2);
		lines.push(
			"",
			"# ── Pricing Plans ─────────────────────────────────────────────────────────────",
			"",
			`PLANS='${plansJson}'`,
		);
	}

	if (config.challengeTtlSeconds && config.challengeTtlSeconds !== "900") {
		lines.push(
			"",
			"# ── Challenge ─────────────────────────────────────────────────────────────────",
			"",
			`CHALLENGE_TTL_SECONDS=${config.challengeTtlSeconds}`,
		);
	}

	if (config.mcpEnabled) {
		lines.push(
			"",
			"# ── MCP ───────────────────────────────────────────────────────────────────────",
			"",
			"MCP_ENABLED=true",
		);
	}

	if (config.backendAuthStrategy !== "none" || config.issueTokenApiSecret) {
		lines.push(
			"",
			"# ── Token API Auth ────────────────────────────────────────────────────────────",
			"",
		);
		if (config.backendAuthStrategy !== "none") {
			lines.push(`BACKEND_AUTH_STRATEGY=${config.backendAuthStrategy}`);
		}
		if (config.backendAuthStrategy !== "none" && config.issueTokenApiSecret) {
			lines.push(`ISSUE_TOKEN_API_SECRET=${config.issueTokenApiSecret}`);
		}
	}

	if (config.gasWalletPrivateKey) {
		lines.push(
			"",
			"# ── Settlement ────────────────────────────────────────────────────────────────",
			"",
			`GAS_WALLET_PRIVATE_KEY=${config.gasWalletPrivateKey}`,
		);
	}

	if (config.walletPrivateKey) {
		lines.push(
			"",
			"# ── Refund Cron ───────────────────────────────────────────────────────────────",
			"",
			`KEY0_WALLET_PRIVATE_KEY=${config.walletPrivateKey}`,
		);
		if (config.refundIntervalMs !== "60000") {
			lines.push(`REFUND_INTERVAL_MS=${config.refundIntervalMs}`);
		}
		if (config.refundMinAgeMs !== "300000") {
			lines.push(`REFUND_MIN_AGE_MS=${config.refundMinAgeMs}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

export function generateDockerRun(config: Config): string {
	const envFlags: string[] = [];

	envFlags.push(`-e KEY0_WALLET_ADDRESS=${config.walletAddress}`);
	envFlags.push(`-e ISSUE_TOKEN_API=${config.issueTokenApi}`);
	envFlags.push(`-e KEY0_NETWORK=${config.network}`);
	envFlags.push(`-e STORAGE_BACKEND=${config.storageBackend}`);
	envFlags.push(`-e REDIS_URL=${config.redisUrl}`);
	if (config.storageBackend === "postgres" && config.databaseUrl) {
		envFlags.push(`-e DATABASE_URL=${config.databaseUrl}`);
	}
	envFlags.push(`-e PORT=${config.port}`);
	envFlags.push(`-e AGENT_NAME="${_deriveAgentName(config.providerName)}"`);
	envFlags.push(`-e AGENT_DESCRIPTION="${_deriveAgentDescription(config.providerName)}"`);
	envFlags.push(`-e AGENT_URL=${config.agentUrl}`);

	if (config.basePath && config.basePath !== "/a2a") {
		envFlags.push(`-e BASE_PATH=${config.basePath}`);
	}
	if (config.providerName) {
		envFlags.push(`-e PROVIDER_NAME="${config.providerName}"`);
	}
	if (config.providerUrl) {
		envFlags.push(`-e PROVIDER_URL=${config.providerUrl}`);
	}
	if (config.plans.length > 0) {
		const json = JSON.stringify(config.plans.map(serializePlan));
		envFlags.push(`-e PLANS='${json}'`);
	}
	if (config.challengeTtlSeconds !== "900") {
		envFlags.push(`-e CHALLENGE_TTL_SECONDS=${config.challengeTtlSeconds}`);
	}
	if (config.mcpEnabled) {
		envFlags.push(`-e MCP_ENABLED=true`);
	}
	if (config.backendAuthStrategy !== "none") {
		envFlags.push(`-e BACKEND_AUTH_STRATEGY=${config.backendAuthStrategy}`);
	}
	if (config.backendAuthStrategy !== "none" && config.issueTokenApiSecret) {
		envFlags.push(`-e ISSUE_TOKEN_API_SECRET=${config.issueTokenApiSecret}`);
	}
	if (config.gasWalletPrivateKey) {
		envFlags.push(`-e GAS_WALLET_PRIVATE_KEY=${config.gasWalletPrivateKey}`);
	}
	if (config.walletPrivateKey) {
		envFlags.push(`-e KEY0_WALLET_PRIVATE_KEY=${config.walletPrivateKey}`);
	}

	return `docker run \\\n  ${envFlags.join(" \\\n  ")} \\\n  -p ${config.port}:${config.port} \\\n  key0ai/key0:latest`;
}

export function generateDockerCompose(config: Config): string {
	// Determine which infra is "managed" (bundled in compose) vs external
	const managedRedis = !config.redisUrl || config.redisUrl === "redis://redis:6379";
	const managedPostgres =
		config.storageBackend === "postgres" &&
		(!config.databaseUrl ||
			config.databaseUrl === "postgresql://key0:key0@postgres:5432/key0");

	// Build the KEY0_MANAGED_INFRA value
	const managedParts: string[] = [];
	if (managedRedis) managedParts.push("redis");
	if (managedPostgres) managedParts.push("postgres");
	const managedInfraValue = managedParts.join(",");

	// Derive the active profile for the quickstart command
	const profileFlag =
		managedRedis && managedPostgres
			? " --profile full"
			: managedRedis
				? " --profile redis"
				: managedPostgres
					? " --profile postgres"
					: "";

	const envVars: Record<string, string> = {
		KEY0_WALLET_ADDRESS: config.walletAddress,
		ISSUE_TOKEN_API: config.issueTokenApi,
		KEY0_NETWORK: config.network,
		STORAGE_BACKEND: config.storageBackend,
		REDIS_URL: managedRedis ? "redis://redis:6379" : config.redisUrl,
		PORT: config.port,
		AGENT_URL: config.agentUrl,
	};

	if (managedInfraValue) {
		envVars.KEY0_MANAGED_INFRA = managedInfraValue;
	}

	envVars.AGENT_NAME = _deriveAgentName(config.providerName);
	envVars.AGENT_DESCRIPTION = _deriveAgentDescription(config.providerName);

	if (config.storageBackend === "postgres") {
		envVars.DATABASE_URL = managedPostgres
			? "postgresql://key0:key0@postgres:5432/key0"
			: config.databaseUrl;
	}

	if (config.basePath && config.basePath !== "/a2a") {
		envVars.BASE_PATH = config.basePath;
	}
	if (config.providerName) envVars.PROVIDER_NAME = config.providerName;
	if (config.providerUrl) envVars.PROVIDER_URL = config.providerUrl;
	if (config.plans.length > 0) {
		envVars.PLANS = JSON.stringify(config.plans.map(serializePlan));
	}
	if (config.challengeTtlSeconds !== "900") {
		envVars.CHALLENGE_TTL_SECONDS = config.challengeTtlSeconds;
	}
	if (config.mcpEnabled) {
		envVars.MCP_ENABLED = "true";
	}
	if (config.backendAuthStrategy !== "none") {
		envVars.BACKEND_AUTH_STRATEGY = config.backendAuthStrategy;
	}
	if (config.backendAuthStrategy !== "none" && config.issueTokenApiSecret) {
		envVars.ISSUE_TOKEN_API_SECRET = config.issueTokenApiSecret;
	}
	if (config.gasWalletPrivateKey) {
		envVars.GAS_WALLET_PRIVATE_KEY = config.gasWalletPrivateKey;
	}
	if (config.walletPrivateKey) {
		envVars.KEY0_WALLET_PRIVATE_KEY = config.walletPrivateKey;
		if (config.refundIntervalMs !== "60000") {
			envVars.REFUND_INTERVAL_MS = config.refundIntervalMs;
		}
		if (config.refundMinAgeMs !== "300000") {
			envVars.REFUND_MIN_AGE_MS = config.refundMinAgeMs;
		}
	}

	const envLines = Object.entries(envVars)
		.map(([k, v]) => `      ${k}: "${v}"`)
		.join("\n");

	// depends_on only for managed services
	const dependsOnEntries: string[] = [];
	if (managedRedis) dependsOnEntries.push("      redis:\n        condition: service_healthy\n        required: false");
	if (managedPostgres) dependsOnEntries.push("      postgres:\n        condition: service_healthy\n        required: false");

	// Profile comment header
	const profileComment = profileFlag
		? `# Start command:\n#   ${managedInfraValue ? `KEY0_MANAGED_INFRA=${managedInfraValue} ` : ""}docker compose${profileFlag} up\n\n`
		: `# Start command:\n#   docker compose up\n\n`;

	let services = `${profileComment}services:
  key0:
    image: key0ai/key0:latest
    ports:
      - "${config.port}:${config.port}"
    environment:
${envLines}
    volumes:
      - key0-config:/app/config
    extra_hosts:
      - "host.docker.internal:host-gateway"`;

	if (dependsOnEntries.length > 0) {
		services += `\n    depends_on:\n${dependsOnEntries.join("\n")}`;
	}

	if (managedRedis) {
		services += `\n
  redis:
    image: redis:7-alpine
    profiles: [redis, full]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    volumes:
      - redis-data:/data`;
	}

	if (managedPostgres) {
		services += `\n
  postgres:
    image: postgres:16-alpine
    profiles: [postgres, full]
    environment:
      POSTGRES_USER: key0
      POSTGRES_PASSWORD: key0
      POSTGRES_DB: key0
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U key0 -d key0"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - postgres-data:/var/lib/postgresql/data`;
	}

	services += `\n\nvolumes:\n  key0-config:\n`;
	if (managedRedis) services += `  redis-data:\n`;
	if (managedPostgres) services += `  postgres-data:\n`;

	return services;
}
