import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { Hono } from "hono";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type {
	PlanRouteInfo,
	ResourceResponse,
	X402PaymentRequiredResponse,
} from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import type { PayPerRequestOptions } from "./pay-per-request.js";
import {
	createHonoPayPerRequest,
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

type HonoMiddleware = (
	c: {
		req: {
			method: string;
			path: string;
			url: string;
			header: (name: string) => string | undefined;
		};
		header: (name: string, value: string) => void;
		json: (data: unknown, status?: number) => Response;
		set: (key: string, value: unknown) => void;
		status: (code: number) => void;
		res: { status: number };
	},
	next: () => Promise<void>,
) => Response | Promise<Response | undefined> | undefined;

/**
 * Extended Hono app returned by `key0App`.
 *
 * Can be used exactly like a plain Hono app (`mainApp.route("/", key0)`),
 * but also exposes a `.payPerRequest()` factory that shares config, stores,
 * and settlement logic with the app.
 *
 * @example
 * ```ts
 * const key0 = key0App({ config, adapter, store, seenTxStore });
 * mainApp.route("/", key0);
 *
 * mainApp.get("/api/weather/:city",
 *   key0.payPerRequest("weather-query"),
 *   (c) => c.json({ temp: 72 }),
 * );
 * ```
 */
export type Key0HonoApp = Hono & {
	/**
	 * Create a per-request payment middleware for the given plan.
	 *
	 * @param planId - Which plan from `config.plans` to charge per request
	 * @param options - Optional callbacks (e.g. `onPayment`)
	 */
	payPerRequest: (planId: string, options?: PayPerRequestOptions) => HonoMiddleware;
};

/**
 * Create a Hono app that serves the agent card, the unified x402 endpoint,
 * and exposes a `.payPerRequest()` factory for per-request payment gating.
 *
 * Usage:
 *   const key0 = key0App(opts);
 *   mainApp.route("/", key0);
 *
 *   // Gate individual routes with per-request payment
 *   mainApp.get("/api/weather/:city", key0.payPerRequest("weather-query"), handler);
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json  — A2A agent card (discovery)
 *   POST /x402/access             — unified x402 HTTP endpoint
 */
export function key0App(opts: Key0Config): Key0HonoApp {
	const { engine, agentCard } = createKey0(opts);
	const app = new Hono() as Key0HonoApp;
	const networkConfig = opts.config.rpcUrl
		? { ...CHAIN_CONFIGS[opts.config.network], rpcUrl: opts.config.rpcUrl }
		: CHAIN_CONFIGS[opts.config.network];

	// ── Pay-per-request factory ──────────────────────────────────────────
	const pprDeps = {
		config: opts.config,
		networkConfig,
		seenTxStore: opts.seenTxStore,
		store: opts.store,
	} as const;

	// Runtime route registry: populated when .payPerRequest() is called with options.route.
	const pprRouteRegistry = new Map<string, PlanRouteInfo[]>();

	app.payPerRequest = (planId: string, options?: PayPerRequestOptions) => {
		if (options?.route) {
			const existing = pprRouteRegistry.get(planId) ?? [];
			existing.push(options.route);
			pprRouteRegistry.set(planId, existing);
		}
		return createHonoPayPerRequest(planId, pprDeps, options) as HonoMiddleware;
	};

	// Agent Card
	app.get(`/${AGENT_CARD_PATH}`, (c) => c.json(agentCard));
	app.get("/.well-known/agent.json", (c) => c.json(agentCard));

	// Unified x402 endpoint
	app.post("/x402/access", async (c) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access/hono] ========== NEW REQUEST ==========");

			const body = await c.req.json().catch(() => ({}));
			let { planId, resourceId = "default" } = body as {
				planId?: string;
				resourceId?: string;
			};
			let { requestId } = body as { requestId?: string };
			const resource = (body as { resource?: { method: string; path: string; body?: unknown } })
				.resource;

			const paymentSignature = c.req.header("payment-signature");

			// Extract planId from PAYMENT-SIGNATURE if not in body
			if (!planId && paymentSignature) {
				try {
					const decoded = decodePaymentSignature(paymentSignature);
					const sigPlanId = decoded.accepted?.extra?.["planId"] as string | undefined;
					if (sigPlanId) {
						console.log(
							`[x402-access/hono] Extracted planId="${sigPlanId}" from PAYMENT-SIGNATURE`,
						);
						planId = sigPlanId;
					}
				} catch {
					// Fall through to discovery
				}
			}

			// CASE 1: No planId → 400 pointing to GET /discovery
			if (!planId) {
				return c.json(
					{
						error:
							"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discovery",
					},
					400,
				);
			}

			// Auto-generate requestId
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
			}

			// CASE 2: planId, no PAYMENT-SIGNATURE → Challenge
			if (!paymentSignature) {
				console.log("[x402-access/hono] → CASE 2: Challenge 402");

				// Validate: per-request plans in standalone mode require a resource field
				const planForValidation = opts.config.plans.find((p) => p.planId === planId);
				const isStandaloneMode = !!resolveConfigFetchResource(opts.config);
				if (planForValidation?.mode === "per-request" && isStandaloneMode && !resource) {
					return c.json(
						{
							type: "Error",
							code: "RESOURCE_REQUIRED",
							message:
								"Per-request plans in standalone mode require a 'resource' field (method + path).",
						},
						400,
					);
				}

				const { challengeId } = await engine.requestHttpAccess(requestId, planId, resourceId);

				const planForChallenge = opts.config.plans.find((p) => p.planId === planId);
				const isPprPlan = planForChallenge?.mode === "per-request";
				const isStandaloneForChallenge = !!resolveConfigFetchResource(opts.config);

				const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
					planId,
					resourceId,
					opts.config,
					networkConfig,
					{
						inputSchema: {
							type: "object",
							properties: {
								planId: { type: "string", description: `Tier to purchase. Must be '${planId}'` },
								requestId: { type: "string", description: "Client-generated UUID for idempotency" },
								...(isPprPlan && isStandaloneForChallenge
									? {
											resource: {
												type: "object",
												description:
													"The backend resource to call after payment (required for per-request plans)",
												properties: {
													method: { type: "string" },
													path: { type: "string" },
													body: { description: "Optional request body forwarded to the backend" },
												},
												required: ["method", "path"],
											},
										}
									: {
											resourceId: { type: "string", description: "Optional resource identifier" },
										}),
							},
							required: isPprPlan && isStandaloneForChallenge ? ["planId", "resource"] : ["planId"],
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

				const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
				c.header("payment-required", encoded);
				c.header(
					"www-authenticate",
					`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`,
				);

				return c.json({ ...requirements, challengeId, requestId, error: "Payment required" }, 402);
			}

			// CASE 3: planId + PAYMENT-SIGNATURE → Settle
			console.log("[x402-access/hono] → CASE 3: Settlement");

			const existingGrant = await engine.preSettlementCheck(requestId);
			if (existingGrant) {
				return c.json(existingGrant, 200);
			}

			const paymentPayload = decodePaymentSignature(paymentSignature);
			const { txHash, settleResponse, payer } = await settlePayment(
				paymentPayload,
				opts.config,
				networkConfig,
			);

			const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
			c.header("payment-response", paymentResponse);

			// Determine plan mode and deployment mode
			const plan = opts.config.plans.find((p) => p.planId === planId);
			const fetchResourceFn = resolveConfigFetchResource(opts.config);

			if (plan?.mode === "per-request") {
				if (!fetchResourceFn) {
					return c.json(
						{
							error: "PER_REQUEST_EMBEDDED_MODE",
							message:
								"Per-request plans must be accessed via their route endpoints directly. " +
								`Use ${plan.routes?.[0]?.method ?? "GET"} ${plan.routes?.[0]?.path ?? "/"} with PAYMENT-SIGNATURE header.`,
						},
						400,
					);
				}

				if (!resource?.method || !resource?.path) {
					return c.json(
						{
							error: "MISSING_RESOURCE_FIELD",
							message:
								'Per-request plans require a "resource" field in the request body: ' +
								'{ method: "GET", path: "/api/example" }',
						},
						400,
					);
				}

				console.log(
					`[x402-access/hono] Per-request plan: recording payment for requestId: ${requestId}`,
				);
				const { challengeId, explorerUrl } = await engine.recordPerRequestPayment(
					requestId,
					planId,
					resource.path,
					txHash,
					payer as `0x${string}` | undefined,
				);

				const noBodyMethodHono =
					resource.method.toUpperCase() === "GET" || resource.method.toUpperCase() === "HEAD";
				const skipHeadersHono = new Set([
					"host",
					"connection",
					"payment-signature",
					"transfer-encoding",
					...(noBodyMethodHono ? ["content-length", "content-type"] : []),
				]);
				const forwardHeaders: Record<string, string> = {};
				for (const [key, val] of Object.entries(
					c.req.raw?.headers ? Object.fromEntries(c.req.raw.headers.entries()) : {},
				)) {
					if (!skipHeadersHono.has(key.toLowerCase())) {
						forwardHeaders[key] = val;
					}
				}

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
					headers: forwardHeaders,
					body: resource.body,
				});
				console.log(`[x402-access/hono] Backend responded with status ${backendResult.status}`);

				if (backendResult.status >= 200 && backendResult.status < 300) {
					await engine.markDelivered(challengeId);
				} else {
					console.warn(
						`[x402-access/hono] Backend returned ${backendResult.status} — challenge stays PAID (refund cron eligible)`,
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

				return c.json(resourceResponse, 200);
			}

			// Subscription plan: process payment with full lifecycle tracking
			const grant = await engine.processHttpPayment(
				requestId,
				planId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);

			return c.json(grant, 200);
		} catch (err: unknown) {
			const elapsed = Date.now() - startTime;
			console.error(`[x402-access/hono] Error after ${elapsed}ms:`, err);

			if (err instanceof Key0Error) {
				if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
					return c.json(err.details["grant"], 200);
				}
				return c.json(err.toJSON(), err.httpStatus as any);
			}

			return c.json(
				{
					error: "INTERNAL_ERROR",
					message: err instanceof Error ? err.message : "Internal server error",
				},
				500,
			);
		} finally {
			console.log(`[x402-access/hono] Request completed in ${Date.now() - startTime}ms`);
		}
	});

	app.get("/discovery", (c) => {
		const mergedRoutes = mergePerRequestRoutes(opts.config.plans, pprRouteRegistry);
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig, mergedRoutes);
		return c.json({ discoveryResponse });
	});

	return app;
}

export type {
	FetchResourceParams,
	FetchResourceResult,
	PaymentInfo,
	PayPerRequestConfig,
	PayPerRequestOptions,
	ProxyToConfig,
} from "./pay-per-request.js";
/**
 * Hono middleware to validate access tokens.
 */
export { honoPayPerRequest } from "./pay-per-request.js";

export function honoValidateAccessToken(config: ValidateAccessTokenConfig) {
	return async (
		c: {
			req: { header: (name: string) => string | undefined };
			set: (key: string, value: unknown) => void;
			json: (data: unknown, status: number) => Response;
		},
		next: () => Promise<void>,
	) => {
		try {
			const payload = await validateToken(c.req.header("authorization"), config);
			c.set("key0Token", payload);
			await next();
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return c.json(err.toJSON(), err.httpStatus);
			}
			return c.json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" }, 500);
		}
	};
}
