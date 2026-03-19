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

	const hasPlans = config.plans.some((p) => p.planId);
	const hasRoutes = config.routes.some((r) => r.path);

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

	const catalogSummary = [
		hasPlans ? `${config.plans.length} plan${config.plans.length !== 1 ? "s" : ""}` : null,
		hasRoutes ? `${config.routes.length} route${config.routes.length !== 1 ? "s" : ""}` : null,
	]
		.filter(Boolean)
		.join(", ");

	blocks.push({
		kind: "collapsible-json",
		summary: `{  agent.json  •  ${catalogSummary || "no catalog"}  }`,
		text: generateAgentCard(config),
	});

	// 2. Agent summary
	let summary = `Successfully connected. Here's a summary of the ${agentName} agent:\n\n`;
	summary += `  Name: ${agentName}\n`;
	summary += `  Description: ${agentDescription}\n`;
	summary += `  Protocol Version: 0.3.0\n`;
	summary += `  Payment: x402 payments with USDC on ${networkName} (chain ID ${chainId})\n`;
	summary += `  Wallet: ${config.walletAddress || "0x..."}`;

	blocks.push({ kind: "status", text: summary });

	// 3a. Plans table (if any)
	if (hasPlans) {
		const planRows = config.plans
			.filter((p) => p.planId)
			.map((p) => [p.planId, p.unitAmount || "$0.00", p.description || "—"]);
		blocks.push({ kind: "output", text: "  Subscription Plans\n" });
		blocks.push({ kind: "table", text: asciiTable(["Plan", "Price", "Details"], planRows) });
	}

	// 3b. Routes table (if any)
	if (hasRoutes) {
		const routeRows = config.routes
			.filter((r) => r.path)
			.map((r) => [
				`${r.method} ${r.path}`,
				r.unitAmount ? `$${r.unitAmount}` : "free",
				r.description || "—",
			]);
		blocks.push({ kind: "output", text: "  Pay-Per-Call Routes\n" });
		blocks.push({ kind: "table", text: asciiTable(["Route", "Price", "Details"], routeRows) });
	}

	// 4. How it works — adapt to what's configured
	if (hasPlans && hasRoutes) {
		blocks.push({
			kind: "output",
			text: `  How it works\n\n  Subscription (plans):\n  1. POST /x402/access with { planId, requestId, resourceId }\n  2. Server returns HTTP 402 payment challenge\n  3. Pay via PAYMENT-SIGNATURE header\n  4. Receive a JWT Bearer token — use it on every API call\n\n  Pay-Per-Call (routes):\n  1. Call the route directly (e.g. GET ${baseUrl}${config.routes[0]?.path || "/api/..."})\n  2. Server returns HTTP 402 payment challenge\n  3. Pay via PAYMENT-SIGNATURE header\n  4. Receive the API response directly — no token needed\n\n  Would you like to use a plan or make a pay-per-call request?`,
		});
	} else if (hasPlans) {
		blocks.push({
			kind: "output",
			text: `  How it works\n\n  1. POST /x402/access with { planId, requestId, resourceId }\n  2. Server returns HTTP 402 payment challenge\n  3. Pay via PAYMENT-SIGNATURE header\n  4. Receive a JWT Bearer token — use it on every subsequent API call\n\n  Would you like to purchase access to a plan?`,
		});
	} else if (hasRoutes) {
		blocks.push({
			kind: "output",
			text: `  How it works\n\n  1. Call any route directly (e.g. GET ${baseUrl}${config.routes[0]?.path || "/api/..."})\n  2. Server returns HTTP 402 payment challenge\n  3. Pay via PAYMENT-SIGNATURE header\n  4. Receive the API response directly — no token stored, pay each call\n\n  Would you like to make a pay-per-call request?`,
		});
	}

	// 5. Demo interactions — show both plan (JWT) and route (direct response) if both configured
	const firstRoute = config.routes.find((r) => r.path);
	const firstPlan = config.plans.find((p) => p.planId);

	// Plan demo (JWT flow)
	if (firstPlan) {
		const planId = firstPlan.planId;
		const amount = firstPlan.unitAmount || "$0.00";

		blocks.push({ kind: "prompt", text: `subscribe to ${planId}` });
		blocks.push({
			kind: "status",
			text: `Let me set up the x402 payment for the ${planId} plan.`,
		});
		blocks.push({
			kind: "status",
			text: `payments-mcp - get_wallet_balance (MCP)(chain: "${networkName}")\n  ⎿  { "balances": { "USDC": "19.385", "ETH": "0.003" } }`,
		});
		blocks.push({
			kind: "status",
			text: `payments-mcp - make_http_request_with_x402 (MCP)\n  baseURL: "${baseUrl}"\n  path: "/x402/access"\n  method: "POST"\n  body: ${JSON.stringify({ planId, requestId: "a1b2c3d4-...", resourceId: "default" })}`,
		});
		let planSuccess = `Payment successful!\n\n`;
		planSuccess += `  Payment: ${amount} USDC on ${networkName}\n`;
		planSuccess += `  Tx: https://${explorer}/tx/0x62d5b647...f8fc1191\n\n`;
		planSuccess += `  Access Token: eyJhbGciOiJIUzI1NiJ9... (JWT Bearer)\n`;
		planSuccess += `  Use this token on every call to the protected API.`;
		blocks.push({ kind: "status", text: planSuccess });
	}

	// Route demo (direct API response)
	if (firstRoute) {
		const routePath = firstRoute.path.replace(/:([a-z]+)/gi, (_, p) => `example-${p}`);
		const amount = firstRoute.unitAmount ? `$${firstRoute.unitAmount}` : "free";
		const routeQueryParams = (firstRoute.params ?? []).filter((p) => p.in === "query");
		const routeBodyParams = (firstRoute.params ?? []).filter((p) => p.in === "body");

		const exampleValue = (type: string, name: string): unknown =>
			type === "number" ? 0 : type === "boolean" ? true : type === "object" ? {} : `<${name}>`;

		const queryExample =
			routeQueryParams.length > 0
				? Object.fromEntries(routeQueryParams.map((p) => [p.name, exampleValue(p.type, p.name)]))
				: null;
		const bodyExample =
			routeBodyParams.length > 0
				? Object.fromEntries(routeBodyParams.map((p) => [p.name, exampleValue(p.type, p.name)]))
				: null;

		let routeCallText = `payments-mcp - make_http_request_with_x402 (MCP)\n  baseURL: "${baseUrl}"\n  path: "${routePath}"\n  method: "${firstRoute.method}"`;
		if (queryExample) routeCallText += `\n  query: ${JSON.stringify(queryExample)}`;
		if (bodyExample) routeCallText += `\n  body: ${JSON.stringify(bodyExample)}`;

		blocks.push({ kind: "prompt", text: `${firstRoute.method} ${firstRoute.path}` });
		blocks.push({
			kind: "status",
			text: routeCallText,
		});
		if (firstRoute.unitAmount) {
			blocks.push({
				kind: "status",
				text: `payments-mcp - get_wallet_balance (MCP)(chain: "${networkName}")\n  ⎿  { "balances": { "USDC": "19.385", "ETH": "0.003" } }`,
			});
			let routeSuccess = `Payment successful! API response received:\n\n`;
			routeSuccess += `  Payment: ${amount} USDC on ${networkName}\n`;
			routeSuccess += `  Tx: https://${explorer}/tx/0x62d5b647...f8fc1191\n\n`;
			routeSuccess += `  Response: 200 OK — result returned inline\n`;
			routeSuccess += `  (No token issued — each call is paid individually)`;
			blocks.push({ kind: "status", text: routeSuccess });
		} else {
			blocks.push({ kind: "status", text: `  ⎿  200 OK — free route, no payment required` });
		}
	}

	return blocks;
}

/** Generate MCP terminal session — simulates a real MCP client interaction. */
export function generateMcpTerminal(config: Config): McpTerminalBlock[] {
	const agentName = _deriveAgentName(config.providerName);
	const agentDescription = _deriveAgentDescription(config.providerName);
	const baseUrl = (config.agentUrl || "http://localhost:3000").replace(/\/$/, "");

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
		text: `2 tools available:\n  discover  — List plans and pay-per-call routes (free)\n  access  — Purchase a plan or make a pay-per-call request via x402`,
	});

	// 4. Call discover
	blocks.push({ kind: "comment", text: "# Discover plans and routes" });
	blocks.push({ kind: "command", text: "mcp call discover" });

	const discoverResult = {
		agentName,
		description: agentDescription,
		plans: config.plans
			.filter((p) => p.planId)
			.map((p) => ({
				planId: p.planId,
				unitAmount: p.unitAmount || "$0.00",
				...(p.description ? { description: p.description } : {}),
			})),
		routes: config.routes
			.filter((r) => r.path)
			.map((r) => {
				const pathParams = (r.params ?? []).filter((p) => p.in === "path");
				const queryParams = (r.params ?? []).filter((p) => p.in === "query");
				const bodyParams = (r.params ?? []).filter((p) => p.in === "body");
				return {
					routeId: `${r.method.toLowerCase()}-${r.path
						.replace(/\//g, "-")
						.replace(/[^a-z0-9-]/g, "")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "")}`,
					method: r.method,
					path: r.path,
					...(r.unitAmount ? { unitAmount: `$${r.unitAmount}` } : {}),
					...(r.description ? { description: r.description } : {}),
					...(pathParams.length > 0
						? {
								pathParams: Object.fromEntries(
									pathParams.map((p) => [
										p.name,
										{
											type: p.type || "string",
											...(p.description ? { description: p.description } : {}),
										},
									]),
								),
							}
						: {}),
					...(queryParams.length > 0
						? {
								queryParams: Object.fromEntries(
									queryParams.map((p) => [
										p.name,
										{
											type: p.type || "string",
											required: p.required,
											...(p.description ? { description: p.description } : {}),
										},
									]),
								),
							}
						: {}),
					...(bodyParams.length > 0
						? {
								bodyParams: Object.fromEntries(
									bodyParams.map((p) => [
										p.name,
										{
											type: p.type || "string",
											required: p.required,
											...(p.description ? { description: p.description } : {}),
										},
									]),
								),
							}
						: {}),
				};
			}),
	};
	blocks.push({ kind: "json", text: JSON.stringify(discoverResult, null, 2) });

	const explorerBase = config.network === "mainnet" ? "basescan.org" : "sepolia.basescan.org";
	const firstRoute = config.routes.find((r) => r.path);
	const firstPlan = config.plans.find((p) => p.planId);

	// 5a. Plan demo — subscription → JWT
	if (firstPlan) {
		const planId = firstPlan.planId;
		blocks.push({ kind: "comment", text: "# Subscription plan → receive JWT Bearer token" });
		blocks.push({ kind: "command", text: `mcp call access --planId "${planId}"` });
		blocks.push({
			kind: "output",
			text: "Payment required — agent signs x402 payment and retries automatically",
		});
		blocks.push({ kind: "comment", text: "# JWT issued — use on every API call" });
		blocks.push({
			kind: "json",
			text: JSON.stringify(
				{
					type: "AccessGrant",
					planId,
					accessToken: "eyJhbGciOiJIUzI1NiIs...",
					tokenType: "Bearer",
					txHash: "0xabc...def",
					explorerUrl: `https://${explorerBase}/tx/0xabc...def`,
				},
				null,
				2,
			),
		});
	}

	// 5b. Route demo — pay-per-call → direct API response
	if (firstRoute) {
		const routeId = `${firstRoute.method.toLowerCase()}-${firstRoute.path
			.replace(/\//g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")}`;
		const mcpQueryParams = (firstRoute.params ?? []).filter((p) => p.in === "query");
		const mcpBodyParams = (firstRoute.params ?? []).filter((p) => p.in === "body");

		const mcpExampleValue = (type: string, name: string): unknown =>
			type === "number" ? 0 : type === "boolean" ? true : type === "object" ? {} : `<${name}>`;

		let mcpCallCmd = `mcp call access --routeId "${routeId}"`;
		if (mcpQueryParams.length > 0) {
			const qEx = Object.fromEntries(
				mcpQueryParams.map((p) => [p.name, mcpExampleValue(p.type, p.name)]),
			);
			mcpCallCmd += ` --query '${JSON.stringify(qEx)}'`;
		}
		if (mcpBodyParams.length > 0) {
			const bEx = Object.fromEntries(
				mcpBodyParams.map((p) => [p.name, mcpExampleValue(p.type, p.name)]),
			);
			mcpCallCmd += ` --body '${JSON.stringify(bEx)}'`;
		}

		blocks.push({ kind: "comment", text: "# Pay-per-call route → API response returned inline" });
		blocks.push({ kind: "command", text: mcpCallCmd });
		if (firstRoute.unitAmount) {
			blocks.push({
				kind: "output",
				text: "Payment required — agent signs x402 payment and retries automatically",
			});
			blocks.push({ kind: "comment", text: "# No token issued — response returned directly" });
			blocks.push({
				kind: "json",
				text: JSON.stringify(
					{
						type: "ResourceResponse",
						routeId,
						txHash: "0xabc...def",
						explorerUrl: `https://${explorerBase}/tx/0xabc...def`,
						resource: { status: 200, body: { result: "..." } },
					},
					null,
					2,
				),
			});
		} else {
			blocks.push({ kind: "comment", text: "# Free route — no payment required" });
			blocks.push({
				kind: "json",
				text: JSON.stringify(
					{ type: "ResourceResponse", routeId, resource: { status: 200, body: { result: "..." } } },
					null,
					2,
				),
			});
		}
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

// ── Separator helpers (60-char wide, safe for narrow panels) ─────────────────
const _HR = `# ${"─".repeat(58)}`;
const _sec = (name: string): string => {
	const prefix = `# ── ${name} `;
	return prefix + "─".repeat(Math.max(0, 60 - prefix.length));
};

export function generateEnv(config: Config): string {
	const lines: string[] = [
		_HR,
		"# Key0 Docker — Generated Configuration",
		_HR,
		"",
		_sec("Required"),
		"",
		`KEY0_WALLET_ADDRESS=${config.walletAddress}`,
		"",
		_sec("Network"),
		"",
		`KEY0_NETWORK=${config.network}`,
		"",
		_sec("Storage"),
		"",
		`STORAGE_BACKEND=${config.storageBackend}`,
		`REDIS_URL=${config.redisUrl}`,
	];

	if (config.storageBackend === "postgres" && config.databaseUrl) {
		lines.push(`DATABASE_URL=${config.databaseUrl}`);
	}

	lines.push("", _sec("Server"), "", `PORT=${config.port}`);

	if (config.basePath && config.basePath !== "/a2a") {
		lines.push(`BASE_PATH=${config.basePath}`);
	}

	lines.push("", _sec("Agent Card"), "");
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
		lines.push("", _sec("Pricing Plans"), "", `PLANS='${plansJson}'`);
	}

	// Routes
	if (config.routes.length > 0) {
		const serializedRoutes = config.routes.map((r) => ({
			routeId: r.routeId,
			method: r.method,
			path: r.path,
			...(r.unitAmount ? { unitAmount: `$${r.unitAmount}` } : {}),
			...(r.description ? { description: r.description } : {}),
			...((r.params ?? []).length > 0 ? { params: r.params } : {}),
		}));
		lines.push("", _sec("Routes"), "", `ROUTES_B64=${btoa(JSON.stringify(serializedRoutes))}`);
		if (config.proxyToBaseUrl) lines.push(`PROXY_TO_BASE_URL=${config.proxyToBaseUrl}`);
		if (config.proxySecret) lines.push(`KEY0_PROXY_SECRET=${config.proxySecret}`);
	}

	if (config.challengeTtlSeconds && config.challengeTtlSeconds !== "900") {
		lines.push("", _sec("Challenge"), "", `CHALLENGE_TTL_SECONDS=${config.challengeTtlSeconds}`);
	}

	const onboardingVars: string[] = [];
	if (!config.a2aEnabled) onboardingVars.push("A2A_ENABLED=false");
	if (config.mcpEnabled) onboardingVars.push("MCP_ENABLED=true");
	if (!config.llmsEnabled) onboardingVars.push("LLMS_ENABLED=false");
	if (!config.skillsMdEnabled) onboardingVars.push("SKILLS_MD_ENABLED=false");
	if (onboardingVars.length > 0) {
		lines.push("", _sec("Buyer Onboarding"), "", ...onboardingVars);
	}

	// ISSUE_TOKEN_API — only when plans are configured
	if (config.plans.length > 0 && config.issueTokenApi) {
		lines.push("", _sec("Token API"), "", `ISSUE_TOKEN_API=${config.issueTokenApi}`);
		if (config.backendAuthStrategy !== "none" || config.issueTokenApiSecret) {
			lines.push("", _sec("Token API Auth"), "");
			if (config.backendAuthStrategy !== "none") {
				lines.push(`BACKEND_AUTH_STRATEGY=${config.backendAuthStrategy}`);
			}
			if (config.backendAuthStrategy !== "none" && config.issueTokenApiSecret) {
				lines.push(`ISSUE_TOKEN_API_SECRET=${config.issueTokenApiSecret}`);
			}
		}
	}

	if (config.gasWalletPrivateKey) {
		lines.push("", _sec("Settlement"), "", `GAS_WALLET_PRIVATE_KEY=${config.gasWalletPrivateKey}`);
	}

	if (config.walletPrivateKey) {
		lines.push("", _sec("Refund Cron"), "", `KEY0_WALLET_PRIVATE_KEY=${config.walletPrivateKey}`);
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
	if (!config.a2aEnabled) {
		envFlags.push(`-e A2A_ENABLED=false`);
	}
	if (config.mcpEnabled) {
		envFlags.push(`-e MCP_ENABLED=true`);
	}
	if (!config.llmsEnabled) {
		envFlags.push(`-e LLMS_ENABLED=false`);
	}
	if (!config.skillsMdEnabled) {
		envFlags.push(`-e SKILLS_MD_ENABLED=false`);
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
		(!config.databaseUrl || config.databaseUrl === "postgresql://key0:key0@postgres:5432/key0");

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
	if (!config.a2aEnabled) {
		envVars.A2A_ENABLED = "false";
	}
	if (config.mcpEnabled) {
		envVars.MCP_ENABLED = "true";
	}
	if (!config.llmsEnabled) {
		envVars.LLMS_ENABLED = "false";
	}
	if (!config.skillsMdEnabled) {
		envVars.SKILLS_MD_ENABLED = "false";
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
	if (managedRedis)
		dependsOnEntries.push(
			"      redis:\n        condition: service_healthy\n        required: false",
		);
	if (managedPostgres)
		dependsOnEntries.push(
			"      postgres:\n        condition: service_healthy\n        required: false",
		);

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
