export type AgentGateErrorCode =
	| "RESOURCE_NOT_FOUND"
	| "TIER_NOT_FOUND"
	| "CHALLENGE_NOT_FOUND"
	| "CHALLENGE_EXPIRED"
	| "CHAIN_MISMATCH"
	| "AMOUNT_MISMATCH"
	| "TX_UNCONFIRMED"
	| "TX_ALREADY_REDEEMED"
	| "PROOF_ALREADY_REDEEMED"
	| "INVALID_REQUEST"
	| "INVALID_PROOF"
	| "ADAPTER_ERROR"
	| "RESOURCE_VERIFY_TIMEOUT"
	| "TOKEN_ISSUE_FAILED"
	| "TOKEN_ISSUE_TIMEOUT"
	| "INTERNAL_ERROR";

export class AgentGateError extends Error {
	readonly code: AgentGateErrorCode;
	readonly httpStatus: number;
	readonly details?: Record<string, unknown> | undefined;

	constructor(
		code: AgentGateErrorCode,
		message: string,
		httpStatus = 400,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AgentGateError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.details = details;
	}

	toJSON() {
		return {
			type: "Error" as const,
			code: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		};
	}
}
