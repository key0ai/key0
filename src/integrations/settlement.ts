import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, publicActions, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type {
	FacilitatorVerifyResponse,
	NetworkConfig,
	Plan,
	Route,
	SellerConfig,
	X402PaymentPayload,
	X402PaymentRequiredResponse,
	X402SettleResponse,
} from "../types/index.js";
import { Key0Error } from "../types/index.js";
import { gasWalletLockKey, withGasWalletLock } from "../utils/gas-wallet-lock.js";

export type SettlementResult = {
	txHash: `0x${string}`;
	settleResponse: X402SettleResponse;
	payer?: string;
};

// ---------------------------------------------------------------------------
// Helpers: fetch with timeout + retry with backoff
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries: number,
	baseDelayMs: number,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			// Don't retry deterministic rejections (invalid sig, insufficient funds, nonce consumed).
			// Only transient errors (network timeouts, 5xx) are worth retrying.
			if (err instanceof Key0Error && err.code === "PAYMENT_FAILED") {
				throw err;
			}
			if (attempt < maxRetries) {
				await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
			}
		}
	}
	throw lastError;
}

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
			throw new Key0Error(
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
 * Build the HTTP 402 PaymentRequirements response body for a single tier.
 * Shared between the HTTP middleware and the A2A executor.
 */
export function buildHttpPaymentRequirements(
	planId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
	options?: {
		inputSchema?: object;
		outputSchema?: object;
		description?: string;
	},
): X402PaymentRequiredResponse {
	// Search plans first, then routes
	const tier = (config.plans ?? []).find((t: Plan) => t.planId === planId);
	const route = !tier ? (config.routes ?? []).find((r: Route) => r.routeId === planId) : undefined;

	if (!tier && !route) {
		throw new Key0Error("TIER_NOT_FOUND", `Plan or route "${planId}" not found`, 400);
	}

	const unitAmount = tier ? tier.unitAmount! : route!.unitAmount!;
	const description = tier?.description ?? route?.description ?? `${planId} — ${unitAmount} USDC`;
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const resourceUrl = `${baseUrl}/x402/access`;

	const amountRaw = parseDollarToUsdcMicro(unitAmount);
	const network = `eip155:${networkConfig.chainId}`;

	const extensions =
		options?.inputSchema || options?.outputSchema || options?.description
			? {
					key0: {
						...(options.inputSchema && { inputSchema: options.inputSchema }),
						...(options.outputSchema && { outputSchema: options.outputSchema }),
						...(options.description && { description: options.description }),
					},
				}
			: undefined;

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
				maxTimeoutSeconds: config.challengeTTLSeconds ?? 900,
				extra: {
					name: networkConfig.usdcDomain.name,
					version: networkConfig.usdcDomain.version,
					description,
				},
			},
		],
		...(extensions ? { extensions } : {}),
	};
}

/**
 * Build a discovery response covering all product tiers and routes.
 * Used when a bare request is made without specifying a planId.
 * Does not create any PENDING records — pure discovery.
 *
 * Returns a simple flat object: { agentName, description, plans, routes }
 */
export function buildDiscoveryResponse(config: SellerConfig) {
	return {
		agentName: config.agentName,
		description: config.agentDescription,
		plans: (config.plans ?? []).map((p) => ({
			planId: p.planId,
			unitAmount: p.unitAmount,
			...(p.description ? { description: p.description } : {}),
			...(p.free === true ? { free: true } : {}),
		})),
		routes: (config.routes ?? []).map((r) => ({
			routeId: r.routeId,
			method: r.method,
			path: r.path,
			...(r.unitAmount ? { unitAmount: r.unitAmount } : {}),
			...(r.description ? { description: r.description } : {}),
		})),
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

	// STEP 1: Verify (30s timeout)
	const verifyRes = await fetchWithTimeout(
		`${facilitatorUrl}/verify`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(facilitatorRequestBody),
		},
		30_000,
	);

	if (!verifyRes.ok) {
		const errorText = await verifyRes.text().catch(() => "");
		let errorMessage = "Payment verification failed";
		try {
			const errorData = JSON.parse(errorText);
			errorMessage = errorData.message || errorData.error || errorMessage;
		} catch {
			if (errorText) errorMessage = errorText;
		}
		throw new Key0Error("PAYMENT_FAILED", errorMessage, 402);
	}

	const verifyResult = (await verifyRes.json()) as FacilitatorVerifyResponse;
	if (!verifyResult.isValid) {
		throw new Key0Error(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}. ${verifyResult.invalidMessage || ""}`.trim(),
			402,
		);
	}
	if (verifyResult.payer && !payer) payer = verifyResult.payer;

	console.log("[settleViaFacilitator] ✓ Payment verified");

	// STEP 2: Settle (60s timeout, 2 retries with exponential backoff)
	const result = await retryWithBackoff(
		async () => {
			const settleRes = await fetchWithTimeout(
				`${facilitatorUrl}/settle`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(facilitatorRequestBody),
				},
				60_000,
			);

			if (!settleRes.ok) {
				const errorText = await settleRes.text().catch(() => "");
				let errorMessage = "Facilitator settlement failed";
				try {
					const errorData = JSON.parse(errorText);
					errorMessage = errorData.message || errorData.error || errorMessage;
				} catch {
					if (errorText) errorMessage = errorText;
				}
				throw new Key0Error("PAYMENT_FAILED", errorMessage, 402);
			}

			const res = (await settleRes.json()) as X402SettleResponse;
			if (!res.success) {
				throw new Key0Error("PAYMENT_FAILED", res.errorReason || "Payment settlement failed", 402);
			}
			if (!res.transaction) {
				throw new Key0Error("PAYMENT_FAILED", "Facilitator did not return transaction hash", 500);
			}
			return res;
		},
		2,
		500,
	);

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
		throw new Key0Error("INVALID_REQUEST", "Payment payload missing 'accepted' requirement", 400);
	}

	const gasAccount = privateKeyToAccount(privateKey);
	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;
	const walletClient = createWalletClient({
		account: gasAccount,
		chain,
		transport: viemHttp(networkConfig.rpcUrl),
	}).extend(publicActions);

	const scheme = new ExactEvmScheme(walletClient as any, { deployERC4337WithEIP6492: true });

	// STEP 1: Verify (30s timeout)
	let verifyResult: any;
	try {
		let verifyTimer: ReturnType<typeof setTimeout>;
		verifyResult = await Promise.race([
			scheme
				.verify(paymentPayload as any, requirement as any)
				.finally(() => clearTimeout(verifyTimer)),
			new Promise<never>((_, reject) => {
				verifyTimer = setTimeout(() => reject(new Error("Gas wallet verify timed out")), 30_000);
			}),
		]);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Unknown verification error";
		throw new Key0Error("PAYMENT_FAILED", `Payment verification failed: ${msg}`, 402);
	}

	if (!verifyResult.isValid) {
		throw new Key0Error(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}`,
			402,
		);
	}
	if (verifyResult.payer && !payer) payer = verifyResult.payer;

	console.log("[settleViaGasWallet] ✓ Payment verified");

	// STEP 2: Settle (90s timeout — includes on-chain tx confirmation)
	const MAX_SETTLE_ATTEMPTS = 3;
	const isRetryableSettlementError = (message: string): boolean => {
		const normalized = message.toLowerCase();
		return (
			normalized.includes("timed out") ||
			normalized.includes("timeout") ||
			normalized.includes("network") ||
			normalized.includes("fetch failed") ||
			normalized.includes("econn") ||
			normalized.includes("socket") ||
			normalized.includes("503") ||
			normalized.includes("429") ||
			normalized.includes("rate limit") ||
			normalized.includes("temporar")
		);
	};
	let settlement: any;
	for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt++) {
		try {
			let settleTimer: ReturnType<typeof setTimeout>;
			settlement = await Promise.race([
				scheme
					.settle(paymentPayload as any, requirement as any)
					.finally(() => clearTimeout(settleTimer)),
				new Promise<never>((_, reject) => {
					settleTimer = setTimeout(() => reject(new Error("Gas wallet settle timed out")), 90_000);
				}),
			]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown settlement error";
			const shouldRetry = attempt < MAX_SETTLE_ATTEMPTS - 1 && isRetryableSettlementError(msg);
			if (!shouldRetry) {
				throw new Key0Error("PAYMENT_FAILED", `Settlement failed: ${msg}`, 500);
			}

			const retryDelayMs = 1_000 * (attempt + 1);
			console.warn(
				`[settleViaGasWallet] settlement threw retryable error; retrying in ${retryDelayMs}ms (attempt ${attempt + 2}/${MAX_SETTLE_ATTEMPTS}): ${msg}`,
			);
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			continue;
		}

		if (settlement.success && settlement.transaction) {
			break;
		}

		const errorReason = settlement?.errorReason || "Payment settlement failed";
		const shouldRetry = errorReason === "transaction_failed" && attempt < MAX_SETTLE_ATTEMPTS - 1;
		if (!shouldRetry) {
			if (!settlement.success) {
				throw new Key0Error("PAYMENT_FAILED", errorReason, 500);
			}
			throw new Key0Error("PAYMENT_FAILED", "Settlement did not return transaction hash", 500);
		}

		const retryDelayMs = 1_000 * (attempt + 1);
		console.warn(
			`[settleViaGasWallet] settlement returned transaction_failed; retrying in ${retryDelayMs}ms (attempt ${attempt + 2}/${MAX_SETTLE_ATTEMPTS})`,
		);
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
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
 * When gasWalletPrivateKey is set, the call is serialised via
 * {@link withGasWalletLock} so that settlements and refund-cron sendUsdc calls
 * from the same gas wallet never overlap (preventing nonce conflicts).
 *
 * Used by:
 * - HTTP middleware (after decoding the PAYMENT-SIGNATURE header)
 * - A2A executor (payload already decoded from message metadata)
 * - MCP tool handler
 */
export async function settlePayment(
	paymentPayload: X402PaymentPayload,
	config: SellerConfig,
	networkConfig: NetworkConfig,
): Promise<SettlementResult> {
	if (config.gasWalletPrivateKey) {
		const privateKey = config.gasWalletPrivateKey;
		const lockKey = gasWalletLockKey(privateKeyToAccount(privateKey).address);

		return withGasWalletLock(
			() => settleViaGasWallet(paymentPayload, privateKey, networkConfig),
			config.redis,
			lockKey,
		);
	}

	const facilitatorUrl = config.facilitatorUrl ?? networkConfig.facilitatorUrl;
	return settleViaFacilitator(paymentPayload, facilitatorUrl);
}
