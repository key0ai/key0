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

	// Build pricing entries for each product tier
	const pricingEntries: SkillPricing[] = config.products.map((tier: ProductTier) => ({
		tierId: tier.tierId,
		label: tier.label,
		amount: tier.amount,
		asset: "USDC" as const,
		chainId: networkConfig.chainId,
		walletAddress: config.walletAddress,
	}));

	// Build tier list for description
	const tierList = config.products.map((p) => `"${p.tierId}"`).join(", ");
	const networkName = CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	// Define the two standard skills
	const skills: AgentSkill[] = [
		{
			id: "request-access",
			name: "Request Access",
			description:
				"Step 1 of 2: Request paid access to this API. Specify the access tier (tierId) you want. " +
				"Returns a Task with state 'input-required' and x402 payment requirements in metadata. " +
				`Payment is on-chain USDC on ${networkName}. ` +
				"After paying, use the 'submit-proof' skill to submit your transaction hash.",
			tags: ["payment", "access", "x402"],
			examples: [
				'Basic request payload: {"type":"AccessRequest","requestId":"<uuid>","tierId":"basic"}',
				'With optional fields: {"type":"AccessRequest","requestId":"<uuid>","tierId":"premium","clientAgentId":"agent://my-agent"}',
				JSON.stringify({
					jsonrpc: "2.0",
					method: "message/send",
					params: {
						message: {
							messageId: "<uuid>",
							role: "user",
							parts: [
								{
									kind: "data",
									data: {
										type: "AccessRequest",
										requestId: "<uuid>",
										tierId: "basic"
									}
								}
							]
						}
					},
					id: 1
				}, null, 2).replace(/\n/g, ' ')
			],
			inputSchema: {
				type: "object",
				properties: {
					type: {
						type: "string",
						description: "Message type discriminator. Must be 'AccessRequest'",
					},
					requestId: { type: "string", description: "Client-generated UUID for idempotency" },
					tierId: {
						type: "string",
						description: `Access tier to purchase. Available: ${tierList}`,
					},
					resourceId: {
						type: "string",
						description: "Optional: Specific resource identifier (defaults to general API access)",
					},
					clientAgentId: {
						type: "string",
						description: "Optional: Your agent identifier for tracking",
					},
					callbackUrl: {
						type: "string",
						description: "Optional: Webhook URL for async notifications",
					},
				},
				required: ["type", "requestId", "tierId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					type: { type: "string", description: "X402Challenge" },
					challengeId: { type: "string" },
					requestId: { type: "string" },
					tierId: { type: "string" },
					amount: { type: "string" },
					asset: { type: "string" },
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
				"Step 2 of 2: After making the on-chain USDC payment from Step 1, submit the transaction hash. " +
				"You can submit proof via message metadata (x402.payment.payload) or as a data part with type 'PaymentProof'. " +
				"On success, returns a Task with state 'completed' and an access token.",
			tags: ["payment", "proof", "verification"],
			examples: [
				'Payment proof payload: {"type":"PaymentProof","challengeId":"<from challenge>","requestId":"<from challenge>","chainId":84532,"txHash":"0x...","amount":"$0.99","asset":"USDC","fromAgentId":"agent://your-agent"}',
				JSON.stringify({
					jsonrpc: "2.0",
					method: "message/send",
					params: {
						message: {
							messageId: "<uuid>",
							role: "user",
							parts: [
								{
									kind: "data",
									data: {
										type: "PaymentProof",
										challengeId: "<from challenge>",
										requestId: "<from challenge>",
										chainId: networkConfig.chainId,
										txHash: "0x...",
										amount: "$0.99",
										asset: "USDC",
										fromAgentId: "agent://your-agent"
									}
								}
							]
						}
					},
					id: 1
				}, null, 2).replace(/\n/g, ' ')
			],
			inputSchema: {
				type: "object",
				properties: {
					type: { type: "string", description: "Message type discriminator. Must be 'PaymentProof'" },
					challengeId: { type: "string", description: "Challenge ID from the X402Challenge response" },
					requestId: { type: "string", description: "Request ID from the X402Challenge response" },
					chainId: { type: "number", description: "Blockchain chain ID where payment was made" },
					txHash: { type: "string", description: "Transaction hash of the payment" },
					amount: { type: "string", description: "Amount paid (e.g., '$0.99')" },
					asset: { type: "string", description: "Asset used for payment (e.g., 'USDC')" },
					fromAgentId: { type: "string", description: "DID or URL of the paying agent" },
				},
				required: [
					"type",
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
					challengeId: { type: "string" },
					requestId: { type: "string" },
					accessToken: { type: "string" },
					tokenType: { type: "string" },
					expiresAt: { type: "string" },
					resourceEndpoint: { type: "string" },
					resourceId: { type: "string" },
					tierId: { type: "string" },
					txHash: { type: "string" },
					explorerUrl: { type: "string" },
				},
			},
		},
	];

	const basePath = config.basePath ?? "/a2a";
	// Ensure no double slashes if agentUrl ends with /
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const endpointUrl = `${baseUrl}${basePath}`;

	const x402Extension: AgentExtension = {
		uri: X402_EXTENSION_URI,
		description:
			"Supports payments using the x402 protocol for on-chain USDC settlement. " +
			"Payment requirements are sent in task metadata with x402.payment.status and x402.payment.required keys.",
		required: true,
	};

	return {
		name: config.agentName,
		description:
			config.agentDescription +
			" | WORKFLOW: 2-step x402 payment protocol. " +
			"Step 1: Call 'request-access' with desired tierId → receive Task with 'input-required' state and payment instructions in x402 metadata. " +
			"Step 2: Pay on-chain, then call 'submit-proof' with txHash → receive Task with 'completed' state and access token. " +
			"Requires a crypto wallet capable of sending USDC.",
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
		defaultOutputModes: ["text"],
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
		],
	};
}
