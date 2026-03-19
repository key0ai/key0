export type ChallengeState =
	| "PENDING"
	| "PAID" // payment verified, access token issued, awaiting delivery confirmation
	| "DELIVERED" // seller confirmed resource was served — final success state
	| "REFUND_PENDING" // cron claimed this, refund tx being broadcast
	| "REFUNDED" // refund sent on-chain — final state
	| "REFUND_FAILED" // refund tx threw — needs operator attention
	| "EXPIRED"
	| "CANCELLED";

export type AccessRequest = {
	readonly requestId: string; // UUID, client-generated, idempotency key
	readonly resourceId: string; // seller-defined resource identifier
	readonly planId: string; // must match a Plan.planId
	readonly clientAgentId: string; // DID or URL of client agent
	readonly callbackUrl?: string; // optional async webhook
	/** For per-request plans in standalone mode: the backend resource to call after payment. */
	readonly resource?: {
		readonly method: string;
		readonly path: string;
		readonly body?: unknown;
	};
};

export type X402Challenge = {
	readonly type: "X402Challenge";
	readonly challengeId: string; // server-generated UUID
	readonly requestId: string; // echoed from AccessRequest
	readonly planId: string;
	readonly amount: string; // "$0.10"
	readonly asset: "USDC";
	readonly chainId: number;
	readonly destination: `0x${string}`;
	readonly expiresAt: string; // ISO-8601
	readonly description: string;
	readonly resourceVerified: boolean;
};

export type PaymentProof = {
	readonly type: "PaymentProof";
	readonly challengeId: string;
	readonly requestId: string;
	readonly chainId: number;
	readonly txHash: `0x${string}`;
	readonly amount: string;
	readonly asset: "USDC";
	readonly fromAgentId: string;
};

export type AccessGrant = {
	readonly type: "AccessGrant";
	readonly challengeId: string;
	readonly requestId: string;
	readonly accessToken: string;
	readonly tokenType: "Bearer";
	readonly resourceEndpoint: string;
	readonly resourceId: string;
	readonly planId: string;
	readonly txHash: `0x${string}`;
	readonly explorerUrl: string;
};

/**
 * Returned by /x402/access for route-based calls.
 * Contains the actual backend resource data instead of an access token.
 */
export type ResourceResponse = {
	readonly type: "ResourceResponse";
	readonly challengeId: string;
	readonly requestId: string;
	readonly planId?: string; // present for subscription flows
	readonly routeId?: string; // present for route-based calls
	readonly txHash?: `0x${string}`; // absent for free routes
	readonly explorerUrl?: string; // absent for free routes
	readonly resource: {
		readonly status: number;
		readonly headers?: Record<string, string>;
		readonly body: unknown;
	};
};

/**
 * Alias for ResourceResponse — used in specs and docs as "ProxyGrant".
 * Represents the data returned by Key0 after proxying a paid or free plan call.
 */
export type ProxyGrant = ResourceResponse;

// Internal challenge record (stored in IChallengeStore)
export type ChallengeRecord = {
	readonly challengeId: string;
	readonly requestId: string;
	readonly clientAgentId: string;
	readonly resourceId: string;
	readonly planId: string;
	readonly amount: string; // "$0.10"
	readonly amountRaw: bigint; // 100000n (USDC micro-units)
	readonly asset: "USDC";
	readonly chainId: number;
	readonly destination: `0x${string}`;
	readonly state: ChallengeState;
	readonly expiresAt: Date;
	readonly createdAt: Date;
	readonly updatedAt: Date; // auto-updated on every write
	readonly paidAt?: Date;
	readonly txHash?: `0x${string}`;
	readonly accessGrant?: AccessGrant;
	readonly fromAddress?: `0x${string}`; // payer's wallet — set on PENDING→PAID
	readonly deliveredAt?: Date; // set on PAID→DELIVERED
	readonly refundTxHash?: `0x${string}`; // set on REFUND_PENDING→REFUNDED
	readonly refundedAt?: Date; // set on REFUND_PENDING→REFUNDED
	readonly refundError?: string; // set on REFUND_PENDING→REFUND_FAILED
};
