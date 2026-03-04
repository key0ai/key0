/**
 * Types for the A2A x402 Payments Extension v0.2
 * @see https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/spec.md
 */

/** Canonical extension URI for x402 v0.2 */
export const X402_EXTENSION_URI =
	"https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2" as const;

// ---------------------------------------------------------------------------
// x402 Payment Required Response (Server → Client)
// ---------------------------------------------------------------------------

/**
 * A single accepted payment option (x402 v2).
 * Based on core x402 PaymentRequirements.
 * @see https://github.com/coinbase/x402
 */
export type PaymentRequirements = {
	/** The payment scheme (e.g. "exact") */
	readonly scheme: "exact" | string;
	/** Blockchain network in CAIP-2 format (e.g. "eip155:84532") */
	readonly network: string;
	/** ERC-20 token contract address (e.g. USDC address on Base) */
	readonly asset: string;
	/** Amount in the token's smallest unit (e.g. "990000" for $0.99 USDC) */
	readonly amount: string;
	/** Wallet address to pay to */
	readonly payTo: string;
	/** Maximum timeout in seconds for this payment (e.g. 300 for 5 minutes) */
	readonly maxTimeoutSeconds: number;
	/** Optional extra data (e.g. EIP-712 domain parameters, description) */
	readonly extra?: Record<string, unknown>;
};

/**
 * Resource information in x402 v2.
 */
export type ResourceInfo = {
	readonly url: string;
	readonly method: string;
	readonly description?: string;
	readonly mimeType?: string;
};

/**
 * The x402PaymentRequiredResponse object, sent when payment is needed (x402 v2).
 * Placed in task.status.message.metadata["x402.payment.required"] (Standalone Flow).
 */
export type X402PaymentRequiredResponse = {
	readonly x402Version: number;
	readonly resource: ResourceInfo;
	readonly accepts: readonly PaymentRequirements[];
	readonly error?: string;
	readonly extensions?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// x402 Payment Payload (Client → Server)
// ---------------------------------------------------------------------------

/**
 * EIP-3009 authorization structure for transferWithAuthorization.
 * Used when the payment scheme is "exact" with off-chain signatures.
 */
export type EIP3009Authorization = {
	readonly from: string;
	readonly to: string;
	readonly value: string;
	readonly validAfter: string;
	readonly validBefore: string;
	readonly nonce: string;
};

/**
 * Payment payload submitted by the client.
 * Supports both:
 * 1. EIP-3009 signature flow (scheme: "exact")
 * 2. On-chain transaction proof flow (txHash provided)
 *
 * Placed in message.metadata["x402.payment.payload"] (Standalone Flow)
 * or in PAYMENT-SIGNATURE HTTP header (HTTP Flow).
 */
export type X402PaymentPayload = {
	readonly x402Version: number;
	readonly network: string;
	readonly scheme?: string;
	readonly payload: {
		/** EIP-3009 signature (for off-chain authorization) */
		readonly signature?: string;
		/** EIP-3009 authorization parameters (for off-chain authorization) */
		readonly authorization?: EIP3009Authorization;
		/** Transaction hash (for on-chain proof flow) */
		readonly txHash?: string;
		/** Amount paid (smallest unit string, e.g. "990000") */
		readonly amount?: string;
		/** Asset used (e.g. "USDC") */
		readonly asset?: string;
		/** Sender identifier / address */
		readonly from?: string;
	};
	/** Payment requirements that were accepted (echoed back from challenge) */
	readonly accepted?: PaymentRequirements;
};

// ---------------------------------------------------------------------------
// x402 Settle Response / Receipt (Server → Client)
// ---------------------------------------------------------------------------

/**
 * Settlement receipt, included in x402.payment.receipts array.
 * Also used in PAYMENT-RESPONSE header for HTTP transport.
 */
export type X402SettleResponse = {
	readonly success: boolean;
	readonly transaction: string;
	readonly network: string;
	readonly payer?: string;
	readonly errorReason?: string;
};

// ---------------------------------------------------------------------------
// Facilitator API Types
// ---------------------------------------------------------------------------

/**
 * Response from the facilitator /verify endpoint.
 */
export type FacilitatorVerifyResponse = {
	readonly isValid: boolean;
	readonly payer?: string;
	readonly invalidReason?: string;
	readonly invalidMessage?: string;
};

// ---------------------------------------------------------------------------
// x402 Metadata Keys (for message/task metadata)
// ---------------------------------------------------------------------------

/** All possible values for x402.payment.status */
export type X402PaymentStatus =
	| "payment-required"
	| "payment-submitted"
	| "payment-rejected"
	| "payment-verified"
	| "payment-completed"
	| "payment-failed";

/** Metadata keys used in messages and tasks */
export const X402_METADATA_KEYS = {
	STATUS: "x402.payment.status",
	REQUIRED: "x402.payment.required",
	PAYLOAD: "x402.payment.payload",
	RECEIPTS: "x402.payment.receipts",
	ERROR: "x402.payment.error",
} as const;

// ---------------------------------------------------------------------------
// Network mapping (chainId ↔ network name)
// ---------------------------------------------------------------------------

export const CHAIN_ID_TO_NETWORK: Record<number, string> = {
	84532: "base-sepolia",
	8453: "base",
} as const;

export const NETWORK_TO_CHAIN_ID: Record<string, number> = {
	"base-sepolia": 84532,
	base: 8453,
} as const;
