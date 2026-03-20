/**
 * Pay-per-request middleware for Express, Hono, and Fastify.
 *
 * Gates individual API routes behind a per-request USDC micro-payment using
 * the x402 protocol. Every call either includes a `PAYMENT-SIGNATURE` header
 * (and gets settled on-chain) or receives a 402 with payment requirements.
 *
 * ### Embedded mode
 * Key0 middleware runs inside the application that serves the API. After
 * payment settlement the middleware calls `next()` and the local route handler
 * serves the response. No `fetchResource`/`proxyTo` needed.
 *
 * @example
 * ```ts
 * const key0 = key0Router({ config, adapter, store, seenTxStore });
 * app.use(key0);
 *
 * app.get("/api/weather/:city",
 *   key0.payPerRequest("weather-query"),
 *   (req, res) => res.json({ temp: 72 }),
 * );
 * ```
 *
 * ### Standalone mode
 * Key0 runs as a separate payment gateway. After settlement it proxies the
 * request to a backend service and returns its response to the client.
 *
 * @example
 * ```ts
 * import { key0PayPerRequest } from "@key0ai/key0/express";
 *
 * // Using the proxyTo shorthand:
 * app.get("/api/weather/:city",
 *   key0PayPerRequest({
 *     routeId: "weather-query",
 *     config,
 *     seenTxStore,
 *     proxyTo: { baseUrl: "https://weather-api.internal" },
 *   }),
 * );
 *
 * // Or the full fetchResource callback:
 * app.get("/api/weather/:city",
 *   key0PayPerRequest({
 *     routeId: "weather-query",
 *     config,
 *     seenTxStore,
 *     fetchResource: async ({ method, path, headers, body, paymentInfo }) => {
 *       const res = await fetch(`https://weather-api.internal${path}`, { method });
 *       return { status: res.status, body: await res.json() };
 *     },
 *   }),
 * );
 * ```
 */

import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type {
	ChallengeRecord,
	FetchResourceParams,
	FetchResourceResult,
	IChallengeStore,
	ISeenTxStore,
	NetworkConfig,
	PaymentInfo,
	ProxyToConfig,
	Route,
	SellerConfig,
} from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";

import {
	buildHttpPaymentRequirements,
	decodePaymentSignature,
	settlePayment,
} from "./settlement.js";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------
// FetchResourceParams, FetchResourceResult, ProxyToConfig, PaymentInfo are
// defined in src/types/config.ts and re-exported from src/types/index.ts.
// Re-export them here for backward compatibility with existing imports.
export type { FetchResourceParams, FetchResourceResult, PaymentInfo, ProxyToConfig };

/**
 * Options for the integrated `payPerRequest` method returned by
 * key0Router / key0App / createKey0Fastify.
 */
export type PayPerRequestOptions = {
	/** Optional: called after successful settlement, before handler / proxy. */
	readonly onPayment?: (info: PaymentInfo) => void | Promise<void>;
	/**
	 * Declare the route this middleware is guarding for discovery.
	 * The framework integration also captures it automatically — supply this
	 * when you want to be explicit or override the default metadata.
	 */
	readonly route?: { method: string; path: string; description?: string };
	/** Standalone gateway: full control over how the backend is called. */
	readonly fetchResource?: (params: FetchResourceParams) => Promise<FetchResourceResult>;
	/** Standalone gateway: shorthand that builds a `fetchResource` for you. */
	readonly proxyTo?: ProxyToConfig;
};

/**
 * Configuration for the standalone pay-per-request middleware functions
 * (`key0PayPerRequest`, `honoPayPerRequest`, `fastifyPayPerRequest`).
 */
export type PayPerRequestConfig = {
	/** Which route from config.routes to charge per request */
	readonly routeId: string;
	/** Seller configuration (same config used in key0Router) */
	readonly config: SellerConfig;
	/** Double-spend protection (required) */
	readonly seenTxStore: ISeenTxStore;
	/**
	 * Optional: challenge store for audit trail + refund safety.
	 * When provided, each settled payment is recorded so the refund cron
	 * can refund the payer if the handler crashes after on-chain settlement.
	 */
	readonly store?: IChallengeStore;
	/** Optional: called after successful settlement, before handler / proxy. */
	readonly onPayment?: (info: PaymentInfo) => void | Promise<void>;
	/** Standalone gateway: full control over how the backend is called. */
	readonly fetchResource?: (params: FetchResourceParams) => Promise<FetchResourceResult>;
	/** Standalone gateway: shorthand that builds a `fetchResource` for you. */
	readonly proxyTo?: ProxyToConfig;
};

/**
 * @internal Shared dependencies from key0Router / key0App / key0Plugin.
 * Used by the internal factory functions; not part of the public API.
 */
export type PayPerRequestDeps = {
	readonly config: SellerConfig;
	readonly networkConfig: NetworkConfig;
	readonly seenTxStore: ISeenTxStore;
	readonly store?: IChallengeStore;
};

/**
 * @internal Resolved deps for the routes-based path (routeId + Route + proxyFetch).
 * Used by createExpressPayPerRequest, createHonoPayPerRequest, createFastifyPayPerRequest.
 */
type ResolvedRouteDeps = {
	readonly routeId: string;
	readonly config: SellerConfig;
	readonly networkConfig: NetworkConfig;
	readonly route: Route;
	readonly seenTxStore: ISeenTxStore;
	readonly store: IChallengeStore | undefined;
	readonly onPayment: ((info: PaymentInfo) => void | Promise<void>) | undefined;
	readonly fetchResource:
		| ((params: FetchResourceParams) => Promise<FetchResourceResult>)
		| undefined;
	readonly isDirectProxy: boolean;
};

function resolveRoute(routeId: string, config: SellerConfig): Route {
	const route = (config.routes ?? []).find((r) => r.routeId === routeId);
	if (!route) {
		throw new Key0Error("TIER_NOT_FOUND", `route "${routeId}" not found`, 404);
	}
	return route;
}

/**
 * Build a proxy fetchResource callback from a ProxyToConfig.
 * Unlike proxyToFetchResource, this does NOT require paymentInfo (for transparent proxy mode).
 */
function buildProxyFetchResource(
	proxyTo: ProxyToConfig,
): (params: FetchResourceParams) => Promise<FetchResourceResult> {
	return async ({ method, path, headers, body }) => {
		const url = `${proxyTo.baseUrl.replace(/\/$/, "")}${path}`;
		const upstreamHeaders: Record<string, string> = {
			...headers,
			...(proxyTo.headers ?? {}),
			...(proxyTo.proxySecret ? { "x-key0-internal-token": proxyTo.proxySecret } : {}),
		};
		// Drop hop-by-hop headers
		delete upstreamHeaders["host"];
		delete upstreamHeaders["connection"];
		delete upstreamHeaders["transfer-encoding"];

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30_000);
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers: upstreamHeaders,
				signal: controller.signal,
				...(body !== undefined && method !== "GET" && method !== "HEAD"
					? { body: typeof body === "string" ? body : JSON.stringify(body) }
					: {}),
			});
		} finally {
			clearTimeout(timeout);
		}

		const responseHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			responseHeaders[k] = v;
		});

		let responseBody: unknown;
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			responseBody = await res.json().catch(() => null);
		} else {
			responseBody = await res.text();
		}

		return { status: res.status, headers: responseHeaders, body: responseBody };
	};
}

function resolveFromRouterByRouteId(
	routeId: string,
	deps: PayPerRequestDeps,
	options?: PayPerRequestOptions,
): ResolvedRouteDeps {
	const route = resolveRoute(routeId, deps.config);
	const fetchResource =
		options?.fetchResource ??
		(options?.proxyTo
			? buildProxyFetchResource(options.proxyTo)
			: deps.config.proxyTo
				? buildProxyFetchResource(deps.config.proxyTo)
				: undefined);

	return {
		routeId,
		config: deps.config,
		networkConfig: deps.networkConfig,
		route,
		seenTxStore: deps.seenTxStore,
		store: deps.store,
		onPayment: options?.onPayment,
		fetchResource,
		isDirectProxy: fetchResource != null,
	};
}

/** Convert a ProxyToConfig into a fetchResource callback. */
function proxyToFetchResource(
	proxyConfig: ProxyToConfig,
): (params: FetchResourceParams) => Promise<FetchResourceResult> {
	return async ({ method, path, headers, body, paymentInfo }) => {
		const targetPath = proxyConfig.pathRewrite ? proxyConfig.pathRewrite(path) : path;
		const targetUrl = `${proxyConfig.baseUrl.replace(/\/$/, "")}${targetPath}`;

		// Merge caller headers with config headers and payment metadata.
		// Payment headers let the backend log/audit and verify the payment without a round-trip.
		const paymentHeaders: Record<string, string> = {
			"x-key0-tx-hash": paymentInfo.txHash,
			"x-key0-plan-id": paymentInfo.planId,
			"x-key0-amount": paymentInfo.amount,
			...(paymentInfo.payer ? { "x-key0-payer": paymentInfo.payer } : {}),
		};
		const mergedHeaders: Record<string, string> = {
			...headers,
			...paymentHeaders,
			...(proxyConfig.headers ?? {}),
			// Internal auth — injected last, cannot be overridden by caller or payment headers
			...(proxyConfig.proxySecret ? { "x-key0-internal-token": proxyConfig.proxySecret } : {}),
		};

		// Drop hop-by-hop headers that must not be forwarded.
		delete mergedHeaders["host"];
		delete mergedHeaders["connection"];
		delete mergedHeaders["transfer-encoding"];

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30_000);
		let res: Response;
		try {
			res = await fetch(targetUrl, {
				method,
				headers: mergedHeaders,
				signal: controller.signal,
				...(body !== undefined && method !== "GET" && method !== "HEAD"
					? { body: typeof body === "string" ? body : JSON.stringify(body) }
					: {}),
			});
		} finally {
			clearTimeout(timeout);
		}

		const responseHeaders: Record<string, string> = {};
		res.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		let responseBody: unknown;
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			responseBody = await res.json().catch(() => null);
		} else {
			responseBody = await res.text();
		}

		return { status: res.status, headers: responseHeaders, body: responseBody };
	};
}

/**
 * Resolves a `fetchResource` callback from `SellerConfig`.
 * Returns the explicit callback if set, builds one from `proxyTo` if set, or returns `undefined`
 * (embedded mode — routes use `payPerRequest` middleware on local endpoints instead).
 *
 * Used by the HTTP, A2A, and MCP handlers to determine the deployment mode at runtime.
 */
export function resolveConfigFetchResource(
	config: SellerConfig,
): ((params: FetchResourceParams) => Promise<FetchResourceResult>) | undefined {
	if (config.fetchResource) return config.fetchResource;
	if (config.proxyTo) return proxyToFetchResource(config.proxyTo);
	return undefined;
}

function resolveFromStandaloneConfig(opts: PayPerRequestConfig): ResolvedRouteDeps {
	const networkConfig = CHAIN_CONFIGS[opts.config.network];
	const fetchResource =
		opts.fetchResource ?? (opts.proxyTo ? proxyToFetchResource(opts.proxyTo) : undefined);

	if (fetchResource && !opts.store) {
		console.warn(
			`[Key0 PayPerRequest] WARNING: route "${opts.routeId}" is in standalone gateway mode ` +
				"(fetchResource/proxyTo) without a store. If fetchResource throws after on-chain " +
				"settlement, the payer cannot be automatically refunded. Pass a store for recovery.",
		);
	}

	return {
		routeId: opts.routeId,
		config: opts.config,
		networkConfig,
		route: resolveRoute(opts.routeId, opts.config),
		seenTxStore: opts.seenTxStore,
		store: opts.store,
		onPayment: opts.onPayment,
		fetchResource,
		isDirectProxy: fetchResource != null,
	};
}

// ---------------------------------------------------------------------------
// Shared helpers (framework-agnostic)
// ---------------------------------------------------------------------------

function markDelivered(store: IChallengeStore, challengeId: string): void {
	store
		.transition(
			challengeId,
			"PAID",
			"DELIVERED",
			{ deliveredAt: new Date() },
			{ actor: "engine", reason: "pay_per_request_delivered" },
		)
		.catch(() => {
			// Best-effort — if this fails the refund cron may try to refund,
			// which is a safe fallback
		});
}

function build402ResponseForRoute(
	deps: ResolvedRouteDeps,
	resourceUrl: string,
	method: string,
	path: string,
) {
	const requirements = buildHttpPaymentRequirements(
		deps.routeId,
		path,
		deps.config,
		deps.networkConfig,
		{
			description:
				deps.route.description ??
				`Pay-per-request: ${deps.route.routeId} (${deps.route.unitAmount ?? "free"} USDC)`,
		},
	);
	return {
		...requirements,
		resource: {
			...requirements.resource,
			url: resourceUrl,
			method,
		},
	};
}

async function settleAndRecordForRoute(
	deps: ResolvedRouteDeps,
	paymentSignature: string,
	method: string,
	path: string,
	onDelivered: (challengeId: string) => void,
): Promise<{ paymentInfo: PaymentInfo; settleResponseBase64: string }> {
	const challengeId = `ppr-${crypto.randomUUID()}`;

	const paymentPayload = decodePaymentSignature(paymentSignature);

	const { txHash, settleResponse, payer } = await settlePayment(
		paymentPayload,
		deps.config,
		deps.networkConfig,
	);

	const marked = await deps.seenTxStore.markUsed(txHash, challengeId);
	if (!marked) {
		throw new Key0Error(
			"TX_ALREADY_REDEEMED",
			"This payment has already been used for a previous request",
			409,
		);
	}

	if (deps.store && deps.route.unitAmount) {
		const now = new Date();
		const record: ChallengeRecord = {
			challengeId,
			requestId: challengeId,
			clientAgentId: "x402-ppr",
			resourceId: path,
			planId: deps.routeId,
			amount: deps.route.unitAmount,
			amountRaw: parseDollarToUsdcMicro(deps.route.unitAmount),
			asset: "USDC",
			chainId: deps.networkConfig.chainId,
			destination: deps.config.walletAddress,
			state: "PENDING",
			expiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
		};

		await deps.store.create(record, {
			actor: "engine",
			reason: "pay_per_request_created",
		});

		const transitioned = await deps.store.transition(
			challengeId,
			"PENDING",
			"PAID",
			{
				txHash,
				paidAt: now,
				...(payer ? { fromAddress: payer as `0x${string}` } : {}),
			},
			{ actor: "engine", reason: "pay_per_request_settled" },
		);
		if (!transitioned) {
			throw new Key0Error("INVALID_REQUEST", "Challenge already processed", 409);
		}

		onDelivered(challengeId);
	}

	const paymentInfo: PaymentInfo = {
		txHash,
		payer,
		planId: deps.routeId,
		amount: deps.route.unitAmount ?? "0",
		method,
		path,
		challengeId,
	};

	if (deps.onPayment) {
		const maybePromise = deps.onPayment(paymentInfo);
		if (maybePromise && typeof maybePromise.catch === "function") {
			maybePromise.catch(() => {});
		}
	}

	return {
		paymentInfo,
		settleResponseBase64: Buffer.from(JSON.stringify(settleResponse)).toString("base64"),
	};
}

// ===========================================================================
// Express middleware
// ===========================================================================

/**
 * @internal Factory used by key0Router to create Express pay-per-request middleware
 * using the routes-based (routeId) path.
 */
export function createExpressPayPerRequest(
	routeId: string,
	routerDeps: PayPerRequestDeps,
	options?: PayPerRequestOptions,
) {
	const deps = resolveFromRouterByRouteId(routeId, routerDeps, options);
	return expressRoutePayPerRequestHandler(deps);
}

/**
 * Standalone Express middleware that gates a route behind a per-request USDC micro-payment.
 *
 * - No `PAYMENT-SIGNATURE` header → returns **402** with x402 payment requirements.
 * - With `PAYMENT-SIGNATURE` header:
 *   - **Embedded mode** (no `fetchResource`/`proxyTo`): settles on-chain → calls `next()`.
 *   - **Standalone mode** (`fetchResource` or `proxyTo` provided): settles on-chain → proxies to backend → returns backend response.
 *
 * After settlement, `req.key0Payment` contains payment metadata (embedded mode only)
 * and the `payment-response` header is set on the response.
 *
 * @example
 * ```ts
 * // Embedded
 * app.get("/api/weather/:city",
 *   key0PayPerRequest({ routeId: "weather-query", config, seenTxStore }),
 *   (req, res) => res.json({ city: req.params.city, temp: 72 }),
 * );
 *
 * // Standalone (proxy)
 * app.get("/api/weather/:city",
 *   key0PayPerRequest({
 *     routeId: "weather-query",
 *     config,
 *     seenTxStore,
 *     proxyTo: { baseUrl: "https://weather-api.internal" },
 *   }),
 * );
 * ```
 */
export function key0PayPerRequest(opts: PayPerRequestConfig) {
	return expressRoutePayPerRequestHandler(resolveFromStandaloneConfig(opts));
}

/**
 * @internal Express handler for the routes-based (routeId) pay-per-request path.
 * Used by createExpressPayPerRequest (key0Router with config.routes).
 */
function expressRoutePayPerRequestHandler(deps: ResolvedRouteDeps) {
	return async (
		req: {
			method: string;
			path: string;
			originalUrl: string;
			headers: Record<string, unknown>;
			body?: unknown;
		},
		res: {
			status: (code: number) => { json: (data: unknown) => unknown };
			setHeader: (name: string, value: string) => void;
			send?: (data: unknown) => unknown;
			statusCode: number;
			on: (event: string, cb: () => void) => void;
		},
		next: () => void,
	) => {
		// Free route — no payment needed
		if (!deps.route.unitAmount) {
			if (deps.fetchResource) {
				const result = await deps.fetchResource({
					paymentInfo: {
						txHash:
							"0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
						payer: undefined,
						planId: deps.routeId,
						amount: "0",
						method: req.method,
						path: req.path,
						challengeId: "free",
					},
					method: req.method,
					path: req.path,
					headers: req.headers as Record<string, string>,
					body: req.body,
				});
				for (const [k, v] of Object.entries(result.headers ?? {})) {
					res.setHeader(k, v);
				}
				return res.status(result.status).json(result.body);
			}
			(req as Record<string, unknown>)["key0Payment"] = undefined;
			return next();
		}

		const paymentSignature = req.headers["payment-signature"] as string | undefined;

		// ===== No payment → 402 Payment Required =====
		if (!paymentSignature) {
			const baseUrl = deps.config.agentUrl.replace(/\/$/, "");
			const response = build402ResponseForRoute(
				deps,
				`${baseUrl}${req.originalUrl}`,
				req.method,
				req.path,
			);

			const encoded = Buffer.from(JSON.stringify(response)).toString("base64");
			res.setHeader("payment-required", encoded);
			return res.status(402).json(response);
		}

		// ===== Payment present → decode + settle + deliver =====
		try {
			let deliveredChallengeId: string | undefined;

			const { paymentInfo, settleResponseBase64 } = await settleAndRecordForRoute(
				deps,
				paymentSignature,
				req.method,
				req.path,
				(challengeId) => {
					deliveredChallengeId = challengeId;
				},
			);

			res.setHeader("payment-response", settleResponseBase64);

			if (deps.isDirectProxy) {
				// STANDALONE MODE: direct proxy — pipe raw backend response through
				const result = await deps.fetchResource!({
					paymentInfo,
					method: req.method,
					path: req.path,
					headers: req.headers as Record<string, string>,
					body: req.body,
				});

				for (const [k, v] of Object.entries(result.headers ?? {})) {
					res.setHeader(k, v);
				}

				if (deliveredChallengeId && deps.store && result.status >= 200 && result.status < 400) {
					deps.store
						.transition(
							deliveredChallengeId,
							"PAID",
							"DELIVERED",
							{ deliveredAt: new Date() },
							{ actor: "gateway" },
						)
						.catch(() => {});
				}

				return res.status(result.status).json(result.body);
			} else {
				// EMBEDDED MODE: pass to local handler
				if (deliveredChallengeId && deps.store) {
					res.on("finish", () => {
						if (res.statusCode >= 200 && res.statusCode < 400) {
							markDelivered(deps.store!, deliveredChallengeId!);
						}
					});
				}
				(req as Record<string, unknown>)["key0Payment"] = paymentInfo;
				next();
			}
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return res.status(err.httpStatus).json(err.toJSON());
			}
			return res.status(500).json({
				type: "Error",
				code: "PAYMENT_SETTLEMENT_FAILED",
				message: err instanceof Error ? err.message : "Payment settlement failed",
			});
		}
	};
}

// ===========================================================================
// Hono middleware
// ===========================================================================

/**
 * @internal Factory used by key0App to create Hono pay-per-request middleware.
 * Accepts a routeId and looks up from config.routes.
 */
export function createHonoPayPerRequest(
	routeId: string,
	routerDeps: PayPerRequestDeps,
	options?: PayPerRequestOptions,
) {
	const deps = resolveFromRouterByRouteId(routeId, routerDeps, options);
	return honoRoutePayPerRequestHandler(deps);
}

/**
 * Standalone Hono middleware that gates a route behind a per-request USDC micro-payment.
 *
 * @example
 * ```ts
 * import { honoPayPerRequest } from "@key0ai/key0/hono";
 *
 * // Embedded
 * app.get("/api/weather/:city",
 *   honoPayPerRequest({ routeId: "weather-query", config, seenTxStore }),
 *   (c) => c.json({ temp: 72 }),
 * );
 *
 * // Standalone (proxy)
 * app.get("/api/weather/:city",
 *   honoPayPerRequest({
 *     routeId: "weather-query",
 *     config,
 *     seenTxStore,
 *     proxyTo: { baseUrl: "https://weather-api.internal" },
 *   }),
 * );
 * ```
 */
export function honoPayPerRequest(opts: PayPerRequestConfig) {
	return honoRoutePayPerRequestHandler(resolveFromStandaloneConfig(opts));
}

/**
 * @internal Hono handler for the routes-based (routeId) pay-per-request path.
 */
function honoRoutePayPerRequestHandler(deps: ResolvedRouteDeps) {
	return async (
		c: {
			req: {
				method: string;
				path: string;
				url: string;
				header: (name: string) => string | undefined;
				raw: Request;
			};
			header: (name: string, value: string) => void;
			json: (data: unknown, status?: number) => Response;
			set: (key: string, value: unknown) => void;
			status: (code: number) => void;
			res: { status: number };
		},
		next: () => Promise<void>,
	) => {
		if (!deps.route.unitAmount) {
			if (deps.fetchResource) {
				const rawHeaders: Record<string, string> = {};
				c.req.raw.headers.forEach((v, k) => {
					rawHeaders[k] = v;
				});
				const result = await deps.fetchResource({
					paymentInfo: {
						txHash:
							"0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
						payer: undefined,
						planId: deps.routeId,
						amount: "0",
						method: c.req.method,
						path: c.req.path,
						challengeId: "free",
					},
					method: c.req.method,
					path: c.req.path,
					headers: rawHeaders,
				});
				return c.json(result.body, result.status as any);
			}
			c.set("key0Payment", undefined);
			return next();
		}

		const paymentSignature = c.req.header("payment-signature");
		if (!paymentSignature) {
			const baseUrl = deps.config.agentUrl.replace(/\/$/, "");
			const response = build402ResponseForRoute(
				deps,
				`${baseUrl}${c.req.path}`,
				c.req.method,
				c.req.path,
			);
			const encoded = Buffer.from(JSON.stringify(response)).toString("base64");
			c.header("payment-required", encoded);
			return c.json(response, 402);
		}

		try {
			let deliveredChallengeId: string | undefined;

			const { paymentInfo, settleResponseBase64 } = await settleAndRecordForRoute(
				deps,
				paymentSignature,
				c.req.method,
				c.req.path,
				(challengeId) => {
					deliveredChallengeId = challengeId;
				},
			);

			c.header("payment-response", settleResponseBase64);

			if (deps.isDirectProxy) {
				// STANDALONE MODE: direct proxy — pipe raw backend response through
				const rawHeaders: Record<string, string> = {};
				c.req.raw.headers.forEach((v, k) => {
					rawHeaders[k] = v;
				});
				let body: unknown;
				try {
					body = await c.req.raw.json();
				} catch {
					body = undefined;
				}

				const result = await deps.fetchResource!({
					paymentInfo,
					method: c.req.method,
					path: c.req.path,
					headers: rawHeaders,
					body,
				});

				for (const [k, v] of Object.entries(result.headers ?? {})) {
					c.header(k, v);
				}
				if (deliveredChallengeId && deps.store && result.status >= 200 && result.status < 400) {
					deps.store
						.transition(
							deliveredChallengeId,
							"PAID",
							"DELIVERED",
							{ deliveredAt: new Date() },
							{ actor: "gateway" },
						)
						.catch(() => {});
				}
				return c.json(result.body, result.status as any);
			} else {
				c.set("key0Payment", paymentInfo);
				await next();
				if (deliveredChallengeId && deps.store && c.res.status >= 200 && c.res.status < 400) {
					markDelivered(deps.store, deliveredChallengeId);
				}
			}
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return c.json(err.toJSON(), err.httpStatus as any);
			}
			return c.json(
				{
					type: "Error",
					code: "PAYMENT_SETTLEMENT_FAILED",
					message: err instanceof Error ? err.message : "Payment settlement failed",
				},
				500,
			);
		}
	};
}

// ===========================================================================
// Fastify preHandler hook
// ===========================================================================

/**
 * @internal Factory used by createKey0Fastify to create Fastify pay-per-request preHandler.
 * Accepts a routeId and looks up from config.routes.
 */
export function createFastifyPayPerRequest(
	routeId: string,
	routerDeps: PayPerRequestDeps,
	options?: PayPerRequestOptions,
) {
	const deps = resolveFromRouterByRouteId(routeId, routerDeps, options);
	return fastifyRoutePayPerRequestHandler(deps);
}

/**
 * Standalone Fastify preHandler hook that gates a route behind a per-request USDC micro-payment.
 *
 * @example
 * ```ts
 * import { fastifyPayPerRequest } from "@key0ai/key0/fastify";
 *
 * // Embedded
 * fastify.get("/api/weather/:city",
 *   { preHandler: fastifyPayPerRequest({ routeId: "weather-query", config, seenTxStore }) },
 *   async (request, reply) => reply.send({ temp: 72 }),
 * );
 *
 * // Standalone (proxy)
 * fastify.get("/api/weather/:city",
 *   { preHandler: fastifyPayPerRequest({
 *     routeId: "weather-query",
 *     config,
 *     seenTxStore,
 *     proxyTo: { baseUrl: "https://weather-api.internal" },
 *   }) },
 *   async (_request, reply) => reply.send(), // reply already sent by middleware
 * );
 * ```
 */
export function fastifyPayPerRequest(opts: PayPerRequestConfig) {
	return fastifyRoutePayPerRequestHandler(resolveFromStandaloneConfig(opts));
}

/**
 * @internal Fastify preHandler for the routes-based (routeId) pay-per-request path.
 */
function fastifyRoutePayPerRequestHandler(deps: ResolvedRouteDeps) {
	return async (
		request: {
			method: string;
			url: string;
			headers: Record<string, unknown>;
			routeOptions?: { url?: string };
			body?: unknown;
		},
		reply: {
			code: (code: number) => { send: (data: unknown) => unknown };
			header: (name: string, value: string) => unknown;
			statusCode: number;
			raw: { on?: (event: string, cb: () => void) => void };
			sent?: boolean;
		},
	) => {
		const routePath = request.routeOptions?.url ?? request.url;

		if (!deps.route.unitAmount) {
			if (deps.fetchResource) {
				const result = await deps.fetchResource({
					paymentInfo: {
						txHash:
							"0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
						payer: undefined,
						planId: deps.routeId,
						amount: "0",
						method: request.method,
						path: routePath,
						challengeId: "free",
					},
					method: request.method,
					path: routePath,
					headers: request.headers as Record<string, string>,
					body: request.body,
				});
				for (const [k, v] of Object.entries(result.headers ?? {})) {
					reply.header(k, v);
				}
				return reply.code(result.status).send(result.body);
			}
			(request as Record<string, unknown>)["key0Payment"] = undefined;
			return;
		}

		const paymentSignature = request.headers["payment-signature"] as string | undefined;

		if (!paymentSignature) {
			const baseUrl = deps.config.agentUrl.replace(/\/$/, "");
			const response = build402ResponseForRoute(
				deps,
				`${baseUrl}${request.url}`,
				request.method,
				routePath,
			);
			const encoded = Buffer.from(JSON.stringify(response)).toString("base64");
			reply.header("payment-required", encoded);
			return reply.code(402).send(response);
		}

		try {
			let deliveredChallengeId: string | undefined;

			const { paymentInfo, settleResponseBase64 } = await settleAndRecordForRoute(
				deps,
				paymentSignature,
				request.method,
				routePath,
				(challengeId) => {
					deliveredChallengeId = challengeId;
				},
			);

			reply.header("payment-response", settleResponseBase64);

			if (deps.isDirectProxy) {
				// STANDALONE MODE: direct proxy — pipe raw backend response through
				const result = await deps.fetchResource!({
					paymentInfo,
					method: request.method,
					path: routePath,
					headers: request.headers as Record<string, string>,
					body: request.body,
				});
				for (const [k, v] of Object.entries(result.headers ?? {})) {
					reply.header(k, v);
				}
				if (deliveredChallengeId && deps.store && result.status >= 200 && result.status < 400) {
					deps.store
						.transition(
							deliveredChallengeId,
							"PAID",
							"DELIVERED",
							{ deliveredAt: new Date() },
							{ actor: "gateway" },
						)
						.catch(() => {});
				}
				return reply.code(result.status).send(result.body);
			} else {
				if (deliveredChallengeId && deps.store) {
					reply.raw.on?.("finish", () => {
						if (reply.statusCode >= 200 && reply.statusCode < 400) {
							markDelivered(deps.store!, deliveredChallengeId!);
						}
					});
				}
				(request as Record<string, unknown>)["key0Payment"] = paymentInfo;
			}
		} catch (err2: unknown) {
			if (err2 instanceof Key0Error) {
				return reply.code(err2.httpStatus).send(err2.toJSON());
			}
			return reply.code(500).send({
				type: "Error",
				code: "PAYMENT_SETTLEMENT_FAILED",
				message: err2 instanceof Error ? err2.message : "Payment settlement failed",
			});
		}
	};
}
