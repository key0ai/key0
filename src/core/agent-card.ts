import type { AgentCard, AgentExtension, AgentSkill, SellerConfig } from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	// Two A2A spec-compliant skills (no pricing, no inputSchema, no outputSchema, no url)
	// Skill 1: Discovery (free) — browse the product catalog
	// Skill 2: Purchase (x402-gated) — buy an access token
	const skills: AgentSkill[] = [
		{
			id: "discover-products",
			name: "Discover Products",
			description: [
				`Browse available products and pricing for ${config.agentName}.`,
				`Returns the product catalog with plan IDs, prices (USDC on ${networkName}), wallet address, and chain ID.`,
				`POST to ${baseUrl}/x402/access with an empty body or without planId to discover products.`,
			].join(" "),
			tags: ["discovery", "catalog", "x402"],
			examples: [
				`POST ${baseUrl}/x402/access with empty body {}`,
				`Or call without planId to get 402 response with product catalog`,
			],
		},
		{
			id: "request-access",
			name: "Request Access",
			description: [
				`Purchase access to a ${config.agentName} product plan via x402 payment on ${networkName}.`,
				`First call discover-products to get available plans.`,
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
		},
	];

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
