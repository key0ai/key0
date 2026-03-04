import { type NextFunction, type Request, type Response, Router } from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { type AgentGateConfig, createAgentGate } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { AgentGateError, CHAIN_CONFIGS } from "../types/index.js";
import type { AccessRequest, X402PaymentRequiredResponse, X402SettleResponse } from "../types/index.js";
import { validateToken } from "../middleware.js";
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
	router.use('/.well-known/agent.json', agentCardHandler({ agentCardProvider: requestHandler }));

	// A2A endpoint with x402 middleware
	const basePath = opts.config.basePath ?? "/a2a";
	router.use(
		`${basePath}/jsonrpc`,
		createX402HttpMiddleware(engine, opts.config), // x402 HTTP middleware (before A2A handler)
		jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);
	router.use(`${basePath}/rest`, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

	// Simple x402 HTTP endpoint (primary interface)
	router.post(`${basePath}/access`, async (req: Request, res: Response) => {
		try {
			console.log("\n[x402-access] ========== NEW REQUEST ==========");
			console.log("[x402-access] Body:", JSON.stringify(req.body, null, 2));

		// Parse simple request body: { tierId, requestId, resourceId }
		const body = req.body;
		if (!body || typeof body !== "object") {
			return res.status(400).json({ error: "Body must be JSON object" });
		}

		const { tierId, requestId, resourceId = "default" } = body;
		if (!tierId || !requestId) {
			return res.status(400).json({ error: "Missing required: tierId, requestId" });
		}

		console.log(`[x402-access] Tier: ${tierId}, RequestId: ${requestId}, Resource: ${resourceId}`);

			// Check for PAYMENT-SIGNATURE header
			const paymentSignature = req.headers["payment-signature"] as string | undefined;

			if (!paymentSignature) {
				// ===== No payment -> return HTTP 402 =====
				console.log("[x402-access] → No payment, issuing 402");

				// Verify resource
				try {
					const timeoutMs = opts.config.resourceVerifyTimeoutMs ?? 5000;
					const exists = await Promise.race([
						opts.config.onVerifyResource(resourceId, tierId),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("Timeout")), timeoutMs),
						),
					]);

					if (!exists) {
						return res.status(404).json({ error: "Resource not found" });
					}
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : "Verification failed";
					return res.status(504).json({ error: message });
				}

				// Build payment requirements
			const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
				tierId,
				resourceId,
				opts.config,
				networkConfig,
			);

				// Set PAYMENT-REQUIRED header (base64)
				const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
				res.setHeader("PAYMENT-REQUIRED", encoded);

				return res.status(402).json({ error: "Payment required" });
			} else {
				// ===== Has payment -> settle =====
				console.log("[x402-access] → Processing payment");

				let txHash: `0x${string}`;
				let settleResponse: X402SettleResponse;

				if (opts.config.gasWalletPrivateKey) {
					const result = await settleViaGasWallet(
						paymentSignature,
						opts.config.gasWalletPrivateKey,
						networkConfig,
					);
					txHash = result.txHash;
					settleResponse = result.settleResponse;
				} else {
					const facilitatorUrl = opts.config.facilitatorUrl ?? networkConfig.facilitatorUrl;
					const result = await settleViaFacilitator(paymentSignature, facilitatorUrl);
					txHash = result.txHash;
					settleResponse = result.settleResponse;
				}

				console.log(`[x402-access] ✓ Settled: ${txHash}`);

				// Issue access token
				const grant = await engine.processHttpPayment(tierId, resourceId, txHash);

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
				error: "Internal error",
				message: err instanceof Error ? err.message : "Unknown",
			});
		} finally {
			console.log("[x402-access] ========== COMPLETE ==========\n");
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
