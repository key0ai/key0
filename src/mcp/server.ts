import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ChallengeEngine } from "../core/index.js";
import { CHAIN_CONFIGS } from "../types/config-shared.js";
import { AgentGateError } from "../types/errors.js";
import type { SellerConfig } from "../types/index.js";

/**
 * Build an MCP server with 3 tools from an existing ChallengeEngine + SellerConfig.
 *
 * Tools:
 *   - get_pricing: Discover available tiers and prices
 *   - request_access: Get a payment challenge for a resource
 *   - submit_proof: Submit on-chain txHash, receive JWT access token
 */
export function buildMcpServer(engine: ChallengeEngine, config: SellerConfig): McpServer {
	const networkConfig = CHAIN_CONFIGS[config.network];

	const server = new McpServer({
		name: config.agentName,
		version: config.version ?? "1.0.0",
	});

	// Tool 1: get_pricing
	server.registerTool("get_pricing", {
		title: "Get Pricing",
		description: `Get available product tiers and pricing for ${config.agentName}. Returns tier IDs, prices in USDC, and payment details needed to request access.`,
	}, async () => {
		const tiers = config.products.map((t) => ({
			tierId: t.tierId,
			label: t.label,
			amount: t.amount,
			asset: "USDC" as const,
			resourceType: t.resourceType,
			...(t.accessDurationSeconds !== undefined
				? { accessDurationSeconds: t.accessDurationSeconds }
				: {}),
		}));

		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					agentName: config.agentName,
					description: config.agentDescription,
					network: config.network,
					chainId: networkConfig.chainId,
					walletAddress: config.walletAddress,
					tiers,
				}, null, 2),
			}],
		};
	});

	// Tool 2: request_access
	server.registerTool("request_access", {
		title: "Request Access",
		description:
			"Request access to a resource. Returns a payment challenge with the USDC amount, destination wallet address, and chain ID. After paying on-chain, call submit_proof with the transaction hash.",
		inputSchema: {
			resourceId: z.string().describe("Identifier of the resource to access"),
			tierId: z.string().describe("Product tier ID to purchase (from get_pricing)"),
			clientAgentId: z
				.string()
				.optional()
				.describe("Identifier of the requesting agent (defaults to 'mcp-client')"),
		},
	}, async ({ resourceId, tierId, clientAgentId }) => {
		try {
			const challenge = await engine.requestAccess({
				requestId: uuidv4(),
				resourceId,
				tierId,
				clientAgentId: clientAgentId ?? "mcp-client",
			});

			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify(challenge, null, 2),
				}],
			};
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify(err.toJSON(), null, 2),
					}],
					isError: true,
				};
			}
			throw err;
		}
	});

	// Tool 3: submit_proof
	server.registerTool("submit_proof", {
		title: "Submit Payment Proof",
		description:
			"Submit an on-chain USDC payment proof (transaction hash) for a payment challenge. Returns an access token (JWT) and the resource endpoint URL. Use the token as a Bearer token to call the resource endpoint.",
		inputSchema: {
			challengeId: z.string().describe("The challengeId from the payment challenge response"),
			requestId: z.string().describe("The requestId from the payment challenge response"),
			txHash: z
				.string()
				.describe("The on-chain USDC transaction hash (0x-prefixed)"),
			amount: z.string().describe("The dollar amount paid, e.g. '$0.10'"),
			chainId: z
				.number()
				.describe("Chain ID where payment was made (8453 = Base mainnet, 84532 = Base Sepolia)"),
			fromAgentId: z
				.string()
				.optional()
				.describe("Identifier of the paying agent (defaults to 'mcp-client')"),
		},
	}, async ({ challengeId, requestId, txHash, amount, chainId, fromAgentId }) => {
		try {
			const grant = await engine.submitProof({
				type: "PaymentProof",
				challengeId,
				requestId,
				chainId,
				txHash: txHash as `0x${string}`,
				amount,
				asset: "USDC",
				fromAgentId: fromAgentId ?? "mcp-client",
			});

			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify(grant, null, 2),
				}],
			};
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify(err.toJSON(), null, 2),
					}],
					isError: true,
				};
			}
			throw err;
		}
	});

	return server;
}
