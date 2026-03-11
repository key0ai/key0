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
	readonly tierId: string; // must match a ProductTier.tierId
	readonly clientAgentId: string; // DID or URL of client agent
	readonly callbackUrl?: string; // optional async webhook
};

export type X402Challenge = {
	readonly type: "X402Challenge";
	readonly challengeId: string; // server-generated UUID
	readonly requestId: string; // echoed from AccessRequest
	readonly tierId: string;
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
	readonly expiresAt: string; // ISO-8601
	readonly resourceEndpoint: string;
	readonly resourceId: string;
	readonly tierId: string;
	readonly txHash: `0x${string}`;
	readonly explorerUrl: string;
};

// Internal challenge record (stored in IChallengeStore)
export type ChallengeRecord = {
	readonly challengeId: string;
	readonly requestId: string;
	readonly clientAgentId: string;
	readonly resourceId: string;
	readonly tierId: string;
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
