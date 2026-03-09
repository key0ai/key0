import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { ChallengeEngine } from "../core/index.js";
import type { NetworkConfig, SellerConfig, X402PaymentPayload } from "../types/index.js";
import { AgentGateError, CHAIN_CONFIGS } from "../types/index.js";
import { buildHttpPaymentRequirements, settlePayment } from "./settlement.js";

// ---------------------------------------------------------------------------
// x402 MCP helpers
// ---------------------------------------------------------------------------

/**
 * Build the x402 PaymentRequired tool result per the MCP transport spec.
 * Returns `isError: true` with both `structuredContent` and `content[0].text`.
 *
 * The `resource.url` points to the HTTPS x402 endpoint so that HTTP-based
 * payment tools (e.g. payments-mcp `make_http_request_with_x402`) can
 * complete the payment directly. Future x402-native MCP clients can also
 * use `_meta["x402/payment"]` to pay inline.
 *
 * @see https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md
 */
function buildPaymentRequiredResult(
	tierId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
) {
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const x402PaymentUrl = `${baseUrl}/x402/access`;
	const paymentRequired = buildHttpPaymentRequirements(tierId, resourceId, config, networkConfig);

	const structuredContent = {
		...paymentRequired,
		error: "Payment required to access this resource",
		resource: {
			url: x402PaymentUrl,
			description: paymentRequired.resource.description,
			mimeType: "application/json",
		},
	};

	return {
		isError: true as const,
		structuredContent,
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						...structuredContent,
						x402PaymentUrl,
						paymentInstructions: `To complete payment, use make_http_request_with_x402 with: URL="${x402PaymentUrl}", method="POST", body={"tierId":"${tierId}","resourceId":"${resourceId}"}, and pass the accepts array as paymentRequirements.`,
					},
					null,
					2,
				),
			},
		],
	};
}

/**
 * Extract the x402 payment payload from the MCP tool call's `_meta` field.
 * Returns undefined if no payment is present.
 */
function extractPaymentFromMeta(
	extra: { _meta?: Record<string, unknown> } | undefined,
): X402PaymentPayload | undefined {
	const meta = extra?._meta;
	if (!meta) return undefined;
	const payment = meta["x402/payment"];
	if (!payment || typeof payment !== "object") return undefined;
	return payment as X402PaymentPayload;
}

// ---------------------------------------------------------------------------
// McpServer factory
// ---------------------------------------------------------------------------

/**
 * Create an McpServer with AgentGate tools registered.
 *
 * Tools:
 * - `discover_products` (free) — browse the product catalog
 * - `request_access` (x402-gated) — purchase an access token
 *
 * Payment follows the x402 MCP transport spec:
 * 1. Call without `_meta["x402/payment"]` → returns `isError: true` + `structuredContent` with PaymentRequired
 * 2. Call with `_meta["x402/payment"]` containing EIP-3009 signature → settles, returns access grant + `_meta["x402/payment-response"]`
 *
 * @see https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md
 */
export function createMcpServer(engine: ChallengeEngine, config: SellerConfig): McpServer {
	const networkConfig = CHAIN_CONFIGS[config.network];

	const server = new McpServer({
		name: config.agentName,
		version: config.version ?? "1.0.0",
	});

	// Tool 1: discover_products (free)
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

	// Tool 2: request_access (x402-gated)
	server.registerTool(
		"request_access",
		{
			title: "Request Access",
			description: [
				`Purchase access to a ${config.agentName} product tier.`,
				"This tool is x402 payment-gated.",
				"Call it to get payment requirements (amount, wallet, chainId, x402PaymentUrl).",
				"Then use make_http_request_with_x402 to POST to the x402PaymentUrl with {tierId, resourceId} in the body and the accepts array as paymentRequirements.",
				"The x402 endpoint handles EIP-3009 payment signing and settlement automatically.",
			].join(" "),
			inputSchema: {
				tierId: z.string().describe("Product tier ID from discover_products"),
				resourceId: z
					.string()
					.default("default")
					.describe("Specific resource ID (defaults to 'default')"),
			},
		},
		async ({ tierId, resourceId }, extra) => {
			const paymentPayload = extractPaymentFromMeta(extra as { _meta?: Record<string, unknown> });

			try {
				if (!paymentPayload) {
					// No payment — return x402 PaymentRequired signal
					const tier = config.products.find((t) => t.tierId === tierId);
					if (!tier) {
						throw new AgentGateError("TIER_NOT_FOUND", `Tier "${tierId}" not found`, 400);
					}
					return buildPaymentRequiredResult(tierId, resourceId, config, networkConfig);
				}

				// Has payment — settle and issue access token
				const { txHash, settleResponse, payer } = await settlePayment(
					paymentPayload,
					config,
					networkConfig,
				);

				const requestId = `mcp-${crypto.randomUUID()}`;
				const grant = await engine.processHttpPayment(
					requestId,
					tierId,
					resourceId,
					txHash,
					payer as `0x${string}` | undefined,
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ status: "access_granted", ...grant }, null, 2),
						},
					],
					_meta: {
						"x402/payment-response": settleResponse,
					},
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

					// Settlement / payment errors — return PaymentRequired with error reason
					if (err.code === "PAYMENT_FAILED" || err.httpStatus === 402) {
						const failResult = buildPaymentRequiredResult(
							tierId,
							resourceId,
							config,
							networkConfig,
						);
						// Override the generic error with the specific failure message
						const failContent = {
							...(failResult.structuredContent as Record<string, unknown>),
							error: err.message,
						};
						return {
							isError: true as const,
							structuredContent: failContent,
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(failContent, null, 2),
								},
							],
						};
					}

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(err.toJSON(), null, 2),
							},
						],
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
		const server = createMcpServer(engine, config);
		const transport = new StreamableHTTPServerTransport({});
		try {
			await server.connect(transport as Parameters<typeof server.connect>[0]);
			await transport.handleRequest(req, res, req.body);
		} catch (err: unknown) {
			if (!res.headersSent) {
				res.status(500).json({
					error: "MCP_INTERNAL_ERROR",
					message: err instanceof Error ? err.message : "Internal MCP error",
				});
			}
		} finally {
			await server.close();
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
