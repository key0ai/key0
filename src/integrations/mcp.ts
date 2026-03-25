import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { ChallengeEngine } from "../core/index.js";
import { findCatalogRoute, listCatalogRoutes } from "../core/index.js";
import type { NetworkConfig, SellerConfig, X402PaymentPayload } from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { resolveConfigFetchResource } from "./pay-per-request.js";
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
	target: { kind: "plan"; id: string; resourceId: string } | { kind: "route"; id: string; path: string },
	config: SellerConfig,
	networkConfig: NetworkConfig,
) {
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const x402PaymentUrl = `${baseUrl}/x402/access`;
	const chargedResource = target.kind === "plan" ? target.resourceId : target.path;
	const paymentRequired = buildHttpPaymentRequirements(
		target.id,
		chargedResource,
		config,
		networkConfig,
	);
	const requestBody =
		target.kind === "plan"
			? `{"planId":"${target.id}","resourceId":"${target.resourceId}"}`
			: `{"routeId":"${target.id}","resource":{"method":"GET","path":"${target.path}"}}`;

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
							paymentInstructions: `To complete payment, use make_http_request_with_x402 with: URL="${x402PaymentUrl}", method="POST", body=${requestBody}, and pass the accepts array as paymentRequirements.`,
						},
						null,
						2,
				),
			},
		],
	};
}

/** Minimal Zod schema for X402PaymentPayload — validates required fields at the boundary. */
const x402PaymentPayloadSchema = z.object({
	x402Version: z.number(),
	network: z.string(),
	payload: z.object({
		signature: z.string().optional(),
		authorization: z
			.object({
				from: z.string().optional(),
				to: z.string().optional(),
				value: z.string().optional(),
				validAfter: z.string().optional(),
				validBefore: z.string().optional(),
				nonce: z.string().optional(),
			})
			.optional(),
		txHash: z.string().optional(),
	}),
	accepted: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Extract and validate the x402 payment payload from the MCP tool call's `_meta` field.
 * Returns undefined if no payment is present.
 * Throws Key0Error if the payload is present but malformed.
 */
function extractPaymentFromMeta(
	extra: { _meta?: Record<string, unknown> } | undefined,
): X402PaymentPayload | undefined {
	const meta = extra?._meta;
	if (!meta) return undefined;
	const payment = meta["x402/payment"];
	if (!payment || typeof payment !== "object") return undefined;

	const result = x402PaymentPayloadSchema.safeParse(payment);
	if (!result.success) {
		throw new Key0Error(
			"INVALID_REQUEST",
			`Invalid x402 payment payload in _meta: ${result.error.issues.map((i) => i.message).join(", ")}`,
			400,
		);
	}
	return payment as X402PaymentPayload;
}

/**
 * Derive a stable, deterministic requestId from the payment payload.
 * Uses the EIP-3009 signature (unique per authorization) so retries with the
 * same payment produce the same requestId, enabling idempotent recovery.
 */
function deriveRequestId(paymentPayload: X402PaymentPayload): string {
	const key =
		paymentPayload.payload?.signature ||
		paymentPayload.payload?.txHash ||
		JSON.stringify(paymentPayload.payload);
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `mcp-${hash}`;
}

// ---------------------------------------------------------------------------
// McpServer factory
// ---------------------------------------------------------------------------

/**
 * Create an McpServer with Key0 tools registered.
 *
 * Tools:
 * - `discover` (free) — browse the plan and route catalog
 * - `access` (x402-gated) — purchase access to a plan or route
 *
 * Payment follows the x402 MCP transport spec:
 * 1. Call without `_meta["x402/payment"]` → returns `isError: true` + `structuredContent` with PaymentRequired
 * 2. Call with `_meta["x402/payment"]` containing EIP-3009 signature → settles, returns access grant + `_meta["x402/payment-response"]`
 *
 * @see https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md
 */
export function createMcpServer(
	engine: ChallengeEngine,
	config: SellerConfig,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_perRequestRoutes?: Map<string, { method: string; path: string }[]>,
): McpServer {
	const networkConfig = config.rpcUrl
		? { ...CHAIN_CONFIGS[config.network], rpcUrl: config.rpcUrl }
		: CHAIN_CONFIGS[config.network];

	const server = new McpServer({
		name: config.agentName,
		version: config.version ?? "1.0.0",
	});

	// Tool 1: discover (free)
	server.registerTool(
		"discover",
		{
			title: "Discover Plans",
			description: `Discover available plans and routes for ${config.agentName}. Returns the catalog with plan IDs, prices (USDC), routes, wallet address, and chain ID needed for payment.`,
		},
		async () => {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								agentName: config.agentName,
								plans: (config.plans ?? []).map((p) => ({
									planId: p.planId,
									unitAmount: p.unitAmount,
									description: p.description,
								})),
								routes: listCatalogRoutes(config).map((r) => ({
									routeId: r.routeId,
									method: r.method,
									path: r.path,
									...(r.unitAmount ? { unitAmount: r.unitAmount } : {}),
									description: r.description,
								})),
								walletAddress: config.walletAddress,
								chainId: networkConfig.chainId,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	// Tool 2: access (x402-gated)
	const accessInputSchema = z
		.object({
			planId: z.string().optional().describe("Plan ID from discover"),
			routeId: z.string().optional().describe("Route ID from discover"),
			resourceId: z
				.string()
				.default("default")
				.describe("Specific resource ID for subscription plans (defaults to 'default')."),
			resource: z
				.object({
					method: z.string().describe("HTTP method to call on the backend (e.g. GET, POST)"),
					path: z.string().describe("Path to call on the backend (e.g. /api/weather/london)"),
					body: z.unknown().optional().describe("Optional request body to forward to the backend"),
				})
				.optional()
				.describe("The backend resource to call after payment."),
		})
		.refine((d) => !!(d.planId || d.routeId), { message: "Either planId or routeId is required" })
		.refine((d) => !(d.planId && d.routeId), {
			message: "Provide either planId or routeId, not both",
		});

	server.registerTool(
		"access",
		{
			title: "Request Access",
			description: [
				`Purchase access to a ${config.agentName} plan or route.`,
				"This tool is x402 payment-gated.",
				"For plan-based access: call without payment to get requirements, then re-call with x402 payment to receive an access token.",
				"For route-based access: provide routeId instead of planId.",
				"Call it to get payment requirements (amount, wallet, chainId, x402PaymentUrl).",
				"Then use make_http_request_with_x402 to POST to the x402PaymentUrl with either {planId, resourceId} for plan access or {routeId, resource} for route access.",
				"The x402 endpoint handles EIP-3009 payment signing and settlement automatically.",
			].join(" "),
			inputSchema: accessInputSchema,
		},
		async ({ planId, routeId, resourceId, resource }, extra) => {
			const paymentPayload = extractPaymentFromMeta(extra as { _meta?: Record<string, unknown> });
			const fetchResourceFn = resolveConfigFetchResource(config);

			// routeId branch — full standalone gateway flow
			if (routeId) {
				const route = findCatalogRoute(config, routeId);
				if (!route) {
					return {
						isError: true as const,
						content: [{ type: "text" as const, text: `Route "${routeId}" not found` }],
					};
				}

				if (!paymentPayload) {
					return buildPaymentRequiredResult(
						{ kind: "route", id: routeId, path: resource?.path ?? route.path },
						config,
						networkConfig,
					);
				}

				if (!fetchResourceFn) {
					return {
						isError: true as const,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "EMBEDDED_MODE",
									message:
										"Routes in embedded mode must be accessed via their route path directly.",
								}),
							},
						],
					};
				}

				const resourcePath = resource?.path ?? route.path;
				const resourceMethod = resource?.method ?? route.method ?? "GET";

				let txHash: `0x${string}`;
				let settleResponse: import("../types/index.js").X402SettleResponse;
				let payer: string | undefined;
				try {
					const settled = await settlePayment(paymentPayload, config, networkConfig);
					txHash = settled.txHash;
					settleResponse = settled.settleResponse;
					payer = settled.payer;
				} catch (err) {
					const code = err instanceof Key0Error ? err.code : "SETTLEMENT_FAILED";
					const message =
						err instanceof Key0Error ? err.message : "Payment settlement failed. Please try again.";
					return {
						isError: true as const,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: code, message }),
							},
						],
					};
				}

				const requestId = deriveRequestId(paymentPayload);

				const { challengeId, explorerUrl } = await engine.recordPerRequestPayment(
					requestId,
					routeId,
					resourcePath,
					txHash,
					payer as `0x${string}` | undefined,
				);

				await engine.assertPaidState(challengeId);

				let backendResult: Awaited<ReturnType<typeof fetchResourceFn>>;
				try {
					backendResult = await fetchResourceFn({
						method: resourceMethod,
						path: resourcePath,
						headers: {},
						paymentInfo: {
							txHash,
							payer: payer ?? undefined,
							planId: routeId,
							amount: route.unitAmount ?? "$0",
							method: resourceMethod,
							path: resourcePath,
							challengeId,
						},
					});
				} catch (err) {
					const isTimeout = err instanceof Error && err.name === "AbortError";
					const msg = isTimeout
						? "Backend timed out. A refund has been initiated."
						: `Backend error: ${(err as Error).message}. A refund has been initiated.`;
					await engine.initiateRefund(challengeId, "proxy_timeout").catch(() => {});
					return {
						isError: true as const,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: isTimeout ? "PROXY_TIMEOUT" : "PROXY_ERROR",
									message: msg,
								}),
							},
						],
					};
				}

				if (backendResult.status >= 400) {
					const msg = `Backend returned ${backendResult.status}. A refund has been initiated.`;
					await engine.initiateRefund(challengeId, "backend_non_2xx").catch(() => {});
					return {
						isError: true as const,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: "PROXY_ERROR", message: msg }),
							},
						],
					};
				}

				await engine.markDelivered(challengeId).catch(() => {});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									type: "ResourceResponse",
									challengeId,
									requestId,
									routeId,
									txHash,
									explorerUrl,
									resource: {
										status: backendResult.status,
										...(backendResult.headers !== undefined
											? { headers: backendResult.headers }
											: {}),
										body: backendResult.body,
									},
								},
								null,
								2,
							),
						},
					],
					_meta: { "x402/payment-response": settleResponse },
				};
			}

			const effectivePlanId = planId!;
			const plan = (config.plans ?? []).find((t) => t.planId === effectivePlanId);

			try {
				if (!paymentPayload) {
					// No payment — validate plan exists, then return x402 PaymentRequired signal
					if (!plan) {
						throw new Key0Error("TIER_NOT_FOUND", `Plan "${effectivePlanId}" not found`, 400);
					}
					if (plan.free === true) {
						throw new Key0Error(
							"INVALID_REQUEST",
							"Free plans are not supported via MCP access. Use free routes instead.",
							400,
						);
					}
					return buildPaymentRequiredResult(
						{ kind: "plan", id: effectivePlanId, resourceId },
						config,
						networkConfig,
					);
				}

				const { txHash, settleResponse, payer } = await settlePayment(
					paymentPayload,
					config,
					networkConfig,
				);

				// Derive stable requestId from payment signature for idempotent retry recovery
				const requestId = deriveRequestId(paymentPayload);

				// Subscription plan: issue access grant
				const grant = await engine.processHttpPayment(
					requestId,
					effectivePlanId,
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
				if (err instanceof Key0Error) {
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
								{ kind: "plan", id: effectivePlanId, resourceId },
								config,
								networkConfig,
							);
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
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_perRequestRoutes?: Map<string, { method: string; path: string }[]>,
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
