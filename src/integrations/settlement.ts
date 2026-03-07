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
 * Build the HTTP 402 PaymentRequirements response body for a single tier.
 * Shared between the HTTP middleware and the A2A executor.
 */
export function buildHttpPaymentRequirements(
	tierId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
	options?: {
		inputSchema?: object;
		outputSchema?: object;
		description?: string;
	},
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

	const extensions =
		options?.inputSchema || options?.outputSchema || options?.description
			? {
					agentgate: {
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
				maxTimeoutSeconds: 300,
				extra: {
					name: networkConfig.usdcDomain.name,
					version: networkConfig.usdcDomain.version,
					description: `${tier.label} — ${tier.amount} USDC`,
				},
			},
		],
		...(extensions ? { extensions } : {}),
	};
}

/**
 * Build a discovery 402 response covering all product tiers.
 * Used when a bare request is made without specifying a tierId.
 * Does not create any PENDING records — pure discovery.
 */
export function buildDiscoveryResponse(
	config: SellerConfig,
	networkConfig: NetworkConfig,
): X402PaymentRequiredResponse {
	const _basePath = config.basePath ?? "/a2a";
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const resourceUrl = `${baseUrl}/x402/access`;

	const network = `eip155:${networkConfig.chainId}`;

	// Build accepts array with one entry per tier
	const accepts = config.products.map((tier: ProductTier) => {
		const amountRaw = parseDollarToUsdcMicro(tier.amount);
		return {
			scheme: "exact" as const,
			network,
			asset: networkConfig.usdcAddress,
			amount: amountRaw.toString(),
			payTo: config.walletAddress,
			maxTimeoutSeconds: 300,
			extra: {
				name: networkConfig.usdcDomain.name,
				version: networkConfig.usdcDomain.version,
				tierId: tier.tierId,
				label: tier.label,
				description: `${tier.label} — ${tier.amount} USDC`,
			},
		};
	});

	return {
		x402Version: 2,
		resource: {
			url: resourceUrl,
			method: "POST",
			description: `${config.agentName} — Pay-per-use access with USDC. POST with { tierId } to start a payment flow, or POST with { tierId, requestId } + PAYMENT-SIGNATURE header to complete payment.`,
			mimeType: "application/json",
		},
		accepts,
		extensions: {
			agentgate: {
				inputSchema: {
					type: "object",
					properties: {
						tierId: {
							type: "string",
							description: `Tier to purchase. Available tiers: ${config.products.map((t) => t.tierId).join(", ")}`,
						},
						requestId: {
							type: "string",
							description: "Client-generated UUID for idempotency (auto-generated if omitted)",
						},
						resourceId: {
							type: "string",
							description: "Optional: Specific resource identifier (defaults to 'default')",
						},
					},
					required: ["tierId"],
				},
				outputSchema: {
					type: "object",
					properties: {
						accessToken: { type: "string", description: "JWT token for API access" },
						tokenType: { type: "string", description: "Token type (usually 'Bearer')" },
						expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
						resourceEndpoint: {
							type: "string",
							description: "URL to access the protected resource",
						},
						txHash: { type: "string", description: "On-chain transaction hash" },
						explorerUrl: { type: "string", description: "Blockchain explorer URL" },
					},
				},
				description: `${config.agentDescription}`,
			},
		},
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
// Distributed lock helpers (Redis SET NX / Lua release)
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 60_000; // 60s — longer than any reasonable settlement
const LOCK_POLL_MS = 200; // retry interval while waiting for lock
// Lua script: delete the key only if its value matches our token (atomic)
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function acquireRedisLock(
	redis: import("../types/config.js").IRedisLockClient,
	key: string,
	token: string,
): Promise<void> {
	while (true) {
		const ok = await redis.set(key, token, "NX", "PX", LOCK_TTL_MS);
		if (ok === "OK") return;
		await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
	}
}

async function releaseRedisLock(
	redis: import("../types/config.js").IRedisLockClient,
	key: string,
	token: string,
): Promise<void> {
	await redis.eval(RELEASE_LUA, 1, key, token);
}

// ---------------------------------------------------------------------------
// In-process fallback queue (single-instance only)
// ---------------------------------------------------------------------------

// Used when no Redis client is configured — serializes settlements within
// the current process. Does NOT protect against nonce conflicts across
// multiple instances; set config.redis for multi-instance deployments.
let gasWalletSettleQueue: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// Unified settlement entry point
// ---------------------------------------------------------------------------

/**
 * Settle a payment using the appropriate strategy (gas wallet or facilitator),
 * determined by the seller config. Accepts an already-decoded X402PaymentPayload.
 *
 * When gasWalletPrivateKey is set:
 *   - With config.redis: uses a distributed Redis lock so concurrent settlements
 *     across multiple instances are serialized (prevents nonce conflicts).
 *   - Without config.redis: falls back to an in-process serial queue (single
 *     instance only).
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
		const privateKey = config.gasWalletPrivateKey;

		if (config.redis) {
			// Distributed lock — safe across multiple instances
			const lockKey = `agentgate:settle-lock:${privateKey.slice(0, 10)}`;
			const lockToken = crypto.randomUUID();
			await acquireRedisLock(config.redis, lockKey, lockToken);
			try {
				return await settleViaGasWallet(paymentPayload, privateKey, networkConfig);
			} finally {
				await releaseRedisLock(config.redis, lockKey, lockToken);
			}
		}

		// In-process fallback — single instance only
		const result = gasWalletSettleQueue.then(() =>
			settleViaGasWallet(paymentPayload, privateKey, networkConfig),
		);
		gasWalletSettleQueue = result.catch(() => {});
		return result;
	}

	const facilitatorUrl = config.facilitatorUrl ?? networkConfig.facilitatorUrl;
	return settleViaFacilitator(paymentPayload, facilitatorUrl);
}
