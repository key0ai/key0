import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { Hono } from "hono";
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type { ResourceResponse, X402PaymentRequiredResponse } from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { interpolateUrlTemplate } from "../utils/url-template.js";
import type { PayPerRequestOptions } from "./pay-per-request.js";
import { createHonoPayPerRequest, resolveConfigFetchResource } from "./pay-per-request.js";
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
	payPerRequest: (routeId: string, options?: PayPerRequestOptions) => HonoMiddleware;
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

	app.payPerRequest = (routeId: string, options?: PayPerRequestOptions) => {
		return createHonoPayPerRequest(routeId, pprDeps, options) as HonoMiddleware;
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
			const { routeId } = body as { routeId?: string };
			const _resource = (body as { resource?: { method: string; path: string; body?: unknown } })
				.resource;

			const paymentSignature = c.req.header("payment-signature");

			// ===== routeId: mutual exclusion with planId =====
			if (planId && routeId) {
				return c.json({ error: "Provide either planId or routeId, not both" }, 400);
			}

			// ===== routeId path: full standalone gateway flow =====
			if (routeId !== undefined) {
				const route = (opts.config.routes ?? []).find((r) => r.routeId === routeId);
				if (!route) {
					return c.json(
						{ type: "Error", code: "ROUTE_NOT_FOUND", error: `Route "${routeId}" not found` },
						404,
					);
				}

				const routePaymentSig = c.req.header("payment-signature");
				const fetchResourceFn = resolveConfigFetchResource(opts.config);

				if (fetchResourceFn && !_resource) {
					return c.json(
						{
							type: "Error",
							code: "RESOURCE_REQUIRED",
							message: "Routes in standalone mode require a 'resource' field (method + path).",
						},
						400,
					);
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
								clientAgentId: (body as { clientAgentId?: string }).clientAgentId ?? "http",
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
					c.header("payment-required", encoded);
					c.header(
						"www-authenticate",
						`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${finalChallengeId}"`,
					);
					return c.json(
						{
							...requirements,
							challengeId: finalChallengeId,
							requestId,
							error: "Payment required",
						},
						402,
					);
				}

				// CASE routeId-3: Payment present → settle + proxy
				if (!_resource?.method || !_resource?.path) {
					return c.json(
						{
							type: "Error",
							code: "MISSING_RESOURCE_FIELD",
							message: 'Route payment requires a "resource" field: { method, path }',
						},
						400,
					);
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
						return c.json(
							{ type: "Error", code: settleErr.code, message: settleErr.message },
							(settleErr.httpStatus ?? 402) as any,
						);
					}
					return c.json(
						{
							type: "Error",
							code: "SETTLEMENT_FAILED",
							message: "Payment settlement failed. Please try again.",
						},
						503,
					);
				}

				const settleB64 = Buffer.from(JSON.stringify(routeSettleResponse)).toString("base64");
				c.header("payment-response", settleB64);

				const routeChallengeId = existingRecord?.challengeId ?? `route-${crypto.randomUUID()}`;

				// Double-spend guard
				const routeMarked = await opts.seenTxStore.markUsed(routeTxHash, routeChallengeId);
				if (!routeMarked) {
					return c.json(
						{
							type: "Error",
							code: "TX_ALREADY_REDEEMED",
							message: "This payment has already been used for a previous request",
						},
						409,
					);
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
					return c.json(
						{
							type: "Error",
							code: "EMBEDDED_MODE",
							message: "Routes in embedded mode must be accessed via their route path directly.",
						},
						400,
					);
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
				c.req.raw.headers.forEach((value, key) => {
					if (!skipRouteHeaders.has(key.toLowerCase())) {
						forwardHeaders[key] = value;
					}
				});

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
					return c.json(
						{
							type: "Error",
							code: isTimeout ? "PROXY_TIMEOUT" : "PROXY_ERROR",
							message: isTimeout
								? "Backend timed out."
								: `Backend error: ${(err as Error).message}`,
							challengeId: routeChallengeId,
							txHash: routeTxHash,
						},
						502,
					);
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
				return c.json(routeResourceResponse, 200);
			}

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

			// CASE 1: No planId → 400 pointing to GET /discover
			if (!planId) {
				return c.json(
					{
						error:
							"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discover",
					},
					400,
				);
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
					return c.json(
						{
							error: "FREE_PLAN_MISCONFIGURED",
							message: "Free plan requires proxyTo and proxyPath to be configured.",
						},
						400,
					);
				}
				const rawParams = (body as { params?: Record<string, string> }).params ?? {};
				let resolvedPath: string;
				try {
					resolvedPath = interpolateUrlTemplate(planDefAny.proxyPath, rawParams);
				} catch (err) {
					return c.json(
						{
							error: "TEMPLATE_ERROR",
							message: (err as Error).message,
						},
						400,
					);
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
				return c.json(freeResponse, 200);
			}

			// CASE 2: planId, no PAYMENT-SIGNATURE → Challenge
			if (!paymentSignature) {
				console.log("[x402-access/hono] → CASE 2: Challenge 402");

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

	app.get("/discover", (c) => {
		const discoveryResponse = buildDiscoveryResponse(opts.config);
		return c.json(discoveryResponse);
	});

	// Auto-mount transparent proxy routes from config.routes
	for (const route of opts.config.routes ?? []) {
		const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(app as any)[method](route.path, createHonoPayPerRequest(route.routeId, pprDeps));
	}

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
