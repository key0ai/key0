import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { NextFunction, Request, Response } from "express";
import { createWalletClient, publicActions, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type { ChallengeEngine } from "../core/index.js";
import { CHAIN_CONFIGS } from "../types/config-shared.js";
import type {
	AccessGrant,
	AccessRequest,
	FacilitatorVerifyResponse,
	NetworkConfig,
	ProductTier,
	SellerConfig,
	X402PaymentRequiredResponse,
	X402SettleResponse,
} from "../types/index.js";
import { AgentGateError, CHAIN_ID_TO_NETWORK } from "../types/index.js";

// x402 v2 headers
const PAYMENT_SIGNATURE_HEADER = "payment-signature";
const PAYMENT_REQUIRED_HEADER = "payment-required";
const PAYMENT_RESPONSE_HEADER = "payment-response";
const X_A2A_EXTENSIONS_HEADER = "x-a2a-extensions";

/**
 * Build the HTTP 402 PaymentRequirements response body.
 * This is what the client receives when they make an AccessRequest without X-Payment.
 */
export function buildHttpPaymentRequirements(
	tierId: string,
	resourceId: string,
	config: SellerConfig,
	networkConfig: NetworkConfig,
): X402PaymentRequiredResponse {
	// Find the tier
	const tier = config.products.find((t: ProductTier) => t.tierId === tierId);
	if (!tier) {
		throw new AgentGateError("TIER_NOT_FOUND", `Tier "${tierId}" not found`, 400);
	}

	const basePath = config.basePath ?? "/a2a";
	const baseUrl = config.agentUrl.replace(/\/$/, "");
	const resourceUrl = `${baseUrl}${basePath}/jsonrpc`;

	const amountRaw = parseDollarToUsdcMicro(tier.amount);
	// x402 v2: Use CAIP-2 format for network
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
				network: network,
				asset: networkConfig.usdcAddress,
				amount: amountRaw.toString(),
				payTo: config.walletAddress,
				maxTimeoutSeconds: 300, // 5 minutes
				extra: {
					name: networkConfig.usdcDomain.name,
					version: networkConfig.usdcDomain.version,
					description: `${tier.label} — ${tier.amount} USDC`,
				},
			},
		],
	};
}

/**
 * Settle an EIP-3009 payment via the Coinbase facilitator.
 * The facilitator executes the transferWithAuthorization on-chain and returns the txHash.
 */
export async function settleViaFacilitator(
	paymentSignature: string,
	facilitatorUrl: string,
): Promise<{ txHash: `0x${string}`; settleResponse: X402SettleResponse; payer?: string }> {
	console.log("[settleViaFacilitator] Starting settlement...");
	console.log(`[settleViaFacilitator] Facilitator URL: ${facilitatorUrl}`);

	// Decode the PAYMENT-SIGNATURE header (base64url)
	let paymentPayload: any;
	try {
		console.log("[settleViaFacilitator] Decoding PAYMENT-SIGNATURE header (base64url)...");
		const decoded = Buffer.from(paymentSignature, "base64url").toString("utf-8");
		paymentPayload = JSON.parse(decoded);
		console.log(
			"[settleViaFacilitator] ✓ Decoded payload:",
			JSON.stringify(paymentPayload, null, 2),
		);
	} catch (err) {
		// Try regular base64 as fallback
		console.log("[settleViaFacilitator] base64url decode failed, trying regular base64...");
		try {
			const decoded = Buffer.from(paymentSignature, "base64").toString("utf-8");
			paymentPayload = JSON.parse(decoded);
			console.log(
				"[settleViaFacilitator] ✓ Decoded payload (base64):",
				JSON.stringify(paymentPayload, null, 2),
			);
		} catch {
			console.error("[settleViaFacilitator] ✗ Failed to decode PAYMENT-SIGNATURE header");
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Invalid PAYMENT-SIGNATURE header: must be base64url-encoded JSON",
				400,
			);
		}
	}

	// Extract payer from payload (v2 structure: payload.payload.authorization.from)
	let payer: string | undefined;
	try {
		if (paymentPayload.payload?.authorization?.from) {
			payer = paymentPayload.payload.authorization.from;
			console.log(`[settleViaFacilitator] Extracted payer: ${payer}`);
		}
	} catch {
		console.log("[settleViaFacilitator] Could not extract payer from payload");
	}

	// Extract payment requirements from the payload
	const paymentRequirements = paymentPayload.accepted;

	// Build the facilitator request body according to API spec
	const facilitatorRequestBody = {
		paymentPayload: paymentPayload,
		paymentRequirements: paymentRequirements,
	};

	// STEP 1: Verify the payment
	console.log("[settleViaFacilitator] STEP 1: Verifying payment...");
	console.log(
		"[settleViaFacilitator] Verify request body:",
		JSON.stringify(facilitatorRequestBody, null, 2),
	);

	const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(facilitatorRequestBody),
	});
	console.log(
		`[settleViaFacilitator] Verify response status: ${verifyRes.status} ${verifyRes.statusText}`,
	);

	if (!verifyRes.ok) {
		const errorText = await verifyRes.text().catch(() => "");
		console.error(`[settleViaFacilitator] ✗ Verify error response: ${errorText}`);
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
	console.log(
		"[settleViaFacilitator] Verify response body:",
		JSON.stringify(verifyResult, null, 2),
	);

	// Check if payment is valid
	if (!verifyResult.isValid) {
		console.error(
			`[settleViaFacilitator] ✗ Payment verification failed: ${verifyResult.invalidReason}`,
		);
		throw new AgentGateError(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}. ${verifyResult.invalidMessage || "unknown reason"}`,
			402,
		);
	}

	console.log("[settleViaFacilitator] ✓ Payment verified successfully");

	// Update payer if we got it from verify response
	if (verifyResult.payer && !payer) {
		payer = verifyResult.payer;
		console.log(`[settleViaFacilitator] Updated payer from verify response: ${payer}`);
	}

	// STEP 2: Settle the payment
	console.log("[settleViaFacilitator] STEP 2: Settling payment...");
	console.log(
		"[settleViaFacilitator] Settle request body:",
		JSON.stringify(facilitatorRequestBody, null, 2),
	);

	const settleRes = await fetch(`${facilitatorUrl}/settle`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(facilitatorRequestBody),
	});
	console.log(
		`[settleViaFacilitator] Settle response status: ${settleRes.status} ${settleRes.statusText}`,
	);

	if (!settleRes.ok) {
		const errorText = await settleRes.text().catch(() => "");
		console.error(`[settleViaFacilitator] ✗ Settlement error response: ${errorText}`);
		let errorMessage = "Facilitator settlement failed";
		try {
			const errorData = JSON.parse(errorText);
			errorMessage = errorData.message || errorData.error || errorMessage;
		} catch {
			// Use the raw text if it's not JSON
			if (errorText) errorMessage = errorText;
		}
		throw new AgentGateError("PAYMENT_FAILED", errorMessage, 402);
	}

	const result = (await settleRes.json()) as X402SettleResponse;
	console.log("[settleViaFacilitator] Settlement response body:", JSON.stringify(result, null, 2));

	// Check success flag
	if (!result.success) {
		console.error(`[settleViaFacilitator] ✗ Settlement failed: ${result.errorReason}`);
		throw new AgentGateError(
			"PAYMENT_FAILED",
			result.errorReason || "Payment settlement failed",
			402,
		);
	}

	if (!result.transaction) {
		console.error("[settleViaFacilitator] ✗ No transaction hash in response");
		throw new AgentGateError("PAYMENT_FAILED", "Facilitator did not return transaction hash", 500);
	}

	console.log(`[settleViaFacilitator] ✓ Settlement successful, txHash: ${result.transaction}`);
	return {
		txHash: result.transaction as `0x${string}`,
		settleResponse: result,
		...(payer && { payer }),
	};
}

/**
 * Settle an EIP-3009 payment via gas wallet (self-contained mode using ExactEvmScheme).
 * The gas wallet pays for on-chain execution and settles the payment directly.
 */
export async function settleViaGasWallet(
	paymentSignature: string,
	privateKey: `0x${string}`,
	networkConfig: NetworkConfig,
): Promise<{ txHash: `0x${string}`; settleResponse: X402SettleResponse; payer?: string }> {
	console.log("[settleViaGasWallet] Starting settlement...");
	console.log(
		`[settleViaGasWallet] Network: ${networkConfig.name} (chainId: ${networkConfig.chainId})`,
	);

	// Decode the PAYMENT-SIGNATURE header (base64url)
	let paymentPayload: any;
	try {
		console.log("[settleViaGasWallet] Decoding PAYMENT-SIGNATURE header (base64url)...");
		const decoded = Buffer.from(paymentSignature, "base64url").toString("utf-8");
		paymentPayload = JSON.parse(decoded);
		console.log("[settleViaGasWallet] ✓ Decoded payload:", JSON.stringify(paymentPayload, null, 2));
	} catch (err) {
		// Try regular base64 as fallback
		console.log("[settleViaGasWallet] base64url decode failed, trying regular base64...");
		try {
			const decoded = Buffer.from(paymentSignature, "base64").toString("utf-8");
			paymentPayload = JSON.parse(decoded);
			console.log(
				"[settleViaGasWallet] ✓ Decoded payload (base64):",
				JSON.stringify(paymentPayload, null, 2),
			);
		} catch {
			console.error("[settleViaGasWallet] ✗ Failed to decode PAYMENT-SIGNATURE header");
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Invalid PAYMENT-SIGNATURE header: must be base64url-encoded JSON",
				400,
			);
		}
	}

	// Extract payer from payload (v2 structure: payload.payload.authorization.from)
	let payer: string | undefined;
	try {
		if (paymentPayload.payload?.authorization?.from) {
			payer = paymentPayload.payload.authorization.from;
			console.log(`[settleViaGasWallet] Extracted payer: ${payer}`);
		}
	} catch {
		console.log("[settleViaGasWallet] Could not extract payer from payload");
	}

	// Create wallet client from private key
	console.log("[settleViaGasWallet] Creating wallet client from private key...");
	const gasAccount = privateKeyToAccount(privateKey);
	console.log(`[settleViaGasWallet] Gas account address: ${gasAccount.address}`);

	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;
	const walletClient = createWalletClient({
		account: gasAccount,
		chain,
		transport: viemHttp(networkConfig.rpcUrl),
	}).extend(publicActions);

	// Create ExactEvmScheme instance
	console.log("[settleViaGasWallet] Initializing ExactEvmScheme...");
	const scheme = new ExactEvmScheme(walletClient as any, {
		deployERC4337WithEIP6492: true, // Enable smart wallet deployment for ERC-6492 signatures
	});

	// Extract requirement from payload
	const requirement = paymentPayload.accepted;
	if (!requirement) {
		console.error("[settleViaGasWallet] ✗ No payment requirement found in payload");
		throw new AgentGateError(
			"INVALID_REQUEST",
			"Payment signature missing 'accepted' requirement",
			400,
		);
	}

	console.log("[settleViaGasWallet] Payment requirement:", JSON.stringify(requirement, null, 2));

	// STEP 1: Verify the payment
	console.log("\n[settleViaGasWallet] STEP 1: Verifying payment...");
	let verifyResult: any;
	try {
		verifyResult = await scheme.verify(paymentPayload, requirement);
		console.log("[settleViaGasWallet] Verify result:", JSON.stringify(verifyResult, null, 2));
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : "Unknown verification error";
		console.error(`[settleViaGasWallet] ✗ Verify error: ${errorMessage}`);
		throw new AgentGateError("PAYMENT_FAILED", `Payment verification failed: ${errorMessage}`, 402);
	}

	if (!verifyResult.isValid) {
		console.error(
			`[settleViaGasWallet] ✗ Payment verification failed: ${verifyResult.invalidReason}`,
		);
		throw new AgentGateError(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}`,
			402,
		);
	}

	console.log("[settleViaGasWallet] ✓ Payment verified successfully");

	// Update payer if we got it from verify response
	if (verifyResult.payer && !payer) {
		payer = verifyResult.payer;
		console.log(`[settleViaGasWallet] Updated payer from verify response: ${payer}`);
	}

	// STEP 2: Settle the payment
	console.log("\n[settleViaGasWallet] STEP 2: Settling payment on-chain...");
	let settlement: any;
	try {
		settlement = await scheme.settle(paymentPayload, requirement);
		console.log("[settleViaGasWallet] Settlement response:", JSON.stringify(settlement, null, 2));
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : "Unknown settlement error";
		console.error(`[settleViaGasWallet] ✗ Settlement exception: ${errorMessage}`);
		console.error("[settleViaGasWallet] Full error:", e);
		throw new AgentGateError("PAYMENT_FAILED", `Settlement failed: ${errorMessage}`, 500);
	}

	if (!settlement.success) {
		console.error(`[settleViaGasWallet] ✗ Settlement failed: ${settlement.errorReason}`);
		if (settlement.errorMessage) {
			console.error(`[settleViaGasWallet] Error message: ${settlement.errorMessage}`);
		}
		if (settlement.transaction) {
			console.error(`[settleViaGasWallet] Failed tx: ${settlement.transaction}`);
			console.error(
				`[settleViaGasWallet] Explorer: ${networkConfig.explorerBaseUrl}/tx/${settlement.transaction}`,
			);
		}
		throw new AgentGateError(
			"PAYMENT_FAILED",
			settlement.errorReason || "Payment settlement failed",
			500,
		);
	}

	if (!settlement.transaction) {
		console.error("[settleViaGasWallet] ✗ No transaction hash in response");
		throw new AgentGateError("PAYMENT_FAILED", "Settlement did not return transaction hash", 500);
	}

	console.log(`[settleViaGasWallet] ✓ Settlement successful, txHash: ${settlement.transaction}`);
	console.log(
		`[settleViaGasWallet] Explorer: ${networkConfig.explorerBaseUrl}/tx/${settlement.transaction}`,
	);

	// Build response matching facilitator format
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

/**
 * Express middleware that intercepts AccessRequest calls and implements the x402 HTTP flow.
 *
 * If the client sends X-A2A-Extensions header -> pass through (A2A flow)
 * If the client sends AccessRequest without X-Payment -> return HTTP 402 with PaymentRequirements
 * If the client sends AccessRequest with X-Payment -> settle via facilitator, return HTTP 200 with AccessGrant
 */
export function createX402HttpMiddleware(engine: ChallengeEngine, config: SellerConfig) {
	const networkConfig = CHAIN_CONFIGS[config.network];

	return async (req: Request, res: Response, next: NextFunction) => {
		console.log("\n[x402-http-middleware] ========== NEW REQUEST ==========");
		console.log("[x402-http-middleware] Method:", req.method);
		console.log("[x402-http-middleware] Path:", req.path);
		console.log("[x402-http-middleware] Headers:", JSON.stringify(req.headers, null, 2));

		// Intercept response to log the body
		const originalJson = res.json.bind(res);
		const originalSend = res.send.bind(res);

		res.json = (body: any) => {
			console.log("[x402-http-middleware] Response Status:", res.statusCode);
			console.log("[x402-http-middleware] Response Body:", JSON.stringify(body, null, 2));
			return originalJson(body);
		};

		res.send = (body: any) => {
			console.log("[x402-http-middleware] Response Status:", res.statusCode);
			console.log(
				"[x402-http-middleware] Response Body:",
				typeof body === "string" ? body : JSON.stringify(body, null, 2),
			);
			return originalSend(body);
		};

		try {
			// 1. If X-A2A-Extensions header present, this is an A2A client -> pass through
			const hasA2AExtensions = req.headers[X_A2A_EXTENSIONS_HEADER];
			console.log(`[x402-http-middleware] X-A2A-Extensions header present: ${!!hasA2AExtensions}`);
			if (hasA2AExtensions) {
				console.log("[x402-http-middleware] → Passing through to A2A JSON-RPC handler");
				return next();
			}

			// 2. Parse JSON-RPC body
			const body = req.body;
			console.log("[x402-http-middleware] Body:", JSON.stringify(body, null, 2));
			if (!body || typeof body !== "object") {
				console.log("[x402-http-middleware] → No valid body, passing through");
				return next();
			}

			// 3. Check if this is a message/send call
			console.log(`[x402-http-middleware] Method in body: ${body.method}`);
			if (body.method !== "message/send") {
				console.log("[x402-http-middleware] → Not a message/send call, passing through");
				return next();
			}

			// 4. Extract AccessRequest from message parts
			const params = body.params;
			if (!params || !params.message || !params.message.parts) {
				console.log("[x402-http-middleware] → No valid message parts, passing through");
				return next();
			}

			let accessRequest: AccessRequest | null = null;

			// Try to find AccessRequest in data parts
			console.log(`[x402-http-middleware] Parsing ${params.message.parts.length} message parts...`);
			for (const part of params.message.parts) {
				console.log(`[x402-http-middleware] - Part kind: ${part.kind}`);
				if (part.kind === "data" && part.data?.type === "AccessRequest") {
					accessRequest = part.data as AccessRequest;
					console.log("[x402-http-middleware] ✓ Found AccessRequest in data part");
					break;
				}
				// Also try parsing from text parts (JSON string)
				if (part.kind === "text") {
					try {
						const parsed = JSON.parse(part.text);
						if (parsed.type === "AccessRequest") {
							accessRequest = parsed as AccessRequest;
							console.log("[x402-http-middleware] ✓ Found AccessRequest in text part");
							break;
						}
					} catch {
						// Not valid JSON or not an AccessRequest
						continue;
					}
				}
			}

			// If no AccessRequest found, pass through
			if (!accessRequest) {
				console.log("[x402-http-middleware] → No AccessRequest found, passing through");
				return next();
			}

			// 5. Provide defaults for optional fields
			const resourceId = accessRequest.resourceId || "default";
			const tierId = accessRequest.tierId;
			const requestId = accessRequest.requestId || `http-${crypto.randomUUID()}`;
			console.log(
				`[x402-http-middleware] AccessRequest: tierId=${tierId}, resourceId=${resourceId}, requestId=${requestId}`,
			);

			// 6. Check for PAYMENT-SIGNATURE header (v2)
			const paymentSignature = req.headers[PAYMENT_SIGNATURE_HEADER] as string | undefined;
			console.log(`[x402-http-middleware] PAYMENT-SIGNATURE header present: ${!!paymentSignature}`);

			if (!paymentSignature) {
				// ===== STEP 1: No payment yet -> create PENDING record and return HTTP 402 =====
				console.log(
					"[x402-http-middleware] → STEP 1: No PAYMENT-SIGNATURE header, issuing 402 challenge",
				);

				// Create PENDING record via engine (handles tier/resource validation and idempotency)
				const { challengeId } = await engine.requestHttpAccess(requestId, tierId, resourceId);
				console.log(`[x402-http-middleware] ✓ PENDING record created, challengeId=${challengeId}`);

				// Build payment requirements
				console.log("[x402-http-middleware] Building payment requirements...");
				const requirements = buildHttpPaymentRequirements(
					tierId,
					resourceId,
					config,
					networkConfig,
				);
				console.log(
					"[x402-http-middleware] Payment requirements:",
					JSON.stringify(requirements, null, 2),
				);

				// x402 v2: Set PAYMENT-REQUIRED header with base64-encoded requirements
				const base64Requirements = Buffer.from(JSON.stringify(requirements)).toString("base64");
				res.setHeader(PAYMENT_REQUIRED_HEADER, base64Requirements);
				console.log("[x402-http-middleware] Set PAYMENT-REQUIRED header");

				// Return HTTP 402 with payment requirements + challengeId
				console.log("[x402-http-middleware] → Returning HTTP 402 with payment requirements");
				return res.status(402).json({
					...requirements,
					challengeId,
					error: "PAYMENT-SIGNATURE header is required",
				});
			}
			// ===== STEP 2: Has PAYMENT-SIGNATURE -> settle and return access grant =====
			console.log(
				"[x402-http-middleware] → STEP 2: PAYMENT-SIGNATURE header present, processing payment",
			);
			console.log(
				`[x402-http-middleware] PAYMENT-SIGNATURE value (first 50 chars): ${paymentSignature.substring(0, 50)}...`,
			);

			// Route to appropriate settlement strategy
			let txHash: `0x${string}`;
			let settleResponse: X402SettleResponse;
			let payer: string | undefined;

			if (config.gasWalletPrivateKey) {
				// Gas wallet mode: self-contained settlement via ExactEvmScheme
				console.log("[x402-http-middleware] Using gas wallet settlement mode");
				const result = await settleViaGasWallet(
					paymentSignature,
					config.gasWalletPrivateKey,
					networkConfig,
				);
				txHash = result.txHash;
				settleResponse = result.settleResponse;
				payer = result.payer;
			} else {
				// Facilitator mode: HTTP-based settlement via Coinbase CDP
				const resolvedFacilitatorUrl = config.facilitatorUrl ?? networkConfig.facilitatorUrl;
				console.log(
					`[x402-http-middleware] Using facilitator settlement mode: ${resolvedFacilitatorUrl}`,
				);
				const result = await settleViaFacilitator(paymentSignature, resolvedFacilitatorUrl);
				txHash = result.txHash;
				settleResponse = result.settleResponse;
				payer = result.payer;
			}

			console.log(`[x402-http-middleware] ✓ Payment settled, txHash: ${txHash}`);

			// Process payment with full lifecycle tracking (PENDING → PAID → DELIVERED)
			console.log("[x402-http-middleware] Processing HTTP payment and issuing token...");
			const grant: AccessGrant = await engine.processHttpPayment(
				requestId,
				tierId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);
			console.log("[x402-http-middleware] ✓ Access grant issued:", JSON.stringify(grant, null, 2));

			// x402 v2: Build settlement response for PAYMENT-RESPONSE header
			const settlementResponse: X402SettleResponse = {
				success: true,
				transaction: txHash,
				network: `eip155:${networkConfig.chainId}`,
				...(payer && { payer }),
			};
			const base64Settlement = Buffer.from(JSON.stringify(settlementResponse)).toString("base64");
			res.setHeader(PAYMENT_RESPONSE_HEADER, base64Settlement);
			console.log("[x402-http-middleware] Set PAYMENT-RESPONSE header");

			// Return HTTP 200 with AccessGrant
			console.log("[x402-http-middleware] → Returning HTTP 200 with AccessGrant");
			return res.status(200).json(grant);
		} catch (err: unknown) {
			console.error("[x402-http-middleware] ✗ ERROR caught in middleware:", err);
			if (err instanceof AgentGateError) {
				console.error("[x402-http-middleware] AgentGateError:", err.toJSON());
				return res.status(err.httpStatus).json(err.toJSON());
			}
			// Unknown error
			console.error("[x402-http-middleware] Unexpected error:", err);
			return res.status(500).json({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			console.log("[x402-http-middleware] ========== REQUEST COMPLETE ==========\n");
		}
	};
}
