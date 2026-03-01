export type IssueChallengeParams = {
	readonly requestId: string;
	readonly resourceId: string;
	readonly tierId: string;
	readonly amount: string; // "$0.10"
	readonly destination: `0x${string}`;
	readonly expiresAt: Date;
	readonly metadata: Record<string, unknown>;
};

export type ChallengePayload = {
	readonly challengeId: string;
	readonly protocol: string;
	readonly raw: Record<string, unknown>; // protocol-specific, exposed to client
	readonly expiresAt: Date;
};

export type VerifyProofParams = {
	readonly challengeId: string;
	readonly proof: {
		readonly txHash: `0x${string}`;
		readonly chainId: number;
		readonly amount: string;
		readonly asset: string;
	};
	readonly expected: {
		readonly destination: `0x${string}`;
		readonly amountRaw: bigint;
		readonly chainId: number;
		readonly expiresAt: Date;
	};
};

export type VerificationResult = {
	readonly verified: boolean;
	readonly txHash?: `0x${string}`;
	readonly fromAddress?: `0x${string}`; // payer's wallet, extracted from Transfer event
	readonly confirmedAmount?: bigint;
	readonly confirmedChainId?: number;
	readonly confirmedAt?: Date;
	readonly blockNumber?: bigint;
	readonly error?: string;
	readonly errorCode?: VerificationErrorCode;
};

export type VerificationErrorCode =
	| "TX_NOT_FOUND"
	| "TX_REVERTED"
	| "WRONG_RECIPIENT"
	| "AMOUNT_INSUFFICIENT"
	| "CHAIN_MISMATCH"
	| "TX_AFTER_EXPIRY"
	| "NO_TRANSFER_EVENT"
	| "RPC_ERROR";

export interface IPaymentAdapter {
	readonly protocol: string;

	issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload>;

	verifyProof(params: VerifyProofParams): Promise<VerificationResult>;
}
