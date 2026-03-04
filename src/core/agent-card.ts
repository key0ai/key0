import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";
import type {
	AgentCard,
	AgentExtension,
	AgentSkill,
	NetworkConfig,
	NetworkName,
	ProductTier,
	SellerConfig,
	SkillPricing,
} from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

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
			description: `${tier.label} — ${tier.amount} USDC on ${networkName}. Send via JSON-RPC method 'message/send' with a data part containing type "AccessRequest". The server responds with a 402 payment challenge; reply with the x402 payment payload in message metadata to complete payment.`,
			tags: ["x402", "payment"],
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

	const basePath = config.basePath ?? "/a2a";
	// Ensure no double slashes if agentUrl ends with /
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const endpointUrl = `${baseUrl}${basePath}`;

	const x402Extension: AgentExtension = {
		uri: X402_EXTENSION_URI,
		description: `Supports x402 payments with USDC on ${networkName}.`,
		required: true,
	};

	return {
		name: config.agentName,
		description: config.agentDescription,
		url: `${endpointUrl}/jsonrpc`,
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
