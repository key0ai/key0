import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChallengeEngine } from "../core/index.js";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type {
	AgentCard,
	NetworkConfig,
	PlanRouteInfo,
	ResourceResponse,
	X402PaymentRequiredResponse,
} from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { interpolateUrlTemplate } from "../utils/url-template.js";
import type { PayPerRequestOptions } from "./pay-per-request.js";
import {
	createFastifyPayPerRequest,
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

type FastifyPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Result returned by `createKey0Fastify`.
 *
 * @example
 * ```ts
 * const key0 = createKey0Fastify({ config, adapter, store, seenTxStore });
 * fastify.register(key0.plugin);
 *
 * fastify.get("/api/weather/:city",
 *   { preHandler: key0.payPerRequest("weather-query") },
 *   async (request, reply) => reply.send({ temp: 72 }),
 * );
 * ```
 */
export type Key0Fastify = {
	/** Register as Fastify plugin: `fastify.register(key0.plugin)` */
	readonly plugin: (fastify: FastifyInstance) => Promise<void>;
	/**
	 * Create a per-request payment preHandler for the given plan.
	 *
	 * @param planId - Which plan from `config.plans` to charge per request
	 * @param options - Optional callbacks (e.g. `onPayment`)
	 */
	readonly payPerRequest: (planId: string, options?: PayPerRequestOptions) => FastifyPreHandler;
};

/**
 * Create a Key0 Fastify bundle with both the plugin and a `payPerRequest` factory
 * that shares config, stores, and settlement logic.
 *
 * @example
 * ```ts
 * const key0 = createKey0Fastify({ config, adapter, store, seenTxStore });
 * fastify.register(key0.plugin);
 *
 * fastify.get("/api/weather/:city",
 *   { preHandler: key0.payPerRequest("weather-query") },
 *   async (request, reply) => reply.send({ temp: 72 }),
 * );
 * ```
 */
export function createKey0Fastify(opts: Key0Config): Key0Fastify {
	const { engine, agentCard } = createKey0(opts);
	const networkConfig = opts.config.rpcUrl
		? { ...CHAIN_CONFIGS[opts.config.network], rpcUrl: opts.config.rpcUrl }
		: CHAIN_CONFIGS[opts.config.network];

	const pprDeps = {
		config: opts.config,
		networkConfig,
		seenTxStore: opts.seenTxStore,
		store: opts.store,
	} as const;

	// Runtime route registry: populated when .payPerRequest() is called with options.route.
	const pprRouteRegistry = new Map<string, PlanRouteInfo[]>();

	return {
		plugin: async (fastify: FastifyInstance) => {
			mountFastifyRoutes(fastify, engine, agentCard, opts, networkConfig, pprRouteRegistry);
		},
		payPerRequest: (planId: string, options?: PayPerRequestOptions) => {
			if (options?.route) {
				const existing = pprRouteRegistry.get(planId) ?? [];
				existing.push(options.route);
				pprRouteRegistry.set(planId, existing);
			}
			return createFastifyPayPerRequest(planId, pprDeps, options) as FastifyPreHandler;
		},
	};
}

// ---------------------------------------------------------------------------
// Internal: shared route mounting
// ---------------------------------------------------------------------------

function mountFastifyRoutes(
	fastify: FastifyInstance,
	engine: ChallengeEngine,
	agentCard: AgentCard,
	opts: Key0Config,
	networkConfig: NetworkConfig,
	pprRouteRegistry: Map<string, PlanRouteInfo[]> = new Map(),
) {
	// Agent Card
	fastify.get(`/${AGENT_CARD_PATH}`, async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});
	fastify.get("/.well-known/agent.json", async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});

	// Unified x402 endpoint
	fastify.post("/x402/access", async (request: FastifyRequest, reply: FastifyReply) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access/fastify] ========== NEW REQUEST ==========");

			const body = (request.body as Record<string, unknown>) || {};
			let planId = body["planId"] as string | undefined;
			let requestId = body["requestId"] as string | undefined;
			const resourceId = (body["resourceId"] as string) || "default";
			const resource = body["resource"] as
				| { method: string; path: string; body?: unknown }
				| undefined;

			const paymentSignature = request.headers["payment-signature"] as string | undefined;

			// Extract planId from PAYMENT-SIGNATURE if not in body
			if (!planId && paymentSignature) {
				try {
					const decoded = decodePaymentSignature(paymentSignature);
					const sigPlanId = decoded.accepted?.extra?.["planId"] as string | undefined;
					if (sigPlanId) {
						console.log(
							`[x402-access/fastify] Extracted planId="${sigPlanId}" from PAYMENT-SIGNATURE`,
						);
						planId = sigPlanId;
					}
				} catch {
					// Fall through to discovery
				}
			}

			// CASE 1: No planId → 400 pointing to GET /discovery
			if (!planId) {
				return reply.code(400).send({
					error:
						"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discovery",
				});
			}

			// Auto-generate requestId
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
			}

			// FREE PLAN FAST-PATH: proxy immediately without payment
			const planDef = opts.config.plans.find((p) => p.planId === planId);
			if (planDef?.free === true) {
				const fetchResourceFn = resolveConfigFetchResource(opts.config);
				if (!fetchResourceFn || !planDef.proxyPath) {
					return reply.code(400).send({
						error: "FREE_PLAN_MISCONFIGURED",
						message: "Free plan requires proxyTo and proxyPath to be configured.",
					});
				}
				const rawParams = (body["params"] as Record<string, string> | undefined) ?? {};
				let resolvedPath: string;
				try {
					resolvedPath = interpolateUrlTemplate(planDef.proxyPath, rawParams);
				} catch (err) {
					return reply.code(400).send({
						error: "TEMPLATE_ERROR",
						message: (err as Error).message,
					});
				}
				const queryString = planDef.proxyQuery
					? `?${new URLSearchParams(planDef.proxyQuery as Record<string, string>).toString()}`
					: "";
				const proxyResult = await fetchResourceFn({
					method: planDef.proxyMethod ?? "GET",
					path: resolvedPath + queryString,
					headers: {},
					paymentInfo: {
						txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
						payer: undefined,
						planId,
						amount: "$0",
						method: planDef.proxyMethod ?? "GET",
						path: resolvedPath,
						challengeId: "free",
					},
				});
				const freeResponse: ResourceResponse = {
					type: "ResourceResponse",
					challengeId: "free",
					requestId,
					planId,
					txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
					explorerUrl: "",
					resource: {
						status: proxyResult.status,
						...(proxyResult.headers !== undefined ? { headers: proxyResult.headers } : {}),
						body: proxyResult.body,
					},
				};
				return reply.code(200).send(freeResponse);
			}

			// CASE 2: planId, no PAYMENT-SIGNATURE → Challenge
			if (!paymentSignature) {
				console.log("[x402-access/fastify] → CASE 2: Challenge 402");

				// Validate: per-request plans in standalone mode require a resource field
				const planForValidation = opts.config.plans.find((p) => p.planId === planId);
				const isStandaloneMode = !!resolveConfigFetchResource(opts.config);
				if (planForValidation?.mode === "per-request" && isStandaloneMode && !resource) {
					return reply.code(400).send({
						type: "Error",
						code: "RESOURCE_REQUIRED",
						message:
							"Per-request plans in standalone mode require a 'resource' field (method + path).",
					});
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
				reply.header("payment-required", encoded);
				reply.header(
					"www-authenticate",
					`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`,
				);

				return reply
					.code(402)
					.send({ ...requirements, challengeId, requestId, error: "Payment required" });
			}

			// CASE 3: planId + PAYMENT-SIGNATURE → Settle
			console.log("[x402-access/fastify] → CASE 3: Settlement");

			const existingGrant = await engine.preSettlementCheck(requestId);
			if (existingGrant) {
				return reply.code(200).send(existingGrant);
			}

			const paymentPayload = decodePaymentSignature(paymentSignature);
			const { txHash, settleResponse, payer } = await settlePayment(
				paymentPayload,
				opts.config,
				networkConfig,
			);

			const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
			reply.header("payment-response", paymentResponse);

			// Determine plan mode and deployment mode
			const plan = opts.config.plans.find((p) => p.planId === planId);
			const fetchResourceFn = resolveConfigFetchResource(opts.config);

			if (plan?.mode === "per-request") {
				if (!fetchResourceFn) {
					return reply.code(400).send({
						error: "PER_REQUEST_EMBEDDED_MODE",
						message:
							"Per-request plans must be accessed via their route endpoints directly. " +
							`Use ${plan.routes?.[0]?.method ?? "GET"} ${plan.routes?.[0]?.path ?? "/"} with PAYMENT-SIGNATURE header.`,
					});
				}

				if (!resource?.method || !resource?.path) {
					return reply.code(400).send({
						error: "MISSING_RESOURCE_FIELD",
						message:
							'Per-request plans require a "resource" field in the request body: ' +
							'{ method: "GET", path: "/api/example" }',
					});
				}

				console.log(
					`[x402-access/fastify] Per-request plan: recording payment for requestId: ${requestId}`,
				);
				const { challengeId, explorerUrl } = await engine.recordPerRequestPayment(
					requestId,
					planId,
					resource.path,
					txHash,
					payer as `0x${string}` | undefined,
				);

				const noBodyMethodFastify =
					resource.method.toUpperCase() === "GET" || resource.method.toUpperCase() === "HEAD";
				const skipHeadersFastify = new Set([
					"host",
					"connection",
					"payment-signature",
					"transfer-encoding",
					...(noBodyMethodFastify ? ["content-length", "content-type"] : []),
				]);
				const forwardHeaders: Record<string, string> = {};
				for (const [key, val] of Object.entries(request.headers)) {
					if (val && !skipHeadersFastify.has(key.toLowerCase())) {
						forwardHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
					}
				}

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
				console.log(`[x402-access/fastify] Backend responded with status ${backendResult.status}`);

				if (backendResult.status >= 200 && backendResult.status < 300) {
					await engine.markDelivered(challengeId);
				} else {
					console.warn(
						`[x402-access/fastify] Backend returned ${backendResult.status} — challenge stays PAID (refund cron eligible)`,
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

				return reply.code(200).send(resourceResponse);
			}

			// Subscription plan: process payment with full lifecycle tracking
			const grant = await engine.processHttpPayment(
				requestId,
				planId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);

			return reply.code(200).send(grant);
		} catch (err: unknown) {
			const elapsed = Date.now() - startTime;
			console.error(`[x402-access/fastify] Error after ${elapsed}ms:`, err);

			if (err instanceof Key0Error) {
				if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
					return reply.code(200).send(err.details["grant"]);
				}
				return reply.code(err.httpStatus).send(err.toJSON());
			}

			return reply.code(500).send({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			console.log(`[x402-access/fastify] Request completed in ${Date.now() - startTime}ms`);
		}
	});

	fastify.get("/discovery", async (_request: FastifyRequest, reply: FastifyReply) => {
		const mergedRoutes = mergePerRequestRoutes(opts.config.plans, pprRouteRegistry);
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig, mergedRoutes);
		return reply.send({ discoveryResponse });
	});
}

// ---------------------------------------------------------------------------
// Legacy plugin API (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Fastify plugin that serves the agent card and the unified x402 endpoint.
 *
 * For per-request payment gating, prefer `createKey0Fastify` which bundles
 * the plugin with a shared `.payPerRequest()` factory.
 *
 * Usage:
 *   fastify.register(key0Plugin, { config, adapter, store, seenTxStore });
 */
export async function key0Plugin(fastify: FastifyInstance, opts: Key0Config): Promise<void> {
	const { engine, agentCard } = createKey0(opts);
	const networkConfig = CHAIN_CONFIGS[opts.config.network];
	mountFastifyRoutes(fastify, engine, agentCard, opts, networkConfig);
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
 * Fastify onRequest hook to validate access tokens.
 */
export { fastifyPayPerRequest } from "./pay-per-request.js";

export function fastifyValidateAccessToken(config: ValidateAccessTokenConfig) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		try {
			const payload = await validateToken(request.headers.authorization, config);
			(request as FastifyRequest & { key0Token?: unknown }).key0Token = payload;
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return reply.status(err.httpStatus).send(err.toJSON());
			}
			return reply
				.status(500)
				.send({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
		}
	};
}
