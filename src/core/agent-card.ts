import type { AgentCard, AgentExtension, AgentSkill, SellerConfig } from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";
import { listCatalogRoutes } from "./route-catalog.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	// Core A2A skills (discovery + subscription purchase)
	// Additional per-request skills are appended below for each gated route.
	const skills: AgentSkill[] = [
		{
			id: "discover",
			name: "Discover",
			description: [
				`Browse available plans and pricing for ${config.agentName}.`,
				`Returns the product catalog with plan IDs, prices (USDC on ${networkName}), wallet address, and chain ID.`,
				`Endpoint: GET ${baseUrl}/discover`,
			].join(" "),
			tags: ["discovery", "catalog", "x402"],
			examples: [`GET ${baseUrl}/discover`],
		},
		{
			id: "access",
			name: "Access",
			description: [
				`Purchase access to a ${config.agentName} product plan via x402 payment on ${networkName}.`,
				`Step 1: GET ${baseUrl}/discover to list available plans.`,
				`Step 2: POST ${baseUrl}/x402/access with { planId, requestId } — server returns 402 with payment requirements.`,
				`Step 3: Pay USDC on-chain, then retry the same POST with PAYMENT-SIGNATURE header to receive the access token.`,
			].join(" "),
			tags: ["payment", "x402", "purchase"],
			examples: [
				`POST ${baseUrl}/x402/access with { "planId": "<plan-id>", "requestId": "<uuid>", "resourceId": "default" }`,
				`Receive HTTP 402 with x402 payment requirements`,
				`Pay USDC on-chain, retry same request with PAYMENT-SIGNATURE header`,
				`Receive 200 with access token`,
			],
			inputSchema: {
				type: "object",
				required: ["planId", "requestId"],
				properties: {
					planId: { type: "string", enum: (config.plans ?? []).map((p) => p.planId) },
					requestId: { type: "string", format: "uuid" },
					resourceId: { type: "string", default: "default" },
				},
			},
		},
	];

	// Per-request skills: one skill per route in config.routes.
	for (const route of listCatalogRoutes(config)) {
		const skillId = `ppr-${route.routeId}-${route.method.toLowerCase()}-${route.path.replace(/\//g, "-").replace(/[: ]/g, "")}`;

		// Build concrete example path (replace :param with <param>)
		const examplePath = route.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "<$1>");

		const routeExamples = route.unitAmount
			? [
					`${route.method} ${baseUrl}${examplePath}`,
					`Receive HTTP 402 with x402 payment requirements`,
					`Retry the same ${route.method} request with PAYMENT-SIGNATURE after paying ${route.unitAmount} USDC on-chain`,
					`Receive 200 with the backend response`,
				]
			: [
					`${route.method} ${baseUrl}${examplePath}`,
					`Receive 200 with the backend response (no payment required)`,
				];

		skills.push({
			id: skillId,
			name: `${route.method} ${route.path}`,
			description:
				route.description ??
				(route.unitAmount
					? `Pay-per-call route: ${route.unitAmount} USDC per request. Call ${route.method} ${baseUrl}${route.path} directly; Key0 returns a 402 first, then the backend response after payment.`
					: `Free endpoint: call ${route.method} ${baseUrl}${route.path} directly.`),
			tags: route.unitAmount ? ["pay-per-call", "x402"] : ["free"],
			examples: routeExamples,
		});
	}

	const x402Extension: AgentExtension = {
		uri: X402_EXTENSION_URI,
		description: `Supports x402 payments with USDC on ${networkName}.`,
		required: true,
	};

	return {
		name: config.agentName,
		description: config.agentDescription,
		url: `${baseUrl}/x402/access`,
		version: config.version ?? "1.0.0",
		protocolVersion: "0.3.0",
		capabilities: {
			extensions: [x402Extension],
			pushNotifications: false,
			streaming: false,
			stateTransitionHistory: false,
		},
		defaultInputModes: ["text"],
		defaultOutputModes: ["application/json"],
		skills,
		provider: {
			organization: config.providerName,
			url: config.providerUrl,
		},
	};
}
