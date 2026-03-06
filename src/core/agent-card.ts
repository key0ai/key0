import type {
	AgentCard,
	AgentExtension,
	AgentSkill,
	ProductTier,
	SellerConfig,
	SkillPricing,
} from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	// Build endpoint URL first (needed for skills)
	const basePath = config.basePath ?? "/a2a";
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const _endpointUrl = `${baseUrl}${basePath}`;

	// Build skills - one per product tier (minimal, reference-style)
	const skills: AgentSkill[] = config.products.map((tier: ProductTier) => {
		const pricingEntry: SkillPricing = {
			tierId: tier.tierId,
			label: tier.label,
			amount: tier.amount,
			asset: "USDC" as const,
			chainId: networkConfig.chainId,
			walletAddress: config.walletAddress,
		};

		return {
			id: tier.tierId,
			name: tier.label,
			description: `${tier.label} — ${tier.amount} USDC on ${networkName}. Access via JSON-RPC method 'message/send' with AccessRequest, or direct HTTP POST to the URL field with body: { tierId, requestId, resourceId }. Server responds with HTTP 402 payment challenge; include PAYMENT-SIGNATURE header with x402 payment payload to complete payment.`,
			tags: ["x402", "payment"],
			url: `${baseUrl}/x402/access`,
			examples: [
				JSON.stringify({
					messageId: "<uuid>",
					role: "user",
					parts: [
						{
							kind: "data",
							data: {
								type: "AccessRequest",
								tierId: tier.tierId,
								requestId: "<uuid>",
								resourceId: "photo-1",
							},
						},
					],
				}),
				`POST ${baseUrl}/x402/access with body: ${JSON.stringify({ tierId: tier.tierId, requestId: "<uuid>", resourceId: "default" })}`,
			],
			inputSchema: {
				type: "object",
				properties: {
					type: {
						type: "string",
						const: "AccessRequest",
						description: "Must be 'AccessRequest'",
					},
					tierId: {
						type: "string",
						description: `Tier to purchase. Must be '${tier.tierId}'`,
					},
					requestId: {
						type: "string",
						description: "Client-generated UUID for idempotency",
					},
					resourceId: {
						type: "string",
						description: "Optional: Specific resource identifier (defaults to 'default')",
					},
				},
				required: ["type", "tierId", "requestId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					accessToken: { type: "string", description: "JWT token for API access" },
					tokenType: { type: "string", description: "Token type (usually 'Bearer')" },
					expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
					resourceEndpoint: { type: "string", description: "URL to access the protected resource" },
					txHash: { type: "string", description: "On-chain transaction hash" },
					explorerUrl: { type: "string", description: "Blockchain explorer URL" },
				},
			},
			pricing: [pricingEntry],
		};
	});

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
