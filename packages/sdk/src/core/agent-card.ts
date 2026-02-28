import { CHAIN_CONFIGS } from "../types/index.js";
import type {
	AgentCard,
	AgentSkill,
	NetworkConfig,
	NetworkName,
	ProductTier,
	SellerConfig,
	SkillPricing,
} from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];

	// Build pricing entries for each product tier
	const pricingEntries: SkillPricing[] = config.products.map((tier: ProductTier) => ({
		tierId: tier.tierId,
		label: tier.label,
		amount: tier.amount,
		asset: "USDC" as const,
		chainId: networkConfig.chainId,
		walletAddress: config.walletAddress,
	}));

	// Define the two standard skills
	const skills: AgentSkill[] = [
		{
			id: "request-access",
			name: "Request Resource Access",
			description:
				"Submit an access request to receive a payment challenge. Pay the challenge to get an access token.",
			tags: ["payment", "access", "x402"],
			inputSchema: {
				type: "object",
				properties: {
					requestId: { type: "string", description: "Client-generated UUID for idempotency" },
					resourceId: { type: "string", description: "Identifier of the resource to access" },
					tierId: { type: "string", description: "Product tier to purchase" },
					clientAgentId: { type: "string", description: "DID or URL of the requesting agent" },
					callbackUrl: {
						type: "string",
						description: "Optional webhook URL for async fulfillment",
					},
				},
				required: ["requestId", "resourceId", "tierId", "clientAgentId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					type: { type: "string", description: "X402Challenge" },
					challengeId: { type: "string" },
					amount: { type: "string" },
					chainId: { type: "number" },
					destination: { type: "string" },
					expiresAt: { type: "string" },
				},
			},
			pricing: pricingEntries,
		},
		{
			id: "submit-proof",
			name: "Submit Payment Proof",
			description:
				"Submit on-chain payment proof (txHash) for a challenge. Returns an access token on success.",
			tags: ["payment", "proof", "verification"],
			inputSchema: {
				type: "object",
				properties: {
					type: { type: "string", description: "PaymentProof" },
					challengeId: { type: "string" },
					requestId: { type: "string" },
					chainId: { type: "number" },
					txHash: { type: "string" },
					amount: { type: "string" },
					asset: { type: "string" },
					fromAgentId: { type: "string" },
				},
				required: [
					"challengeId",
					"requestId",
					"chainId",
					"txHash",
					"amount",
					"asset",
					"fromAgentId",
				],
			},
			outputSchema: {
				type: "object",
				properties: {
					type: { type: "string", description: "AccessGrant" },
					accessToken: { type: "string" },
					tokenType: { type: "string" },
					expiresAt: { type: "string" },
					resourceEndpoint: { type: "string" },
				},
			},
		},
	];

	const basePath = config.basePath ?? "/agent";
	// Ensure no double slashes if agentUrl ends with /
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const endpointUrl = `${baseUrl}${basePath}`;

	return {
		name: config.agentName,
		description: config.agentDescription,
		url: config.agentUrl,
		version: config.version ?? "1.0.0",
		protocolVersion: "0.3.0",
		capabilities: {
			a2a: true,
			paymentProtocols: ["x402"],
			pushNotifications: false,
		},
		defaultInputModes: ["application/json"],
		defaultOutputModes: ["application/json"],
		skills,
		provider: {
			name: config.providerName,
			url: config.providerUrl,
		},
		additionalInterfaces: [
			{
				url: endpointUrl,
				transport: "JSONRPC",
			},
			{
				url: `${endpointUrl}/rest`,
				transport: "HTTP+JSON",
			},
		],
	};
}
