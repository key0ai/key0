import { CHAIN_CONFIGS, X402_EXTENSION_URI, CHAIN_ID_TO_NETWORK } from "../types/index.js";
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
	const networkName = CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	// Build skills - one per product tier
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
			description:
				`Access "${tier.label}" tier for ${tier.amount} USDC on ${networkName}. ` +
				`This endpoint uses the x402 payment protocol. ` +
				`Send an AccessRequest with tierId="${tier.tierId}". ` +
				`If you receive HTTP 402 status, decode the base64 PAYMENT-REQUIRED response header to get payment requirements, ` +
				`create an EIP-3009 transferWithAuthorization signature off-chain, ` +
				`encode it as base64, then retry the same request with the PAYMENT-SIGNATURE request header.`,
			tags: ["x402", "payment", tier.resourceType || "access"],
			examples: [
				`{"type":"AccessRequest","requestId":"<uuid>","tierId":"${tier.tierId}"}`,
			],
			inputSchema: {
				type: "object",
				properties: {
					type: {
						type: "string",
						description: "Must be 'AccessRequest'",
					},
					requestId: { 
						type: "string", 
						description: "Client-generated UUID for idempotency" 
					},
					tierId: { 
						type: "string", 
						description: `Must be '${tier.tierId}'` 
					},
					resourceId: {
						type: "string",
						description: "Optional: Specific resource identifier (defaults to general API access)",
					},
				},
				required: ["type", "requestId", "tierId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					accessToken: { type: "string", description: "JWT token for API access" },
					tokenType: { type: "string", description: "Token type (usually 'Bearer')" },
					expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
					resourceEndpoint: { type: "string", description: "URL to access the protected resource" },
					resourceId: { type: "string", description: "Resource identifier" },
					tierId: { type: "string", description: "Tier ID that was purchased" },
					txHash: { type: "string", description: "On-chain transaction hash" },
					explorerUrl: { type: "string", description: "Blockchain explorer URL for the transaction" },
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
		description:
			"Supports x402 protocol for on-chain USDC payments. " +
			"On HTTP 402 response, decode the base64 PAYMENT-REQUIRED header, sign an EIP-3009 authorization, " +
			"then retry with base64-encoded payment in the PAYMENT-SIGNATURE header. " +
			"Server settles the payment on-chain and returns an access token on success.",
		required: true,
	};

	return {
		name: config.agentName,
		description:
			config.agentDescription +
			" | Uses x402 payment protocol with USDC on " + networkName + ". " +
			"Call any skill endpoint - if payment is required you'll receive HTTP 402 with payment details. " +
			"Sign the payment off-chain and retry with the signature to complete access.",
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
		additionalInterfaces: [
			{
				url: `${endpointUrl}/jsonrpc`,
				transport: "JSONRPC",
			},
			{
				url: `${endpointUrl}/rest`,
				transport: "HTTP+JSON",
			},
			{
				url: `${endpointUrl}/access`,
				transport: "HTTP+JSON",
			},
		],
	};
}
