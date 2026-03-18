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

export type PlanRouteInfo = {
	readonly method: string;
	readonly path: string;
	readonly description?: string;
};

export type Plan = {
	readonly planId: string;
	readonly unitAmount: string; // "$0.10"
	readonly description?: string;
	/** "subscription" (default) uses the /x402/access challenge flow; "per-request" gates individual routes. */
	readonly mode?: "subscription" | "per-request";
	/** Declared routes for per-request plans — surfaced in discovery, agent card, and MCP discover_plans. */
	readonly routes?: readonly PlanRouteInfo[];

	// ── Free plan ──────────────────────────────────────────────────────────────
	/**
	 * When true, this plan skips x402 payment entirely.
	 * Key0 proxies directly to the backend and returns the result.
	 */
	readonly free?: true;

	// ── Per-plan static proxy ──────────────────────────────────────────────────
	/**
	 * Backend path template to proxy to after payment (or immediately for free plans).
	 * Supports `{param}` placeholders interpolated from agent-supplied `params`.
	 * Resolved against `proxyTo.baseUrl` from SellerConfig.
	 * @example "/signal/{asset}"  → GET baseUrl/signal/BTC
	 * @example "/health"          → GET baseUrl/health
	 */
	readonly proxyPath?: string;
	/** HTTP method for the proxied request. Defaults to "GET". */
	readonly proxyMethod?: "GET" | "POST";
	/** Static query params appended to every proxied URL. */
	readonly proxyQuery?: Readonly<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Per-request / fetchResource types
// Defined here (not in pay-per-request.ts) so SellerConfig can reference them
// without creating a circular import between types/ and integrations/.
// ---------------------------------------------------------------------------

export type PaymentInfo = {
	readonly txHash: `0x${string}`;
	readonly payer: string | undefined;
	readonly planId: string;
	readonly amount: string;
	readonly method: string;
	readonly path: string;
	readonly challengeId: string;
};

/** Request context passed to `fetchResource` in standalone gateway mode. */
export type FetchResourceParams = {
	readonly paymentInfo: PaymentInfo;
	readonly method: string;
	readonly path: string;
	readonly headers: Record<string, string>;
	readonly body?: unknown;
};

/** Response shape returned by `fetchResource` in standalone gateway mode. */
export type FetchResourceResult = {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly body: unknown;
};

/**
 * Shorthand for proxying to a backend URL instead of writing a full
 * `fetchResource` callback. `fetchResource` takes priority when both are provided.
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
	readonly plans: readonly Plan[];

	// Challenge
	readonly challengeTTLSeconds?: number; // defaults to 900

	// Credential issuance callback (required for subscription plans)
	/**
	 * Callback that fetches/issues resource credentials after payment is verified.
	 * The implementation is fully up to you — generate a JWT, call another service, return an API key, etc.
	 * Not called for per-request plans when fetchResource/proxyTo is configured.
	 */
	readonly fetchResourceCredentials?: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;
	/** Timeout for fetchResourceCredentials callback in ms. Default: 15000. */
	readonly tokenIssueTimeoutMs?: number;
	/** Max retries for fetchResourceCredentials on failure. Default: 2. */
	readonly tokenIssueRetries?: number;

	// Standalone per-request proxy (optional — enables full A2A/MCP/HTTP support for per-request plans)
	/**
	 * Called after on-chain settlement for per-request plans. The gateway proxies the request
	 * to the backend and returns its response directly to the client.
	 * When set, per-request plans flow through /x402/access (HTTP, A2A, MCP).
	 * When absent, per-request plans are HTTP-only via payPerRequest middleware.
	 */
	readonly fetchResource?: (params: FetchResourceParams) => Promise<FetchResourceResult>;
	/**
	 * Shorthand: proxy per-request plans to a backend URL.
	 * Builds a `fetchResource` callback automatically.
	 * `fetchResource` takes priority when both are provided.
	 */
	readonly proxyTo?: ProxyToConfig;

	// Lifecycle hooks (optional)
	readonly onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
	readonly onChallengeExpired?: (challengeId: string) => Promise<void>;

	// MCP
	/** When true, MCP discovery and Streamable HTTP endpoint are mounted. */
	readonly mcp?: boolean | undefined;

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
