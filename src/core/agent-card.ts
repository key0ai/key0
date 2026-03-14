import type { AgentCard, AgentExtension, AgentSkill, SellerConfig } from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	const planIds = config.plans.map((p) => p.planId);

	// Two A2A spec-compliant skills
	// Skill 1: Discovery (free) — browse the product catalog
	// Skill 2: Purchase (x402-gated) — buy an access token
	const skills: AgentSkill[] = [
		{
			id: "discover-plans",
			name: "Discover Plans",
			description: [
				`Browse available plans and pricing for ${config.agentName}.`,
				`Returns the product catalog with plan IDs, prices (USDC on ${networkName}), wallet address, and chain ID.`,
				`GET to ${baseUrl}/discovery to discover plans.`,
			].join(" "),
			tags: ["discovery", "catalog", "x402"],
			examples: [`GET ${baseUrl}/discovery`],
			endpoint: { url: `${baseUrl}/discovery`, method: "GET" },
		},
		{
			id: "request-access",
			name: "Request Access",
			description: [
				`Purchase access to a ${config.agentName} product plan via x402 payment on ${networkName}.`,
				`First call discover-plans to get available plans.`,
				`Then POST to ${baseUrl}/x402/access with planId and requestId to initiate purchase.`,
				`Server responds with x402 payment challenge.`,
				`Complete payment on-chain and include PAYMENT-SIGNATURE header to receive access token.`,
			].join(" "),
			tags: ["payment", "x402", "purchase"],
			examples: [
				`POST ${baseUrl}/x402/access with { planId: "<plan-id>", requestId: "<uuid>", resourceId: "default" }`,
				`Receive 402 with payment challenge`,
				`Pay USDC on-chain, retry same request with PAYMENT-SIGNATURE header`,
				`Receive 200 with access token`,
			],
			endpoint: { url: `${baseUrl}/x402/access`, method: "POST" },
			inputSchema: {
				type: "object",
				required: ["planId", "requestId"],
				properties: {
					planId: { type: "string", enum: planIds },
					requestId: { type: "string", format: "uuid" },
				},
			},
			workflow: [
				"POST body with planId + requestId to endpoint.url — expect 402",
				"Extract payment requirements from 402 response body",
				`Sign and broadcast USDC transfer on ${networkName}`,
				"Retry same POST with PAYMENT-SIGNATURE header containing the transaction hash",
				"Receive 200 with accessToken",
			],
		},
	];

	const x402Extension: AgentExtension = {
		uri: X402_EXTENSION_URI,
		description: `Supports x402 payments with USDC on ${networkName}.`,
		required: true,
	};

	return {
		name: config.agentName,
		description: `${config.agentDescription} To discover plans, you must call the discovery endpoint: GET ${baseUrl}/discovery`,
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
