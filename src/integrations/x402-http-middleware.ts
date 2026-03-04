import type { NextFunction, Request, Response } from "express";
import type { ChallengeEngine } from "../core/index.js";
import { CHAIN_CONFIGS } from "../types/config-shared.js";
import type {
	AccessGrant,
	AccessRequest,
	SellerConfig,
	X402SettleResponse,
} from "../types/index.js";
import { AgentGateError } from "../types/index.js";
import {
	buildHttpPaymentRequirements,
	decodePaymentSignature,
	settlePayment,
} from "./settlement.js";

// x402 v2 headers
const PAYMENT_SIGNATURE_HEADER = "payment-signature";
const PAYMENT_REQUIRED_HEADER = "payment-required";
const PAYMENT_RESPONSE_HEADER = "payment-response";
const X_A2A_EXTENSIONS_HEADER = "x-a2a-extensions";

// Re-export shared settlement utilities so callers can import from a single place
export {
	buildHttpPaymentRequirements,
	decodePaymentSignature,
	settlePayment,
} from "./settlement.js";
export { settleViaFacilitator, settleViaGasWallet } from "./settlement.js";

/**
 * Express middleware that intercepts AccessRequest calls on the JSON-RPC endpoint
 * and implements the x402 HTTP flow for clients that do NOT send X-A2A-Extensions.
 *
 * Routing:
 *   X-A2A-Extensions present → A2A-native client → pass through to A2A JSON-RPC handler
 *   message/send + no payment-signature → HTTP 402 with PaymentRequirements
 *   message/send + payment-signature   → settle → HTTP 200 with AccessGrant
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
			// 1. If X-A2A-Extensions header present, this is an A2A client → pass through
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

			// 3. Only intercept message/send
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

			console.log(`[x402-http-middleware] Parsing ${params.message.parts.length} message parts...`);
			for (const part of params.message.parts) {
				console.log(`[x402-http-middleware] - Part kind: ${part.kind}`);
				if (part.kind === "data" && part.data?.type === "AccessRequest") {
					accessRequest = part.data as AccessRequest;
					console.log("[x402-http-middleware] ✓ Found AccessRequest in data part");
					break;
				}
				if (part.kind === "text") {
					try {
						const parsed = JSON.parse(part.text);
						if (parsed.type === "AccessRequest") {
							accessRequest = parsed as AccessRequest;
							console.log("[x402-http-middleware] ✓ Found AccessRequest in text part");
							break;
						}
					} catch {
						continue;
					}
				}
			}

			if (!accessRequest) {
				console.log("[x402-http-middleware] → No AccessRequest found, passing through");
				return next();
			}

			const resourceId = accessRequest.resourceId || "default";
			const tierId = accessRequest.tierId;
			const requestId = accessRequest.requestId || `http-${crypto.randomUUID()}`;
			console.log(
				`[x402-http-middleware] AccessRequest: tierId=${tierId}, resourceId=${resourceId}, requestId=${requestId}`,
			);

			// 5. Check for PAYMENT-SIGNATURE header
			const paymentSignatureRaw = req.headers[PAYMENT_SIGNATURE_HEADER] as string | undefined;
			console.log(
				`[x402-http-middleware] PAYMENT-SIGNATURE header present: ${!!paymentSignatureRaw}`,
			);

			if (!paymentSignatureRaw) {
				// ===== STEP 1: No payment → create PENDING record and return HTTP 402 =====
				console.log("[x402-http-middleware] → STEP 1: Issuing 402 challenge");

				const { challengeId } = await engine.requestHttpAccess(requestId, tierId, resourceId);
				console.log(`[x402-http-middleware] ✓ PENDING record created, challengeId=${challengeId}`);

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

				const base64Requirements = Buffer.from(JSON.stringify(requirements)).toString("base64");
				res.setHeader(PAYMENT_REQUIRED_HEADER, base64Requirements);

				return res.status(402).json({
					...requirements,
					challengeId,
					error: "PAYMENT-SIGNATURE header is required",
				});
			}

			// ===== STEP 2: Has PAYMENT-SIGNATURE → settle and return access grant =====
			console.log("[x402-http-middleware] → STEP 2: Processing payment");
			console.log(
				`[x402-http-middleware] PAYMENT-SIGNATURE (first 50 chars): ${paymentSignatureRaw.substring(0, 50)}...`,
			);

			// Decode the header then settle via shared settlement layer
			const paymentPayload = decodePaymentSignature(paymentSignatureRaw);
			const { txHash, settleResponse, payer } = await settlePayment(
				paymentPayload,
				config,
				networkConfig,
			);

			console.log(`[x402-http-middleware] ✓ Payment settled, txHash: ${txHash}`);

			const grant: AccessGrant = await engine.processHttpPayment(
				requestId,
				tierId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);
			console.log("[x402-http-middleware] ✓ Access grant issued:", JSON.stringify(grant, null, 2));

			const settlementResponse: X402SettleResponse = {
				success: true,
				transaction: txHash,
				network: `eip155:${networkConfig.chainId}`,
				...(payer && { payer }),
			};
			res.setHeader(
				PAYMENT_RESPONSE_HEADER,
				Buffer.from(JSON.stringify(settlementResponse)).toString("base64"),
			);

			return res.status(200).json(grant);
		} catch (err: unknown) {
			console.error("[x402-http-middleware] ✗ ERROR:", err);
			if (err instanceof AgentGateError) {
				return res.status(err.httpStatus).json(err.toJSON());
			}
			return res.status(500).json({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			console.log("[x402-http-middleware] ========== REQUEST COMPLETE ==========\n");
		}
	};
}
