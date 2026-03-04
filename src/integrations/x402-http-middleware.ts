import type { NextFunction, Request, Response } from "express";
import type { ChallengeEngine } from "../core/index.js";
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
import { parseDollarToUsdcMicro } from "../adapter/index.js";
import { CHAIN_CONFIGS } from "../types/config-shared.js";
import { createWalletClient, http as viemHttp, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

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

/**
 * Settle an EIP-3009 payment via the Coinbase facilitator.
 * The facilitator executes the transferWithAuthorization on-chain and returns the txHash.
 */
export async function settleViaFacilitator(
	paymentSignature: string,
	facilitatorUrl: string,
): Promise<{ txHash: `0x${string}`; settleResponse: X402SettleResponse; payer?: string }> {
	let paymentPayload: any;
	try {
		paymentPayload = JSON.parse(Buffer.from(paymentSignature, "base64url").toString("utf-8"));
	} catch {
		try {
			paymentPayload = JSON.parse(Buffer.from(paymentSignature, "base64").toString("utf-8"));
		} catch {
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Invalid PAYMENT-SIGNATURE header: must be base64url-encoded JSON",
				400,
			);
		}
	}

	let payer: string | undefined;
	if (paymentPayload.payload?.authorization?.from) {
		payer = paymentPayload.payload.authorization.from;
	}

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

	if (verifyResult.payer && !payer) {
		payer = verifyResult.payer;
	}

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
		throw new AgentGateError("PAYMENT_FAILED", result.errorReason || "Payment settlement failed", 402);
	}

	if (!result.transaction) {
		throw new AgentGateError("PAYMENT_FAILED", "Facilitator did not return transaction hash", 500);
	}

	return {
		txHash: result.transaction as `0x${string}`,
		settleResponse: result,
		...(payer && { payer }),
	};
}

/**
 * Settle an EIP-3009 payment via gas wallet (self-contained mode using ExactEvmScheme).
 */
export async function settleViaGasWallet(
	paymentSignature: string,
	privateKey: `0x${string}`,
	networkConfig: NetworkConfig,
): Promise<{ txHash: `0x${string}`; settleResponse: X402SettleResponse; payer?: string }> {
	let paymentPayload: any;
	try {
		paymentPayload = JSON.parse(Buffer.from(paymentSignature, "base64url").toString("utf-8"));
	} catch {
		try {
			paymentPayload = JSON.parse(Buffer.from(paymentSignature, "base64").toString("utf-8"));
		} catch {
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Invalid PAYMENT-SIGNATURE header: must be base64url-encoded JSON",
				400,
			);
		}
	}

	let payer: string | undefined;
	if (paymentPayload.payload?.authorization?.from) {
		payer = paymentPayload.payload.authorization.from;
	}

	const gasAccount = privateKeyToAccount(privateKey);
	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;
	const walletClient = createWalletClient({
		account: gasAccount,
		chain,
		transport: viemHttp(networkConfig.rpcUrl),
	}).extend(publicActions);

	const scheme = new ExactEvmScheme(walletClient as any, {
		deployERC4337WithEIP6492: true,
	});

	const requirement = paymentPayload.accepted;
	if (!requirement) {
		throw new AgentGateError("INVALID_REQUEST", "Payment signature missing 'accepted' requirement", 400);
	}

	// STEP 1: Verify
	let verifyResult: any;
	try {
		verifyResult = await scheme.verify(paymentPayload, requirement);
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : "Unknown verification error";
		throw new AgentGateError("PAYMENT_FAILED", `Payment verification failed: ${errorMessage}`, 402);
	}

	if (!verifyResult.isValid) {
		throw new AgentGateError(
			"PAYMENT_FAILED",
			`Payment verification failed: ${verifyResult.invalidReason || "unknown reason"}`,
			402,
		);
	}

	if (verifyResult.payer && !payer) {
		payer = verifyResult.payer;
	}

	// STEP 2: Settle
	let settlement: any;
	try {
		settlement = await scheme.settle(paymentPayload, requirement);
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : "Unknown settlement error";
		throw new AgentGateError("PAYMENT_FAILED", `Settlement failed: ${errorMessage}`, 500);
	}

	if (!settlement.success) {
		throw new AgentGateError("PAYMENT_FAILED", settlement.errorReason || "Payment settlement failed", 500);
	}

	if (!settlement.transaction) {
		throw new AgentGateError("PAYMENT_FAILED", "Settlement did not return transaction hash", 500);
	}

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
 * If the client sends AccessRequest without payment-signature -> return HTTP 402 with PaymentRequirements
 * If the client sends AccessRequest with payment-signature -> settle, return HTTP 200 with AccessGrant
 */
export function createX402HttpMiddleware(engine: ChallengeEngine, config: SellerConfig) {
	const networkConfig = CHAIN_CONFIGS[config.network];

	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			// 1. If X-A2A-Extensions header present, this is an A2A client -> pass through
			if (req.headers[X_A2A_EXTENSIONS_HEADER]) {
				return next();
			}

			// 2. Parse JSON-RPC body
			const body = req.body;
			if (!body || typeof body !== "object") {
				return next();
			}

			// 3. Only intercept message/send
			if (body.method !== "message/send") {
				return next();
			}

			// 4. Extract AccessRequest from message parts
			const params = body.params;
			if (!params?.message?.parts) {
				return next();
			}

			let accessRequest: AccessRequest | null = null;
			for (const part of params.message.parts) {
				if (part.kind === "data" && part.data?.type === "AccessRequest") {
					accessRequest = part.data as AccessRequest;
					break;
				}
				if (part.kind === "text") {
					try {
						const parsed = JSON.parse(part.text);
						if (parsed.type === "AccessRequest") {
							accessRequest = parsed as AccessRequest;
							break;
						}
					} catch {
						continue;
					}
				}
			}

			if (!accessRequest) {
				return next();
			}

			const resourceId = accessRequest.resourceId || "default";
			const tierId = accessRequest.tierId;

			// 5. Check for payment-signature header (x402 v2)
			const paymentSignature = req.headers[PAYMENT_SIGNATURE_HEADER] as string | undefined;

			if (!paymentSignature) {
				// No payment yet -> validate tier + resource, return HTTP 402
				const tier = config.products.find((t: ProductTier) => t.tierId === tierId);
				if (!tier) {
					return res.status(400).json({
						error: "TIER_NOT_FOUND",
						message: `Tier "${tierId}" not found in product catalog`,
					});
				}

				try {
					const timeoutMs = config.resourceVerifyTimeoutMs ?? 5000;
					const exists = await Promise.race([
						config.onVerifyResource(resourceId, tierId),
						new Promise<never>((_, reject) =>
							setTimeout(
								() => reject(new Error("Resource verification timed out")),
								timeoutMs,
							),
						),
					]);

					if (!exists) {
						return res.status(404).json({
							error: "RESOURCE_NOT_FOUND",
							message: `Resource "${resourceId}" not found or not available for tier "${tierId}"`,
						});
					}
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : "Resource verification failed";
					return res.status(504).json({ error: "RESOURCE_VERIFY_TIMEOUT", message });
				}

				const requirements = buildHttpPaymentRequirements(tierId, resourceId, config, networkConfig);

				// x402 v2: Set payment-required header with base64-encoded requirements
				res.setHeader(PAYMENT_REQUIRED_HEADER, Buffer.from(JSON.stringify(requirements)).toString("base64"));

				return res.status(402).json({
					...requirements,
					error: "payment-signature header is required",
				});
			}

			// Has payment-signature -> settle and issue token
			let txHash: `0x${string}`;
			let settleResponse: X402SettleResponse;
			let payer: string | undefined;

			if (config.gasWalletPrivateKey) {
				const result = await settleViaGasWallet(paymentSignature, config.gasWalletPrivateKey, networkConfig);
				txHash = result.txHash;
				settleResponse = result.settleResponse;
				payer = result.payer;
			} else {
				const resolvedFacilitatorUrl = config.facilitatorUrl ?? networkConfig.facilitatorUrl;
				const result = await settleViaFacilitator(paymentSignature, resolvedFacilitatorUrl);
				txHash = result.txHash;
				settleResponse = result.settleResponse;
				payer = result.payer;
			}

			const grant: AccessGrant = await engine.processHttpPayment(tierId, resourceId, txHash);

			// x402 v2: Set payment-response header with settlement info
			const settlementResponse: X402SettleResponse = {
				success: true,
				transaction: txHash,
				network: `eip155:${networkConfig.chainId}`,
				...(payer && { payer }),
			};
			res.setHeader(PAYMENT_RESPONSE_HEADER, Buffer.from(JSON.stringify(settlementResponse)).toString("base64"));

			return res.status(200).json(grant);
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				return res.status(err.httpStatus).json(err.toJSON());
			}
			return res.status(500).json({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		}
	};
}
