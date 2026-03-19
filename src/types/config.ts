import type { AccessGrant } from "./challenge.js";

export type NetworkName = "mainnet" | "testnet";

export type TokenIssuanceResult = {
	readonly token: string;
	readonly tokenType?: string; // Default "Bearer"
};

export type IssueTokenParams = {
	readonly requestId: string;
	readonly challengeId: string;
	readonly resourceId: string;
	readonly planId: string;
	readonly txHash: string;
};

export type NetworkConfig = {
	readonly name: NetworkName;
	readonly chainId: number;
	readonly rpcUrl: string;
	readonly usdcAddress: `0x${string}`;
	readonly facilitatorUrl: string;
	readonly explorerBaseUrl: string;
	/** EIP-712 domain parameters for USDC contract */
	readonly usdcDomain: {
		readonly name: string;
		readonly version: string;
	};
};

/** Route metadata for a per-request plan (embedded or standalone). */
export type PlanRouteInfo = {
	readonly method: string;
	readonly path: string;
	readonly description?: string;
};

export type Plan = {
	readonly planId: string;
	/** Required for paid plans; may be omitted for free plans. */
	readonly unitAmount?: string;
	readonly description?: string;
	/** "subscription" (default) or "per-request". */
	readonly mode?: "subscription" | "per-request";
	/** Route endpoints exposed for this plan (per-request plans). */
	readonly routes?: readonly PlanRouteInfo[];
	/** When true, the plan is free (no payment required). */
	readonly free?: boolean;
	/** Proxy path template for standalone gateway mode (e.g. "/api/{param}"). */
	readonly proxyPath?: string;
	/** Static query params appended to the proxied request. */
	readonly proxyQuery?: Record<string, string>;
	/** HTTP method for the proxied request (default: "GET"). */
	readonly proxyMethod?: string;
};

export type RouteParam = {
	readonly name: string;
	/** "path" = extracted from :param in path; "query" = URL query string; "body" = request body */
	readonly in: "path" | "query" | "body";
	readonly description?: string;
	readonly required?: boolean;
	readonly type?: "string" | "number" | "boolean" | "object";
};

export type Route = {
	readonly routeId: string;
	readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	readonly path: string; // Express-style :param (e.g. "/api/weather/:city")
	readonly unitAmount?: string; // absent = free
	readonly description?: string;
	/** Request parameter definitions (path params auto-derived; add query/body params here). */
	readonly params?: readonly RouteParam[];
};

// ---------------------------------------------------------------------------
// Per-request / proxy types
// ---------------------------------------------------------------------------

/** Parameters passed to a fetchResource callback for proxying a backend call. */
export type FetchResourceParams = {
	readonly method: string;
	readonly path: string;
	readonly headers: Record<string, string>;
	readonly body?: unknown;
	readonly paymentInfo: PaymentInfo;
};

/** Result returned by a fetchResource callback after proxying a backend call. */
export type FetchResourceResult = {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly body: unknown;
};

export type PaymentInfo = {
	readonly txHash: `0x${string}`;
	readonly payer: string | undefined;
	readonly planId: string;
	readonly amount: string;
	readonly method: string;
	readonly path: string;
	readonly challengeId: string;
};

/**
 * Shorthand for proxying route-based calls to a backend URL.
 */
export type ProxyToConfig = {
	readonly baseUrl: string;
	/** Extra headers merged into the proxied request (e.g. service auth). */
	readonly headers?: Record<string, string>;
	/** Optional path rewrite applied before forwarding (e.g. strip a prefix). */
	readonly pathRewrite?: (path: string) => string;
	/**
	 * When set, attached as `X-Key0-Internal-Token` header on every proxied request.
	 * The backend validates this to ensure all traffic originates from Key0.
	 * Set via `KEY0_PROXY_SECRET` env var in the standalone Docker.
	 */
	readonly proxySecret?: string;
};

/**
 * Minimal Redis interface required for distributed gas wallet lock.
 * Satisfied by any ioredis client instance.
 */
export type IRedisLockClient = {
	set(key: string, value: string, nx: "NX", px: "PX", ttlMs: number): Promise<string | null>;
	eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
};

export type SellerConfig = {
	// Identity
	readonly agentName: string;
	readonly agentDescription: string;
	readonly agentUrl: string;
	readonly providerName: string;
	readonly providerUrl: string;
	readonly version?: string; // defaults to "1.0.0"

	// Payment
	readonly walletAddress: `0x${string}`;
	readonly network: NetworkName;

	// Product catalog
	readonly plans?: readonly Plan[];
	readonly routes?: readonly Route[];

	// Challenge
	readonly challengeTTLSeconds?: number; // defaults to 900

	// Credential issuance callback (required for subscription plans)
	/**
	 * Callback that fetches/issues resource credentials after payment is verified.
	 * The implementation is fully up to you — generate a JWT, call another service, return an API key, etc.
	 * Not called for route-based calls when proxyTo is configured.
	 */
	readonly fetchResourceCredentials?: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;
	/** Timeout for fetchResourceCredentials callback in ms. Default: 15000. */
	readonly tokenIssueTimeoutMs?: number;
	/** Max retries for fetchResourceCredentials on failure. Default: 2. */
	readonly tokenIssueRetries?: number;

	/**
	 * Callback for proxying route-based calls to a backend.
	 * Called after settlement for per-request plans.
	 * Takes precedence over proxyTo if both are set.
	 */
	readonly fetchResource?: (params: FetchResourceParams) => Promise<FetchResourceResult>;
	/**
	 * Shorthand: proxy route-based calls to a backend URL.
	 * Builds a fetch callback automatically.
	 */
	readonly proxyTo?: ProxyToConfig;

	// Lifecycle hooks (optional)
	readonly onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
	readonly onChallengeExpired?: (challengeId: string) => Promise<void>;

	// MCP
	/** When true, MCP discovery and Streamable HTTP endpoint are mounted. */
	readonly mcp?: boolean | undefined;
	/** When false, A2A agent card and JSON-RPC fallback are not mounted. */
	readonly a2a?: boolean | undefined;

	// Customization
	readonly basePath?: string; // defaults to "/agent"
	readonly resourceEndpointTemplate?: string; // e.g. "https://api.example.com/photos/{resourceId}"

	// Settlement strategy (optional — defaults to facilitatorUrl mode)
	readonly gasWalletPrivateKey?: `0x${string}`; // enables gas wallet mode (self-contained settlement)
	readonly facilitatorUrl?: string; // override default facilitatorUrl from CHAIN_CONFIGS
	/**
	 * Optional RPC URL override for on-chain operations (settlement and verification).
	 * When provided, overrides the default public RPC from CHAIN_CONFIGS.
	 * Use a private/Alchemy endpoint for better reliability in production.
	 */
	readonly rpcUrl?: string;

	/**
	 * Redis client for distributed gas wallet settlement locking.
	 * When provided alongside gasWalletPrivateKey, concurrent settlement
	 * requests across multiple instances are serialized via a Redis lock,
	 * preventing gas wallet nonce conflicts.
	 * When absent, falls back to an in-process serial queue (single-instance only).
	 */
	readonly redis?: IRedisLockClient;
};
