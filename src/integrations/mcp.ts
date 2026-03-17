import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { ChallengeEngine } from "../core/index.js";
import type {
	NetworkConfig,
	PlanRouteInfo,
	ResourceResponse,
	SellerConfig,
	X402PaymentPayload,
} from "../types/index.js";
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
	planId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
) {
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const x402PaymentUrl = `${baseUrl}/x402/access`;
	const paymentRequired = buildHttpPaymentRequirements(planId, resourceId, config, networkConfig);

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
						paymentInstructions: `To complete payment, use make_http_request_with_x402 with: URL="${x402PaymentUrl}", method="POST", body={"planId":"${planId}","resourceId":"${resourceId}"}, and pass the accepts array as paymentRequirements.`,
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
 * - `discover_plans` (free) — browse the plan catalog
 * - `request_access` (x402-gated) — purchase an access token
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
	perRequestRoutes?: Map<string, PlanRouteInfo[]>,
): McpServer {
	const networkConfig = config.rpcUrl
		? { ...CHAIN_CONFIGS[config.network], rpcUrl: config.rpcUrl }
		: CHAIN_CONFIGS[config.network];

	const server = new McpServer({
		name: config.agentName,
		version: config.version ?? "1.0.0",
	});

	// Tool 1: discover_plans (free)
	server.registerTool(
		"discover_plans",
		{
			title: "Discover Plans",
			description: `Discover available plans and pricing for ${config.agentName}. Returns the plan catalog with plan IDs, prices (USDC), wallet address, and chain ID needed for payment. Per-request plans also include the routes they gate.`,
		},
		async () => {
			const catalog = {
				agent: config.agentName,
				description: config.agentDescription,
				network: config.network,
				chainId: networkConfig.chainId,
				walletAddress: config.walletAddress,
				asset: "USDC",
				plans: config.plans.map((tier) => {
					const effectiveRoutes = perRequestRoutes?.get(tier.planId) ?? tier.routes ?? [];
					return {
						planId: tier.planId,
						unitAmount: tier.unitAmount,
						mode: tier.mode ?? "subscription",
						...(tier.description ? { description: tier.description } : {}),
						...(effectiveRoutes.length > 0 ? { routes: effectiveRoutes } : {}),
					};
				}),
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
				`Purchase access to a ${config.agentName} plan.`,
				"This tool is x402 payment-gated.",
				"For subscription plans: call without payment to get requirements, then re-call with x402 payment to receive an access token.",
				"For per-request plans (standalone mode): include a 'resource' field specifying the backend endpoint to call.",
				"Call it to get payment requirements (amount, wallet, chainId, x402PaymentUrl).",
				"Then use make_http_request_with_x402 to POST to the x402PaymentUrl with {planId, resource} in the body.",
				"The x402 endpoint handles EIP-3009 payment signing and settlement automatically.",
			].join(" "),
			inputSchema: {
				planId: z.string().describe("Plan ID from discover_plans"),
				resourceId: z
					.string()
					.default("default")
					.describe(
						"Specific resource ID for subscription plans (defaults to 'default'). Not used for per-request plans.",
					),
				resource: z
					.object({
						method: z.string().describe("HTTP method to call on the backend (e.g. GET, POST)"),
						path: z.string().describe("Path to call on the backend (e.g. /api/weather/london)"),
						body: z
							.unknown()
							.optional()
							.describe("Optional request body to forward to the backend"),
					})
					.optional()
					.describe(
						"For per-request plans in standalone mode: the backend resource to call after payment.",
					),
			},
		},
		async ({ planId, resourceId, resource }, extra) => {
			const paymentPayload = extractPaymentFromMeta(extra as { _meta?: Record<string, unknown> });
			const plan = config.plans.find((t) => t.planId === planId);
			const fetchResourceFn = resolveConfigFetchResource(config);

			try {
				if (!paymentPayload) {
					// No payment — validate plan exists, then return x402 PaymentRequired signal
					if (!plan) {
						throw new Key0Error("TIER_NOT_FOUND", `Plan "${planId}" not found`, 400);
					}
					// Per-request plan in embedded mode: reject immediately
					if (plan.mode === "per-request" && !fetchResourceFn) {
						const routeMethod = plan.routes?.[0]?.method ?? "GET";
						const routePath = plan.routes?.[0]?.path ?? "/";
						return {
							isError: true as const,
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											error: "PER_REQUEST_EMBEDDED_MODE",
											message: `Per-request plans are not available via MCP in embedded mode. Use direct HTTP calls: ${routeMethod} ${routePath}`,
										},
										null,
										2,
									),
								},
							],
						};
					}
					return buildPaymentRequiredResult(planId, resourceId, config, networkConfig);
				}

				const { txHash, settleResponse, payer } = await settlePayment(
					paymentPayload,
					config,
					networkConfig,
				);

				// Derive stable requestId from payment signature for idempotent retry recovery
				const requestId = deriveRequestId(paymentPayload);

				// Branch on plan mode
				if (plan?.mode === "per-request") {
					if (!fetchResourceFn) {
						return {
							isError: true as const,
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											error: "PER_REQUEST_EMBEDDED_MODE",
											message: "Per-request plans are not available via MCP in embedded mode.",
										},
										null,
										2,
									),
								},
							],
						};
					}

					if (!resource?.method || !resource?.path) {
						return {
							isError: true as const,
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											error: "MISSING_RESOURCE_FIELD",
											message:
												'Per-request plans require a "resource" field: { method: "GET", path: "/api/example" }',
										},
										null,
										2,
									),
								},
							],
						};
					}

					// Record payment (PENDING → PAID) without token issuance
					const { challengeId, explorerUrl } = await engine.recordPerRequestPayment(
						requestId,
						planId,
						resource.path,
						txHash,
						payer as `0x${string}` | undefined,
					);

					// Proxy to backend
					const backendResult = await fetchResourceFn({
						paymentInfo: {
							txHash,
							payer: payer ?? undefined,
							planId,
							amount: plan.unitAmount,
							method: resource.method,
							path: resource.path,
							challengeId,
						},
						method: resource.method,
						path: resource.path,
						headers: {},
						body: resource.body,
					});

					if (backendResult.status >= 200 && backendResult.status < 300) {
						await engine.markDelivered(challengeId);
					} else {
						console.warn(
							`[Key0 MCP] Backend returned ${backendResult.status} — challenge stays PAID (refund cron eligible)`,
						);
					}

					const resourceResponse: ResourceResponse = {
						type: "ResourceResponse",
						challengeId,
						requestId,
						planId,
						txHash,
						explorerUrl,
						resource: {
							status: backendResult.status,
							...(backendResult.headers !== undefined ? { headers: backendResult.headers } : {}),
							body: backendResult.body,
						},
					};

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ status: "resource_delivered", ...resourceResponse },
									null,
									2,
								),
							},
						],
						_meta: {
							"x402/payment-response": settleResponse,
						},
					};
				}

				// Subscription plan: issue access grant
				const grant = await engine.processHttpPayment(
					requestId,
					planId,
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
							planId,
							resourceId,
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
	perRequestRoutes?: Map<string, PlanRouteInfo[]>,
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
		// Snapshot the registry at request time so each stateless server has current routes.
		const routeSnapshot = perRequestRoutes ? new Map(perRequestRoutes) : undefined;
		const server = createMcpServer(engine, config, routeSnapshot);
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
