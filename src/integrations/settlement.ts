import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, publicActions, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type {
	FacilitatorVerifyResponse,
	NetworkConfig,
	ProductTier,
	SellerConfig,
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402SettleResponse,
} from "../types/index.js";
import { AgentGateError } from "../types/index.js";

export type SettlementResult = {
	txHash: `0x${string}`;
	settleResponse: X402SettleResponse;
	payer?: string;
};

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a raw PAYMENT-SIGNATURE header value (base64url or base64) to X402PaymentPayload.
 * Used by the HTTP middleware to decode the incoming header before settling.
 */
export function decodePaymentSignature(paymentSignature: string): X402PaymentPayload {
	try {
		return JSON.parse(Buffer.from(paymentSignature, "base64url").toString("utf-8"));
	} catch {
		try {
			return JSON.parse(Buffer.from(paymentSignature, "base64").toString("utf-8"));
		} catch {
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Invalid PAYMENT-SIGNATURE header: must be base64url-encoded JSON",
				400,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Build payment requirements (for 402 responses)
// ---------------------------------------------------------------------------

/**
 * Build the HTTP 402 PaymentRequirements response body.
 * Shared between the HTTP middleware and the A2A executor.
 */
export function buildHttpPaymentRequirements(
	tierId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
): X402PaymentRequiredResponse {
	const tier = config.products.find((t: ProductTier) => t.tierId === tierId);
	if (!tier) {
		throw new AgentGateError("TIER_NOT_FOUND", `Tier "${tierId}" not found`, 400);
	}

	const basePath = config.basePath ?? "/a2a";
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const resourceUrl = `${baseUrl}${basePath}/jsonrpc`;

	const amountRaw = parseDollarToUsdcMicro(tier.amount);
	const network = `eip155:${networkConfig.chainId}`;

	return {
		x402Version: 2,
		resource: {
			url: resourceUrl,
			method: "POST",
			description: `Access to ${resourceId}`,
			mimeType: "application/json",
		},
		accepts: [
			{
				scheme: "exact",
				network,
				asset: networkConfig.usdcAddress,
				amount: amountRaw.toString(),
				payTo: config.walletAddress,
				maxTimeoutSeconds: 300,
				extra: {
					name: networkConfig.usdcDomain.name,
					version: networkConfig.usdcDomain.version,
					description: `${tier.label} — ${tier.amount} USDC`,
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Settlement strategies (accept decoded payload)
// ---------------------------------------------------------------------------

/**
 * Settle an EIP-3009 payment via the Coinbase facilitator.
 * Accepts an already-decoded X402PaymentPayload (not the raw header string).
 */
export async function settleViaFacilitator(
	paymentPayload: X402PaymentPayload,
	facilitatorUrl: string,
): Promise<SettlementResult> {
	console.log("[settleViaFacilitator] Starting settlement...");

	let payer: string | undefined = paymentPayload.payload?.authorization?.from ?? undefined;
	const paymentRequirements = paymentPayload.accepted;
	const facilitatorRequestBody = { paymentPayload, paymentRequirements };

	// STEP 1: Verify
	const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(facilitatorRequestBody),
	});

	if (!verifyRes.ok) {
		const errorText = await verifyRes.text().catch(() => "");
		let errorMessage = "Payment verification failed";
		try {
			const errorData = JSON.parse(errorText);
			errorMessage = errorData.message || errorData.error || errorMessage;
		} catch {
			if (errorText) errorMessage = errorText;
		}
		throw new AgentGateError("PAYMENT_FAILED", errorMessage, 402);
	}

	const verifyResult = (await verifyRes.json()) as FacilitatorVerifyResponse;
	if (!verifyResult.isValid) {
		throw new AgentGateError(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}. ${verifyResult.invalidMessage || ""}`.trim(),
			402,
		);
	}
	if (verifyResult.payer && !payer) payer = verifyResult.payer;

	console.log("[settleViaFacilitator] ✓ Payment verified");

	// STEP 2: Settle
	const settleRes = await fetch(`${facilitatorUrl}/settle`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(facilitatorRequestBody),
	});

	if (!settleRes.ok) {
		const errorText = await settleRes.text().catch(() => "");
		let errorMessage = "Facilitator settlement failed";
		try {
			const errorData = JSON.parse(errorText);
			errorMessage = errorData.message || errorData.error || errorMessage;
		} catch {
			if (errorText) errorMessage = errorText;
		}
		throw new AgentGateError("PAYMENT_FAILED", errorMessage, 402);
	}

	const result = (await settleRes.json()) as X402SettleResponse;
	if (!result.success) {
		throw new AgentGateError(
			"PAYMENT_FAILED",
			result.errorReason || "Payment settlement failed",
			402,
		);
	}
	if (!result.transaction) {
		throw new AgentGateError("PAYMENT_FAILED", "Facilitator did not return transaction hash", 500);
	}

	console.log(`[settleViaFacilitator] ✓ Settled: ${result.transaction}`);
	return {
		txHash: result.transaction as `0x${string}`,
		settleResponse: result,
		...(payer && { payer }),
	};
}

/**
 * Settle an EIP-3009 payment via gas wallet (self-contained, using ExactEvmScheme).
 * Accepts an already-decoded X402PaymentPayload (not the raw header string).
 */
export async function settleViaGasWallet(
	paymentPayload: X402PaymentPayload,
	privateKey: `0x${string}`,
	networkConfig: NetworkConfig,
): Promise<SettlementResult> {
	console.log("[settleViaGasWallet] Starting settlement...");

	let payer: string | undefined = paymentPayload.payload?.authorization?.from ?? undefined;
	const requirement = paymentPayload.accepted;
	if (!requirement) {
		throw new AgentGateError(
			"INVALID_REQUEST",
			"Payment payload missing 'accepted' requirement",
			400,
		);
	}

	const gasAccount = privateKeyToAccount(privateKey);
	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;
	const walletClient = createWalletClient({
		account: gasAccount,
		chain,
		transport: viemHttp(networkConfig.rpcUrl),
	}).extend(publicActions);

	const scheme = new ExactEvmScheme(walletClient as any, { deployERC4337WithEIP6492: true });

	// STEP 1: Verify
	let verifyResult: any;
	try {
		verifyResult = await scheme.verify(paymentPayload as any, requirement as any);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Unknown verification error";
		throw new AgentGateError("PAYMENT_FAILED", `Payment verification failed: ${msg}`, 402);
	}

	if (!verifyResult.isValid) {
		throw new AgentGateError(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}`,
			402,
		);
	}
	if (verifyResult.payer && !payer) payer = verifyResult.payer;

	console.log("[settleViaGasWallet] ✓ Payment verified");

	// STEP 2: Settle
	let settlement: any;
	try {
		settlement = await scheme.settle(paymentPayload as any, requirement as any);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Unknown settlement error";
		throw new AgentGateError("PAYMENT_FAILED", `Settlement failed: ${msg}`, 500);
	}

	if (!settlement.success) {
		throw new AgentGateError(
			"PAYMENT_FAILED",
			settlement.errorReason || "Payment settlement failed",
			500,
		);
	}
	if (!settlement.transaction) {
		throw new AgentGateError("PAYMENT_FAILED", "Settlement did not return transaction hash", 500);
	}

	console.log(`[settleViaGasWallet] ✓ Settled: ${settlement.transaction}`);
	console.log(
		`[settleViaGasWallet]   Explorer: ${networkConfig.explorerBaseUrl}/tx/${settlement.transaction}`,
	);

	const settleResponse: X402SettleResponse = {
		success: true,
		transaction: settlement.transaction,
		network: `eip155:${networkConfig.chainId}`,
		...(payer && { payer }),
	};

	return {
		txHash: settlement.transaction as `0x${string}`,
		settleResponse,
		...(payer && { payer }),
	};
}

// ---------------------------------------------------------------------------
// Unified settlement entry point
// ---------------------------------------------------------------------------

/**
 * Settle a payment using the appropriate strategy (gas wallet or facilitator),
 * determined by the seller config. Accepts an already-decoded X402PaymentPayload.
 *
 * Used by both:
 * - HTTP middleware (after decoding the PAYMENT-SIGNATURE header)
 * - A2A executor (payload already decoded from message metadata)
 */
export async function settlePayment(
	paymentPayload: X402PaymentPayload,
	config: SellerConfig,
	networkConfig: NetworkConfig,
): Promise<SettlementResult> {
	if (config.gasWalletPrivateKey) {
		return settleViaGasWallet(paymentPayload, config.gasWalletPrivateKey, networkConfig);
	}
	const facilitatorUrl = config.facilitatorUrl ?? networkConfig.facilitatorUrl;
	return settleViaFacilitator(paymentPayload, facilitatorUrl);
}
