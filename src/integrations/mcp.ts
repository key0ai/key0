import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { ChallengeEngine } from "../core/index.js";
import type { SellerConfig } from "../types/index.js";
import { AgentGateError, CHAIN_CONFIGS } from "../types/index.js";

/**
 * Create an McpServer with AgentGate tools registered.
 */
export function createMcpServer(engine: ChallengeEngine, config: SellerConfig): McpServer {
	const networkConfig = CHAIN_CONFIGS[config.network];

	const server = new McpServer({
		name: config.agentName,
		version: config.version ?? "1.0.0",
	});

	// Tool 1: discover_products
	server.registerTool(
		"discover_products",
		{
			title: "Discover Products",
			description: `Discover available products and pricing for ${config.agentName}. Returns the product catalog with tier IDs, prices (USDC), wallet address, and chain ID needed for payment.`,
		},
		async () => {
			const catalog = {
				agent: config.agentName,
				description: config.agentDescription,
				network: config.network,
				chainId: networkConfig.chainId,
				walletAddress: config.walletAddress,
				asset: "USDC",
				products: config.products.map((tier) => ({
					tierId: tier.tierId,
					label: tier.label,
					amount: tier.amount,
					resourceType: tier.resourceType,
					accessDurationSeconds: tier.accessDurationSeconds,
				})),
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }] };
		},
	);

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	// Tool 2: request_product_access
	server.registerTool(
		"request_product_access",
		{
			title: "Request Product Access",
			description: [
				"Request access to a product. Two-step flow:",
				"Step 1: Call WITHOUT txHash to get payment requirements (amount, wallet, chainId).",
				"Step 2: Call WITH txHash after sending USDC payment to complete the purchase and receive an access token.",
				"",
				"IMPORTANT: If using x402 payments (e.g. payments-mcp make_http_request_with_x402),",
				`use the x402 settlement endpoint: ${baseUrl}/x402/access`,
				"Pass tierId in the POST body and the endpoint handles the full x402 payment flow.",
			].join("\n"),
			inputSchema: {
				tierId: z.string().describe("Product tier ID from discover_products"),
				resourceId: z
					.string()
					.default("default")
					.describe("Specific resource ID (defaults to 'default')"),
				txHash: z
					.string()
					.optional()
					.describe(
						"On-chain USDC transaction hash. Omit for step 1 (get payment requirements), provide for step 2 (claim access token).",
					),
				fromAddress: z
					.string()
					.optional()
					.describe("Sender wallet address (for payment verification)"),
			},
		},
		async ({ tierId, resourceId, txHash, fromAddress }) => {
			const requestId = `mcp-${crypto.randomUUID()}`;

			try {
				if (!txHash) {
					// Step 1: Create challenge, return payment requirements
					const { challengeId } = await engine.requestHttpAccess(requestId, tierId, resourceId);

					const tier = config.products.find((t) => t.tierId === tierId);
					if (!tier) {
						throw new AgentGateError("TIER_NOT_FOUND", `Tier "${tierId}" not found`, 400);
					}

					const requirements = {
						status: "payment_required",
						challengeId,
						requestId,
						payTo: config.walletAddress,
						amount: tier.amount,
						asset: "USDC",
						chainId: networkConfig.chainId,
						network: `eip155:${networkConfig.chainId}`,
						usdcAddress: networkConfig.usdcAddress,
						explorerBaseUrl: networkConfig.explorerBaseUrl,
						x402PaymentUrl: `${baseUrl}/x402/access`,
						tier: {
							tierId: tier.tierId,
							label: tier.label,
							resourceType: tier.resourceType,
						},
					};

					return {
						content: [{ type: "text" as const, text: JSON.stringify(requirements, null, 2) }],
					};
				}

				// Step 2: Process payment, return access grant
				const grant = await engine.processHttpPayment(
					requestId,
					tierId,
					resourceId,
					txHash as `0x${string}`,
					fromAddress as `0x${string}` | undefined,
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ status: "access_granted", ...grant }, null, 2),
						},
					],
				};
			} catch (err: unknown) {
				if (err instanceof AgentGateError) {
					// Return cached grant for already-redeemed proofs
					if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											status: "access_granted",
											note: "Previously purchased — returning cached grant",
											...err.details["grant"],
										},
										null,
										2,
									),
								},
							],
						};
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(err.toJSON(), null, 2) }],
						isError: true as const,
					};
				}
				throw err;
			}
		},
	);

	return server;
}

/**
 * Mount MCP routes onto an existing Express Router.
 *
 * Adds:
 *   GET  /.well-known/mcp.json  — MCP discovery document
 *   POST /mcp                    — Streamable HTTP transport
 *   GET  /mcp                    — 405 (no SSE in stateless mode)
 *   DELETE /mcp                  — 405 (no sessions in stateless mode)
 */
export function mountMcpRoutes(
	router: Router,
	engine: ChallengeEngine,
	config: SellerConfig,
): void {
	const baseUrl = config.agentUrl.replace(/\/$/, "");

	// MCP Discovery
	router.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
		res.json({
			name: config.agentName,
			description: config.agentDescription,
			version: config.version ?? "1.0.0",
			transport: {
				type: "streamable-http",
				url: `${baseUrl}/mcp`,
			},
		});
	});

	// MCP Streamable HTTP transport (stateless — new server + transport per request)
	router.post("/mcp", async (req: Request, res: Response) => {
		try {
			const server = createMcpServer(engine, config);
			const transport = new StreamableHTTPServerTransport({});
			await server.connect(transport as Parameters<typeof server.connect>[0]);
			await transport.handleRequest(req, res, req.body);
		} catch (err: unknown) {
			if (!res.headersSent) {
				res.status(500).json({
					error: "MCP_INTERNAL_ERROR",
					message: err instanceof Error ? err.message : "Internal MCP error",
				});
			}
		}
	});

	// GET /mcp — SSE not supported in stateless mode
	router.get("/mcp", (_req: Request, res: Response) => {
		res.status(405).json({ error: "SSE not supported in stateless mode" });
	});

	// DELETE /mcp — session management not supported in stateless mode
	router.delete("/mcp", (_req: Request, res: Response) => {
		res.status(405).json({ error: "Session management not supported in stateless mode" });
	});
}
