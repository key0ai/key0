import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type { ChallengeEngine } from "../core/index.js";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type {
	AgentCard,
	NetworkConfig,
	ResourceResponse,
	X402PaymentRequiredResponse,
} from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { interpolateUrlTemplate } from "../utils/url-template.js";
import type { PayPerRequestOptions } from "./pay-per-request.js";
import { createFastifyPayPerRequest, resolveConfigFetchResource } from "./pay-per-request.js";
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
	 * @param routeId - Which route from `config.routes` to charge per request
	 * @param options - Optional callbacks (e.g. `onPayment`)
	 */
	readonly payPerRequest: (routeId: string, options?: PayPerRequestOptions) => FastifyPreHandler;
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

	return {
		plugin: async (fastify: FastifyInstance) => {
			mountFastifyRoutes(fastify, engine, agentCard, opts, networkConfig);
		},
		payPerRequest: (routeId: string, options?: PayPerRequestOptions) => {
			return createFastifyPayPerRequest(routeId, pprDeps, options) as FastifyPreHandler;
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
) {
	const a2aEnabled = opts.config.a2a !== false;
	const pprDeps = {
		config: opts.config,
		networkConfig,
		seenTxStore: opts.seenTxStore,
		store: opts.store,
	} as const;

	// Agent Card
	if (a2aEnabled) {
		fastify.get(`/${AGENT_CARD_PATH}`, async (_request: FastifyRequest, reply: FastifyReply) => {
			return reply.send(agentCard);
		});
		fastify.get(
			"/.well-known/agent.json",
			async (_request: FastifyRequest, reply: FastifyReply) => {
				return reply.send(agentCard);
			},
		);
	}

	// Unified x402 endpoint
	fastify.post("/x402/access", async (request: FastifyRequest, reply: FastifyReply) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access/fastify] ========== NEW REQUEST ==========");

			const body = (request.body as Record<string, unknown>) || {};
			let planId = body["planId"] as string | undefined;
			let requestId = body["requestId"] as string | undefined;
			const resourceId = (body["resourceId"] as string) || "default";
			const _resource = body["resource"] as
				| { method: string; path: string; body?: unknown }
				| undefined;
			const routeId = body["routeId"] as string | undefined;

			const paymentSignature = request.headers["payment-signature"] as string | undefined;

			// ===== routeId: mutual exclusion with planId =====
			if (planId && routeId) {
				return reply.status(400).send({ error: "Provide either planId or routeId, not both" });
			}

			// ===== routeId path: full standalone gateway flow =====
			if (routeId !== undefined) {
				const route = (opts.config.routes ?? []).find((r) => r.routeId === routeId);
				if (!route) {
					return reply.status(404).send({
						type: "Error",
						code: "ROUTE_NOT_FOUND",
						error: `Route "${routeId}" not found`,
					});
				}

				const routePaymentSig = request.headers["payment-signature"] as string | undefined;
				const fetchResourceFn = resolveConfigFetchResource(opts.config);

				if (fetchResourceFn && !_resource) {
					return reply.status(400).send({
						type: "Error",
						code: "RESOURCE_REQUIRED",
						message: "Routes in standalone mode require a 'resource' field (method + path).",
					});
				}

				if (!requestId) requestId = `http-${crypto.randomUUID()}`;

				if (!routePaymentSig) {
					// CASE routeId-2: No payment → create PENDING challenge, return 402
					const existingByRequest = await opts.store.findActiveByRequestId(requestId);
					let finalChallengeId: string;
					if (existingByRequest?.state === "PENDING") {
						finalChallengeId = existingByRequest.challengeId;
					} else {
						finalChallengeId = `route-${crypto.randomUUID()}`;
						const now = new Date();
						const ttlMs = (opts.config.challengeTTLSeconds ?? 900) * 1000;
						await opts.store.create(
							{
								challengeId: finalChallengeId,
								requestId,
								clientAgentId: (body["clientAgentId"] as string | undefined) ?? "http",
								resourceId: _resource?.path ?? routeId,
								planId: routeId,
								amount: route.unitAmount ?? "$0",
								amountRaw: route.unitAmount ? parseDollarToUsdcMicro(route.unitAmount) : 0n,
								asset: "USDC",
								chainId: networkConfig.chainId,
								destination: opts.config.walletAddress,
								state: "PENDING",
								expiresAt: new Date(Date.now() + ttlMs),
								createdAt: now,
								updatedAt: now,
							},
							{ actor: "engine", reason: "route_access_requested" },
						);
					}

					const requirements = buildHttpPaymentRequirements(
						routeId,
						_resource?.path ?? routeId,
						opts.config,
						networkConfig,
						{ description: route.description ?? `Pay-per-request: ${routeId}` },
					);
					const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
					reply.header("payment-required", encoded);
					reply.header(
						"www-authenticate",
						`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${finalChallengeId}"`,
					);
					return reply.code(402).send({
						...requirements,
						challengeId: finalChallengeId,
						requestId,
						error: "Payment required",
					});
				}

				// CASE routeId-3: Payment present → settle + proxy
				if (!_resource?.method || !_resource?.path) {
					return reply.status(400).send({
						type: "Error",
						code: "MISSING_RESOURCE_FIELD",
						message: 'Route payment requires a "resource" field: { method, path }',
					});
				}

				const existingRecord = await opts.store.findActiveByRequestId(requestId);

				const routePayload = decodePaymentSignature(routePaymentSig);
				let routeTxHash: `0x${string}`;
				let routeSettleResponse: import("../types/index.js").X402SettleResponse;
				let routePayer: string | undefined;
				try {
					const settled = await settlePayment(routePayload, opts.config, networkConfig);
					routeTxHash = settled.txHash;
					routeSettleResponse = settled.settleResponse;
					routePayer = settled.payer;
				} catch (settleErr) {
					if (settleErr instanceof Key0Error) {
						return reply.status(settleErr.httpStatus ?? 402).send({
							type: "Error",
							code: settleErr.code,
							message: settleErr.message,
						});
					}
					return reply.status(503).send({
						type: "Error",
						code: "SETTLEMENT_FAILED",
						message: "Payment settlement failed. Please try again.",
					});
				}

				const settleB64 = Buffer.from(JSON.stringify(routeSettleResponse)).toString("base64");
				reply.header("payment-response", settleB64);

				const routeChallengeId = existingRecord?.challengeId ?? `route-${crypto.randomUUID()}`;

				// Double-spend guard
				const routeMarked = await opts.seenTxStore.markUsed(routeTxHash, routeChallengeId);
				if (!routeMarked) {
					return reply.status(409).send({
						type: "Error",
						code: "TX_ALREADY_REDEEMED",
						message: "This payment has already been used for a previous request",
					});
				}

				// Transition PENDING → PAID
				if (existingRecord?.state === "PENDING") {
					await opts.store.transition(
						routeChallengeId,
						"PENDING",
						"PAID",
						{
							txHash: routeTxHash,
							paidAt: new Date(),
							...(routePayer ? { fromAddress: routePayer as `0x${string}` } : {}),
						},
						{ actor: "engine", reason: "route_payment_settled" },
					);
				}

				if (!fetchResourceFn) {
					return reply.status(400).send({
						type: "Error",
						code: "EMBEDDED_MODE",
						message: "Routes in embedded mode must be accessed via their route path directly.",
					});
				}

				// Forward headers (strip hop-by-hop and body headers for no-body methods)
				const noBodyMethod =
					_resource.method.toUpperCase() === "GET" || _resource.method.toUpperCase() === "HEAD";
				const skipRouteHeaders = new Set([
					"host",
					"connection",
					"payment-signature",
					"transfer-encoding",
					...(noBodyMethod ? ["content-length", "content-type"] : []),
				]);
				const forwardHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(request.headers)) {
					if (value && !skipRouteHeaders.has(key.toLowerCase())) {
						forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
					}
				}

				// Proxy to backend
				let routeBackendResult: {
					status: number;
					headers?: Record<string, string>;
					body: unknown;
				};
				try {
					routeBackendResult = await fetchResourceFn({
						paymentInfo: {
							txHash: routeTxHash,
							payer: routePayer ?? undefined,
							planId: routeId,
							amount: route.unitAmount ?? "$0",
							method: _resource.method,
							path: _resource.path,
							challengeId: routeChallengeId,
						},
						method: _resource.method,
						path: _resource.path,
						headers: forwardHeaders,
						body: _resource.body,
					});
				} catch (err) {
					const isTimeout = err instanceof DOMException && err.name === "AbortError";
					return reply.status(502).send({
						type: "Error",
						code: isTimeout ? "PROXY_TIMEOUT" : "PROXY_ERROR",
						message: isTimeout ? "Backend timed out." : `Backend error: ${(err as Error).message}`,
						challengeId: routeChallengeId,
						txHash: routeTxHash,
					});
				}

				// Mark DELIVERED on 2xx; keep PAID on non-2xx (refund-eligible)
				if (routeBackendResult.status >= 200 && routeBackendResult.status < 300) {
					opts.store
						.transition(
							routeChallengeId,
							"PAID",
							"DELIVERED",
							{ deliveredAt: new Date() },
							{ actor: "engine", reason: "route_delivered" },
						)
						.catch(() => {});
				}

				const routeExplorerUrl = `${networkConfig.explorerBaseUrl}/tx/${routeTxHash}`;
				const routeResourceResponse: ResourceResponse = {
					type: "ResourceResponse",
					challengeId: routeChallengeId,
					requestId,
					routeId,
					txHash: routeTxHash,
					explorerUrl: routeExplorerUrl,
					resource: {
						status: routeBackendResult.status,
						...(routeBackendResult.headers !== undefined
							? { headers: routeBackendResult.headers }
							: {}),
						body: routeBackendResult.body,
					},
				};
				return reply.code(200).send(routeResourceResponse);
			}

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

			// CASE 1: No planId → 400 pointing to GET /discover
			if (!planId) {
				return reply.code(400).send({
					error:
						"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discover",
				});
			}

			// Auto-generate requestId
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
			}

			// FREE PLAN FAST-PATH: proxy immediately without payment
			const planDef = (opts.config.plans ?? []).find((p) => p.planId === planId);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const planDefAny = planDef as any;
			if (planDefAny?.free === true) {
				const fetchResourceFn = resolveConfigFetchResource(opts.config);
				if (!fetchResourceFn || !planDefAny.proxyPath) {
					return reply.code(400).send({
						error: "FREE_PLAN_MISCONFIGURED",
						message: "Free plan requires proxyTo and proxyPath to be configured.",
					});
				}
				const rawParams = (body["params"] as Record<string, string> | undefined) ?? {};
				let resolvedPath: string;
				try {
					resolvedPath = interpolateUrlTemplate(planDefAny.proxyPath, rawParams);
				} catch (err) {
					return reply.code(400).send({
						error: "TEMPLATE_ERROR",
						message: (err as Error).message,
					});
				}
				const queryString = planDefAny.proxyQuery
					? `?${new URLSearchParams(planDefAny.proxyQuery as Record<string, string>).toString()}`
					: "";
				const proxyResult = await fetchResourceFn({
					method: planDefAny.proxyMethod ?? "GET",
					path: resolvedPath + queryString,
					headers: {},
					paymentInfo: {
						txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
						payer: undefined,
						planId,
						amount: "$0",
						method: planDefAny.proxyMethod ?? "GET",
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

				const { challengeId } = await engine.requestHttpAccess(requestId, planId, resourceId);

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
								resourceId: { type: "string", description: "Optional resource identifier" },
							},
							required: ["planId"],
						},
						outputSchema: {
							type: "object",
							properties: {
								accessToken: { type: "string", description: "JWT token for API access" },
								tokenType: { type: "string", description: "Token type (usually 'Bearer')" },
								expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
								resourceEndpoint: {
									type: "string",
									description: "URL to access the protected resource",
								},
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

	fastify.get("/discover", async (_request: FastifyRequest, reply: FastifyReply) => {
		const discoveryResponse = buildDiscoveryResponse(opts.config);
		return reply.send(discoveryResponse);
	});

	// Auto-mount transparent proxy routes from config.routes
	for (const route of opts.config.routes ?? []) {
		const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fastify as any)[method](route.path, createFastifyPayPerRequest(route.routeId, pprDeps));
	}
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
