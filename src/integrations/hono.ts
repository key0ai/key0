import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { Hono } from "hono";
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

	app.payPerRequest = (planId: string, options?: PayPerRequestOptions) => {
		return createHonoPayPerRequest(planId, pprDeps, options) as HonoMiddleware;
	};

	// Agent Card
	app.get(`/${AGENT_CARD_PATH}`, (c) => c.json(agentCard));
	app.get("/.well-known/agent.json", (c) => c.json(agentCard));

	// Unified x402 endpoint
	app.post("/x402/access", async (c, next) => {
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

			// ===== routeId path: delegate to pay-per-request middleware =====
			if (routeId !== undefined) {
				const route = (opts.config.routes ?? []).find((r) => r.routeId === routeId);
				if (!route) {
					return c.json({ error: `Route "${routeId}" not found` }, 404);
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return createHonoPayPerRequest(routeId, pprDeps)(c as any, next);
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
