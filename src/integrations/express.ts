import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { type NextFunction, type Request, type Response, Router } from "express";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type {
	PlanRouteInfo,
	ResourceResponse,
	X402PaymentRequiredResponse,
} from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { mountMcpRoutes } from "./mcp.js";
import type { PayPerRequestOptions } from "./pay-per-request.js";
import {
	createExpressPayPerRequest,
	mergePerRequestRoutes,
	resolveConfigFetchResource,
} from "./pay-per-request.js";
import {
	buildDiscoveryResponse,
	buildHttpPaymentRequirements,
	decodePaymentSignature,
	settlePayment,
} from "./settlement.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpressMiddleware = (
	req: { method: string; path: string; originalUrl: string; headers: Record<string, unknown> },
	res: {
		status: (code: number) => { json: (data: unknown) => unknown };
		setHeader: (name: string, value: string) => void;
		statusCode: number;
		on: (event: string, cb: () => void) => void;
	},
	next: () => void,
) => unknown | Promise<unknown>;

/**
 * Extended Express Router returned by `key0Router`.
 *
 * Can be used exactly like a plain Router (`app.use(key0)`), but also
 * exposes a `.payPerRequest()` factory that shares config, stores, and
 * settlement logic with the router.
 *
 * @example
 * ```ts
 * const key0 = key0Router({ config, adapter, store, seenTxStore });
 * app.use(key0);
 *
 * // Per-request payment — shares config with key0Router
 * app.get("/api/weather/:city",
 *   key0.payPerRequest("weather-query"),
 *   (req, res) => res.json({ temp: 72 }),
 * );
 * ```
 */
export type Key0Router = Router & {
	/**
	 * Create a per-request payment middleware for the given plan.
	 *
	 * The middleware returns **402** when no `PAYMENT-SIGNATURE` header is present,
	 * and settles on-chain + calls `next()` when one is provided.
	 *
	 * @param planId - Which plan from `config.plans` to charge per request
	 * @param options - Optional callbacks (e.g. `onPayment`)
	 */
	payPerRequest: (planId: string, options?: PayPerRequestOptions) => ExpressMiddleware;
};

/**
 * Create an Express router that serves the agent card, the unified x402 endpoint,
 * and exposes a `.payPerRequest()` factory for per-request payment gating.
 *
 * Usage:
 *   const key0 = key0Router({ config, adapter, store, seenTxStore });
 *   app.use(key0);
 *
 *   // Gate individual routes with per-request payment
 *   app.get("/api/weather/:city", key0.payPerRequest("weather-query"), handler);
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json          — A2A agent card (discovery)
 *   POST /x402/access                     — unified endpoint
 *     • X-A2A-Extensions header present   → delegates to A2A JSON-RPC handler
 *     • No header                         → x402 HTTP flow (discovery / challenge / settle)
 *   POST /mcp                             — MCP Streamable HTTP (when mcp: true)
 */
export function key0Router(opts: Key0Config): Key0Router {
	const { requestHandler, engine } = createKey0(opts);
	const router = Router() as Key0Router;
	const networkConfig = opts.config.rpcUrl
		? { ...CHAIN_CONFIGS[opts.config.network], rpcUrl: opts.config.rpcUrl }
		: CHAIN_CONFIGS[opts.config.network];

	// ── Pay-per-request factory ──────────────────────────────────────────
	// Shares config, stores, and networkConfig with this router instance.
	const pprDeps = {
		config: opts.config,
		networkConfig,
		seenTxStore: opts.seenTxStore,
		store: opts.store,
	} as const;

	// Runtime route registry: populated when .payPerRequest() is called with options.route.
	// Discovery merges these with config-declared routes at request time.
	const pprRouteRegistry = new Map<string, PlanRouteInfo[]>();

	router.payPerRequest = (planId: string, options?: PayPerRequestOptions) => {
		if (options?.route) {
			const existing = pprRouteRegistry.get(planId) ?? [];
			existing.push(options.route);
			pprRouteRegistry.set(planId, existing);
		}
		return createExpressPayPerRequest(planId, pprDeps, options);
	};

	// Agent Card
	router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
	router.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

	// Unified x402 endpoint with A2A JSON-RPC fallback
	// When X-A2A-Extensions header is present, the request is delegated to the
	// A2A JSON-RPC handler (executor). Otherwise, it is handled as plain x402 HTTP.
	router.post(
		`/x402/access`,
		async (req: Request, res: Response, next: NextFunction) => {
			// ===== A2A-native clients: delegate to JSON-RPC handler =====
			if (req.headers["x-a2a-extensions"]) {
				console.log(
					"[x402-access] X-A2A-Extensions header detected → delegating to JSON-RPC handler",
				);
				return next();
			}

			const startTime = Date.now();
			try {
				console.log("\n[x402-access] ========== NEW REQUEST ==========");
				console.log(`[x402-access] Timestamp: ${new Date().toISOString()}`);
				console.log(`[x402-access] Method: ${req.method}`);
				console.log(`[x402-access] URL: ${req.url}`);
				console.log("[x402-access] Body:", JSON.stringify(req.body, null, 2));
				console.log("[x402-access] Headers:", JSON.stringify(req.headers, null, 2));

				// Parse body (allow empty for discovery)
				const body = req.body || {};
				let { planId, resourceId = "default" } = body;
				let { requestId } = body;
				const resource = body.resource as
					| { method: string; path: string; body?: unknown }
					| undefined;

				// Check for PAYMENT-SIGNATURE header
				const paymentSignature = req.headers["payment-signature"] as string | undefined;
				console.log(`[x402-access] PAYMENT-SIGNATURE present: ${!!paymentSignature}`);

				// ===== x402 shortcut: extract planId from PAYMENT-SIGNATURE if not in body =====
				// Standard x402 clients replay the same request with PAYMENT-SIGNATURE header.
				// The planId is embedded in accepted.extra.planId within the signed payload.
				if (!planId && paymentSignature) {
					try {
						const decoded = decodePaymentSignature(paymentSignature);
						const sigTierId = decoded.accepted?.extra?.["planId"] as string | undefined;
						if (sigTierId) {
							console.log(
								`[x402-access] ✓ Extracted planId="${sigTierId}" from PAYMENT-SIGNATURE (x402 replay)`,
							);
							planId = sigTierId;
						}
					} catch (err) {
						console.log(
							`[x402-access] ⚠ Failed to decode PAYMENT-SIGNATURE for planId extraction: ${err}`,
						);
						// Fall through to discovery — the signature might be malformed
					}
				}

				// ===== CASE 1: No planId → 400 pointing to GET /discovery =====
				if (!planId) {
					return res.status(400).json({
						error:
							"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discovery",
					});
				}

				// Auto-generate requestId if not provided (for simplicity)
				if (!requestId) {
					requestId = `http-${crypto.randomUUID()}`;
					console.log(`[x402-access] Auto-generated requestId: ${requestId}`);
				}

				console.log(
					`[x402-access] Parsed request - planId: ${planId}, requestId: ${requestId}, resourceId: ${resourceId}`,
				);

				// ===== CASE 2: planId present, no PAYMENT-SIGNATURE → Challenge (402 + PENDING record) =====
				if (!paymentSignature) {
					console.log(
						"[x402-access] → CASE 2: planId provided, no PAYMENT-SIGNATURE, issuing 402 challenge",
					);

					// Validate: per-request plans in standalone mode require a resource field
					const planForValidation = opts.config.plans.find((p) => p.planId === planId);
					const isStandaloneMode = !!resolveConfigFetchResource(opts.config);
					if (planForValidation?.mode === "per-request" && isStandaloneMode && !resource) {
						return res.status(400).json({
							type: "Error",
							code: "RESOURCE_REQUIRED",
							message:
								"Per-request plans in standalone mode require a 'resource' field (method + path).",
						});
					}

					console.log(`[x402-access] Creating PENDING record for requestId: ${requestId}`);

					// Create PENDING record via engine (handles tier/resource validation and idempotency)
					const { challengeId } = await engine.requestHttpAccess(requestId, planId, resourceId);
					console.log(`[x402-access] ✓ PENDING record created, challengeId=${challengeId}`);

					// Determine plan mode to add resource field to schema for per-request plans
					const planForChallenge = opts.config.plans.find((p) => p.planId === planId);
					const isPprPlan = planForChallenge?.mode === "per-request";
					const isStandaloneForChallenge = !!resolveConfigFetchResource(opts.config);

					// Build payment requirements with schema
					console.log(`[x402-access] Building payment requirements for tier: ${planId}`);
					const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
						planId,
						resourceId,
						opts.config,
						networkConfig,
						{
							inputSchema: {
								type: "object",
								properties: {
									planId: {
										type: "string",
										description: `Tier to purchase. Must be '${planId}'`,
									},
									requestId: {
										type: "string",
										description:
											"Client-generated UUID for idempotency (auto-generated if omitted)",
									},
									...(isPprPlan && isStandaloneForChallenge
										? {
												resource: {
													type: "object",
													description:
														"The backend resource to call after payment (required for per-request plans)",
													properties: {
														method: { type: "string" },
														path: { type: "string" },
														body: {
															description: "Optional request body forwarded to the backend",
														},
													},
													required: ["method", "path"],
												},
											}
										: {
												resourceId: {
													type: "string",
													description:
														"Optional: Specific resource identifier (defaults to 'default')",
												},
											}),
								},
								required:
									isPprPlan && isStandaloneForChallenge ? ["planId", "resource"] : ["planId"],
							},
							outputSchema: {
								type: "object",
								properties: {
									...(isPprPlan && isStandaloneForChallenge
										? {
												resource: {
													type: "object",
													description: "The backend resource response",
													properties: {
														status: { type: "number" },
														body: { description: "Response body from the backend" },
													},
												},
											}
										: {
												accessToken: { type: "string", description: "JWT token for API access" },
												tokenType: { type: "string", description: "Token type (usually 'Bearer')" },
												expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
												resourceEndpoint: {
													type: "string",
													description: "URL to access the protected resource",
												},
											}),
									txHash: { type: "string", description: "On-chain transaction hash" },
									explorerUrl: { type: "string", description: "Blockchain explorer URL" },
								},
							},
							description: `Access to ${resourceId} via ${planId} tier`,
						},
					);
					console.log(`[x402-access] Payment requirements:`, JSON.stringify(requirements, null, 2));

					// Encode as base64 for payment-required header
					const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
					res.setHeader("payment-required", encoded);

					// Add www-authenticate header
					const authHeader = `Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`;
					res.setHeader("www-authenticate", authHeader);

					console.log(`[x402-access] payment-required header set (${encoded.length} bytes)`);
					console.log(`[x402-access] www-authenticate header set`);
					console.log("[x402-access] → Returning HTTP 402 Payment Required (Challenge)");

					return res.status(402).json({
						...requirements,
						challengeId,
						requestId,
						error: "Payment required",
					});
				}

				// ===== CASE 3: planId + PAYMENT-SIGNATURE → Settle and return access grant or resource =====
				console.log("[x402-access] → CASE 3: Processing payment");
				console.log(
					`[x402-access] PAYMENT-SIGNATURE header received (${paymentSignature.length} bytes)`,
				);

				// Pre-settlement check: avoid burning USDC if already delivered/expired/cancelled
				console.log("[x402-access] Pre-settlement check for requestId:", requestId);
				const existingGrant = await engine.preSettlementCheck(requestId);
				if (existingGrant) {
					console.log("[x402-access] ✓ Already delivered, returning cached grant");
					return res.status(200).json(existingGrant);
				}

				// Decode header then settle via shared settlement layer
				console.log("[x402-access] Decoding payment signature...");
				const paymentPayload = decodePaymentSignature(paymentSignature);
				console.log(
					"[x402-access] Payment payload decoded:",
					JSON.stringify(paymentPayload, null, 2),
				);

				console.log("[x402-access] Settling payment on-chain...");
				const { txHash, settleResponse, payer } = await settlePayment(
					paymentPayload,
					opts.config,
					networkConfig,
				);

				console.log(`[x402-access] ✓ Payment settled successfully`);
				console.log(`[x402-access]   - Transaction Hash: ${txHash}`);
				console.log(`[x402-access]   - Payer: ${payer}`);
				console.log(`[x402-access]   - Settle Response:`, JSON.stringify(settleResponse, null, 2));

				// Set payment-response header
				const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
				res.setHeader("payment-response", paymentResponse);

				// Determine plan mode and deployment mode
				const plan = opts.config.plans.find((p) => p.planId === planId);
				const fetchResourceFn = resolveConfigFetchResource(opts.config);

				if (plan?.mode === "per-request") {
					if (!fetchResourceFn) {
						// Embedded mode: per-request plans must be accessed via their route endpoints
						const routePath = plan.routes?.[0]?.path ?? "/";
						return res.status(400).json({
							error: "PER_REQUEST_EMBEDDED_MODE",
							message:
								"Per-request plans must be accessed via their route endpoints directly. " +
								`Use ${plan.routes?.[0]?.method ?? "GET"} ${routePath} with PAYMENT-SIGNATURE header.`,
						});
					}

					// Standalone mode: validate resource field
					if (!resource?.method || !resource?.path) {
						return res.status(400).json({
							error: "MISSING_RESOURCE_FIELD",
							message:
								'Per-request plans require a "resource" field in the request body: ' +
								'{ method: "GET", path: "/api/example" }',
						});
					}

					// Record payment (PENDING → PAID) without issuing a token
					console.log(
						`[x402-access] Per-request plan: recording payment for requestId: ${requestId}`,
					);
					const { challengeId, explorerUrl } = await engine.recordPerRequestPayment(
						requestId,
						planId,
						resource.path,
						txHash,
						payer as `0x${string}` | undefined,
					);

					// Build request headers to forward (strip hop-by-hop and body-related
					// headers when the proxied method carries no body — forwarding Content-Length
					// from the incoming POST to a GET causes the backend to hang waiting for a
					// body that never arrives).
					const noBodyMethod =
						resource.method.toUpperCase() === "GET" || resource.method.toUpperCase() === "HEAD";
					const skipHeaders = new Set([
						"host",
						"connection",
						"payment-signature",
						"transfer-encoding",
						...(noBodyMethod ? ["content-length", "content-type"] : []),
					]);
					const forwardHeaders: Record<string, string> = {};
					for (const [key, value] of Object.entries(req.headers)) {
						if (value && !skipHeaders.has(key.toLowerCase())) {
							forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
						}
					}

					// Proxy to backend
					console.log(`[x402-access] Proxying to backend: ${resource.method} ${resource.path}`);
					const backendResult = await fetchResourceFn({
						paymentInfo: {
							txHash,
							payer: payer ?? undefined,
							planId,
							amount: plan.unitAmount!,
							method: resource.method,
							path: resource.path,
							challengeId,
						},
						method: resource.method,
						path: resource.path,
						headers: forwardHeaders,
						body: resource.body,
					});
					console.log(`[x402-access] Backend responded with status ${backendResult.status}`);

					// Mark delivered if backend returned 2xx
					if (backendResult.status >= 200 && backendResult.status < 300) {
						await engine.markDelivered(challengeId);
					} else {
						console.warn(
							`[x402-access] Backend returned ${backendResult.status} — challenge stays PAID (refund cron eligible)`,
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

					console.log("[x402-access] → Returning HTTP 200 OK with ResourceResponse");
					return res.status(200).json(resourceResponse);
				}

				// Subscription plan: process payment with full lifecycle tracking (PENDING → PAID → DELIVERED)
				console.log(`[x402-access] Processing subscription payment for requestId: ${requestId}`);
				const grant = await engine.processHttpPayment(
					requestId,
					planId,
					resourceId,
					txHash,
					payer as `0x${string}` | undefined,
				);
				console.log("[x402-access] ✓ Access grant issued successfully");
				console.log("[x402-access] Grant details:", JSON.stringify(grant, null, 2));

				console.log(`[x402-access] payment-response header set (${paymentResponse.length} bytes)`);
				console.log("[x402-access] → Returning HTTP 200 OK with access grant");
				return res.status(200).json(grant);
			} catch (err: unknown) {
				const elapsed = Date.now() - startTime;
				console.error(`[x402-access] ✗ Error occurred after ${elapsed}ms`);
				console.error("[x402-access] Error type:", err?.constructor?.name || typeof err);
				console.error("[x402-access] Error details:", err);

				if (err instanceof Error) {
					console.error("[x402-access] Error message:", err.message);
					console.error("[x402-access] Error stack:", err.stack);
				}

				if (err instanceof Key0Error) {
					console.error(`[x402-access] Key0 error: ${err.code} (HTTP ${err.httpStatus})`);
					// Return the grant directly for PROOF_ALREADY_REDEEMED (status 200)
					if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
						return res.status(200).json(err.details["grant"]);
					}
					return res.status(err.httpStatus).json(err.toJSON());
				}

				console.error("[x402-access] Returning 500 Internal Server Error");
				return res.status(500).json({
					error: "INTERNAL_ERROR",
					message: err instanceof Error ? err.message : "Internal server error",
				});
			} finally {
				const elapsed = Date.now() - startTime;
				console.log(`[x402-access] Request completed in ${elapsed}ms`);
				console.log("[x402-access] ========== REQUEST COMPLETE ==========\n");
			}
		},
		// A2A JSON-RPC fallback: reached when X-A2A-Extensions header is present
		jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);

	router.get("/discovery", (_req: Request, res: Response) => {
		const mergedRoutes = mergePerRequestRoutes(opts.config.plans, pprRouteRegistry);
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig, mergedRoutes);
		return res.status(200).json({ discoveryResponse });
	});

	// MCP routes (when mcp: true)
	if (opts.config.mcp) {
		mountMcpRoutes(router, engine, opts.config, pprRouteRegistry);
	}

	return router;
}

/**
 * Express middleware to validate access tokens.
 *
 * Usage:
 *   app.use("/api/photos", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET }));
 */
export function validateAccessToken(config: ValidateAccessTokenConfig) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const payload = await validateToken(req.headers.authorization, config);
			// Attach decoded token to request for downstream handlers
			(req as Request & { key0Token?: unknown }).key0Token = payload;
			next();
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				res.status(err.httpStatus).json(err.toJSON());
			} else {
				res.status(500).json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
			}
		}
	};
}

export type {
	FetchResourceParams,
	FetchResourceResult,
	PaymentInfo,
	PayPerRequestConfig,
	PayPerRequestOptions,
	ProxyToConfig,
} from "./pay-per-request.js";
export { key0PayPerRequest } from "./pay-per-request.js";
export type { ValidateAccessTokenConfig };
