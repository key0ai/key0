import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
	UserBuilder,
	agentCardHandler,
	jsonRpcHandler,
	restHandler,
} from "@a2a-js/sdk/server/express";
import { type NextFunction, type Request, type Response, Router } from "express";
import { type AgentGateConfig, createAgentGate } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import { AgentGateError, CHAIN_CONFIGS } from "../types/index.js";
import type { AccessRequest, X402PaymentRequiredResponse, X402SettleResponse } from "../types/index.js";
import { createX402HttpMiddleware, buildHttpPaymentRequirements, settleViaGasWallet, settleViaFacilitator } from "./x402-http-middleware.js";

/**
 * Create an Express router that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   app.use(agentGateRouter({ config, adapter }));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json
 *   POST {config.basePath}/jsonrpc (A2A JSON-RPC)
 *   POST {config.basePath}/access (Simple x402 HTTP)
 */
export function agentGateRouter(opts: AgentGateConfig): Router {
	const { requestHandler, engine } = createAgentGate(opts);
	const router = Router();
	const networkConfig = CHAIN_CONFIGS[opts.config.network];

	// Agent Card
	router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
	router.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

	// A2A endpoint with x402 middleware
	const basePath = opts.config.basePath ?? "/a2a";
	router.use(
		`${basePath}/jsonrpc`,
		createX402HttpMiddleware(engine, opts.config), // x402 HTTP middleware (before A2A handler)
		jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);
	router.use(`${basePath}/rest`, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

	// Simple x402 HTTP endpoint (no JSON-RPC wrapping)
	router.post(`${basePath}/access`, async (req: Request, res: Response) => {
		try {
			console.log("\n[x402-access] ========== NEW REQUEST ==========");
			console.log("[x402-access] Body:", JSON.stringify(req.body, null, 2));
			console.log("[x402-access] Headers:", JSON.stringify(req.headers, null, 2));

		// Parse AccessRequest from body
		const body = req.body;
		if (!body || typeof body !== "object") {
			return res.status(400).json({
				error: "INVALID_REQUEST",
				message: "Body must be a valid JSON object",
			});
		}

		const { tierId, requestId, resourceId = "default" } = body;

		const accessRequest: AccessRequest = {
			tierId,
			requestId,
			resourceId,
			clientAgentId: body.clientAgentId || "anonymous",
			callbackUrl: body.callbackUrl,
		};
			if (!tierId || !requestId) {
				return res.status(400).json({
					error: "INVALID_REQUEST",
					message: "Missing required fields: tierId, requestId",
				});
			}

			// Check for PAYMENT-SIGNATURE header
			const paymentSignature = req.headers["payment-signature"] as string | undefined;
			console.log(`[x402-access] PAYMENT-SIGNATURE present: ${!!paymentSignature}`);

			if (!paymentSignature) {
				// ===== STEP 1: No payment yet -> return HTTP 402 =====
				console.log("[x402-access] → STEP 1: No PAYMENT-SIGNATURE, issuing 402");

				// Verify resource exists
				try {
					const timeoutMs = opts.config.resourceVerifyTimeoutMs ?? 5000;
					const exists = await Promise.race([
						opts.config.onVerifyResource(resourceId, tierId),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("Resource verification timed out")), timeoutMs),
						),
					]);

					if (!exists) {
						console.log(`[x402-access] ✗ Resource "${resourceId}" not found`);
						return res.status(404).json({
							error: "RESOURCE_NOT_FOUND",
							message: `Resource "${resourceId}" not found or not available for tier "${tierId}"`,
						});
					}
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : "Resource verification failed";
					console.log(`[x402-access] ✗ Resource verification error: ${message}`);
					return res.status(504).json({
						error: "RESOURCE_VERIFY_TIMEOUT",
						message,
					});
				}

				// Build payment requirements
				const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
					tierId,
					resourceId,
					opts.config,
					networkConfig,
				);

				// Encode as base64 for PAYMENT-REQUIRED header
				const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
				res.setHeader("PAYMENT-REQUIRED", encoded);
				console.log("[x402-access] → Returning HTTP 402");

				return res.status(402).json({
					...requirements,
					error: "PAYMENT-SIGNATURE header is required",
				});
			} else {
				// ===== STEP 2: Has PAYMENT-SIGNATURE -> settle and return access grant =====
				console.log("[x402-access] → STEP 2: Processing payment");

				// Settle payment
				let txHash: `0x${string}`;
				let settleResponse: X402SettleResponse;
				let payer: string | undefined;

				if (opts.config.gasWalletPrivateKey) {
					console.log("[x402-access] Using gas wallet settlement");
					const result = await settleViaGasWallet(
						paymentSignature,
						opts.config.gasWalletPrivateKey,
						networkConfig,
					);
					txHash = result.txHash;
					settleResponse = result.settleResponse;
					payer = result.payer;
				} else {
					const facilitatorUrl = opts.config.facilitatorUrl ?? networkConfig.facilitatorUrl;
					console.log(`[x402-access] Using facilitator: ${facilitatorUrl}`);
					const result = await settleViaFacilitator(paymentSignature, facilitatorUrl);
					txHash = result.txHash;
					settleResponse = result.settleResponse;
					payer = result.payer;
				}

				console.log(`[x402-access] ✓ Payment settled: ${txHash}`);

				// Issue access token
				const grant = await engine.processHttpPayment(tierId, resourceId, txHash);
				console.log("[x402-access] ✓ Access grant issued");

				// Set PAYMENT-RESPONSE header
				const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
				res.setHeader("PAYMENT-RESPONSE", paymentResponse);

				return res.status(200).json(grant);
			}
		} catch (err: unknown) {
			console.error("[x402-access] ✗ Error:", err);
			if (err instanceof AgentGateError) {
				return res.status(err.httpStatus).json(err.toJSON());
			}
			return res.status(500).json({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			console.log("[x402-access] ========== REQUEST COMPLETE ==========\n");
		}
	});

	return router;
}

/**
 * Express middleware to validate access tokens.
 *
 * Usage:
 *   app.use("/api/photos", validateAccessToken({ secret: process.env.ACCESS_TOKEN_SECRET }));
 */
export function validateAccessToken(config: ValidateAccessTokenConfig) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const payload = await validateToken(req.headers.authorization, config);
			// Attach decoded token to request for downstream handlers
			(req as Request & { agentGateToken?: unknown }).agentGateToken = payload;
			next();
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				res.status(err.httpStatus).json(err.toJSON());
			} else {
				res.status(500).json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
			}
		}
	};
}

export type { ValidateAccessTokenConfig };
