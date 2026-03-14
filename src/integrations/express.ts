import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
	agentCardHandler,
	jsonRpcHandler,
	restHandler,
	UserBuilder,
} from "@a2a-js/sdk/server/express";
import { type NextFunction, type Request, type Response, Router } from "express";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type { X402PaymentRequiredResponse } from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import { mountMcpRoutes } from "./mcp.js";
import {
	buildDiscoveryResponse,
	buildHttpPaymentRequirements,
	createX402HttpMiddleware,
	decodePaymentSignature,
	settlePayment,
} from "./x402-http-middleware.js";

/**
 * Create an Express router that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   app.use(key0Router({ config, adapter }));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json
 *   POST {config.basePath}/jsonrpc (A2A JSON-RPC)
 *   POST {config.basePath}/access (Simple x402 HTTP)
 */
export function key0Router(opts: Key0Config): Router {
	const { requestHandler, engine } = createKey0(opts);
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
	router.use(
		`${basePath}/rest`,
		restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);

	// Simple x402 HTTP endpoint (no JSON-RPC wrapping)
	router.post(`/x402/access`, async (req: Request, res: Response) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access] ========== NEW REQUEST ==========");
			console.log(`[x402-access] Timestamp: ${new Date().toISOString()}`);
			console.log(`[x402-access] Method: ${req.method}`);
			console.log(`[x402-access] URL: ${req.url}`);
			console.log("[x402-access] Body:", JSON.stringify(req.body, null, 2));
			console.log("[x402-access] Headers:", JSON.stringify(req.headers, null, 2));

			// Parse body (allow empty for discovery)
			const body = req.body || {};
			let { planId, resourceId = "default" } = body;
			let { requestId } = body;

			// Check for PAYMENT-SIGNATURE header
			const paymentSignature = req.headers["payment-signature"] as string | undefined;
			console.log(`[x402-access] PAYMENT-SIGNATURE present: ${!!paymentSignature}`);

			// ===== x402 shortcut: extract planId from PAYMENT-SIGNATURE if not in body =====
			// Standard x402 clients replay the same request with PAYMENT-SIGNATURE header.
			// The planId is embedded in accepted.extra.planId within the signed payload.
			if (!planId && paymentSignature) {
				try {
					const decoded = decodePaymentSignature(paymentSignature);
					const sigTierId = decoded.accepted?.extra?.["planId"] as string | undefined;
					if (sigTierId) {
						console.log(
							`[x402-access] ✓ Extracted planId="${sigTierId}" from PAYMENT-SIGNATURE (x402 replay)`,
						);
						planId = sigTierId;
					}
				} catch (err) {
					console.log(
						`[x402-access] ⚠ Failed to decode PAYMENT-SIGNATURE for planId extraction: ${err}`,
					);
					// Fall through to discovery — the signature might be malformed
				}
			}

			// ===== CASE 1: No planId → Discovery (402 with all tiers, no PENDING record) =====
			if (!planId) {
				console.log("[x402-access] → CASE 1: No planId provided, returning discovery 402");
				const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig);
				console.log(
					"[x402-access] Discovery response:",
					JSON.stringify(discoveryResponse, null, 2),
				);
				const encoded = Buffer.from(JSON.stringify(discoveryResponse)).toString("base64");
				res.setHeader("payment-required", encoded);
				const authHeader = `Payment realm="${opts.config.agentUrl}", accept="exact"`;
				res.setHeader("www-authenticate", authHeader);
				console.log(`[x402-access] payment-required header set (${encoded.length} bytes)`);
				console.log(`[x402-access] www-authenticate header set`);
				console.log("[x402-access] → Returning HTTP 402 Payment Required (Discovery)");
				return res.status(402).json({
					...discoveryResponse,
					error:
						"Please select a plan from the discovery response to purchase access. Endpoint: GET /discovery ",
				});
			}

			// Auto-generate requestId if not provided (for simplicity)
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
				console.log(`[x402-access] Auto-generated requestId: ${requestId}`);
			}

			console.log(
				`[x402-access] Parsed request - planId: ${planId}, requestId: ${requestId}, resourceId: ${resourceId}`,
			);

			// ===== CASE 2: planId present, no PAYMENT-SIGNATURE → Challenge (402 + PENDING record) =====
			if (!paymentSignature) {
				console.log(
					"[x402-access] → CASE 2: planId provided, no PAYMENT-SIGNATURE, issuing 402 challenge",
				);
				console.log(`[x402-access] Creating PENDING record for requestId: ${requestId}`);

				// Create PENDING record via engine (handles tier/resource validation and idempotency)
				const { challengeId } = await engine.requestHttpAccess(requestId, planId, resourceId);
				console.log(`[x402-access] ✓ PENDING record created, challengeId=${challengeId}`);

				// Build payment requirements with schema
				console.log(`[x402-access] Building payment requirements for tier: ${planId}`);
				const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
					planId,
					resourceId,
					opts.config,
					networkConfig,
					{
						inputSchema: {
							type: "object",
							properties: {
								planId: {
									type: "string",
									description: `Tier to purchase. Must be '${planId}'`,
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
							required: ["planId"],
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
						description: `Access to ${resourceId} via ${planId} tier`,
					},
				);
				console.log(`[x402-access] Payment requirements:`, JSON.stringify(requirements, null, 2));

				// Encode as base64 for payment-required header
				const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
				res.setHeader("payment-required", encoded);

				// Add www-authenticate header
				const authHeader = `Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`;
				res.setHeader("www-authenticate", authHeader);

				console.log(`[x402-access] payment-required header set (${encoded.length} bytes)`);
				console.log(`[x402-access] www-authenticate header set`);
				console.log("[x402-access] → Returning HTTP 402 Payment Required (Challenge)");

				return res.status(402).json({
					...requirements,
					challengeId,
					error: "Payment required",
				});
			}

			// ===== CASE 3: planId + PAYMENT-SIGNATURE → Settle and return access grant =====
			console.log("[x402-access] → CASE 3: Processing payment");
			console.log(
				`[x402-access] PAYMENT-SIGNATURE header received (${paymentSignature.length} bytes)`,
			);

			// Pre-settlement check: avoid burning USDC if already delivered/expired/cancelled
			console.log("[x402-access] Pre-settlement check for requestId:", requestId);
			const existingGrant = await engine.preSettlementCheck(requestId);
			if (existingGrant) {
				console.log("[x402-access] ✓ Already delivered, returning cached grant");
				return res.status(200).json(existingGrant);
			}

			// Decode header then settle via shared settlement layer
			console.log("[x402-access] Decoding payment signature...");
			const paymentPayload = decodePaymentSignature(paymentSignature);
			console.log(
				"[x402-access] Payment payload decoded:",
				JSON.stringify(paymentPayload, null, 2),
			);

			console.log("[x402-access] Settling payment on-chain...");
			const { txHash, settleResponse, payer } = await settlePayment(
				paymentPayload,
				opts.config,
				networkConfig,
			);

			console.log(`[x402-access] ✓ Payment settled successfully`);
			console.log(`[x402-access]   - Transaction Hash: ${txHash}`);
			console.log(`[x402-access]   - Payer: ${payer}`);
			console.log(`[x402-access]   - Settle Response:`, JSON.stringify(settleResponse, null, 2));

			// Process payment with full lifecycle tracking (PENDING → PAID → DELIVERED)
			console.log(`[x402-access] Processing payment for requestId: ${requestId}`);
			const grant = await engine.processHttpPayment(
				requestId,
				planId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);
			console.log("[x402-access] ✓ Access grant issued successfully");
			console.log("[x402-access] Grant details:", JSON.stringify(grant, null, 2));

			// Set payment-response header
			const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
			res.setHeader("payment-response", paymentResponse);
			console.log(`[x402-access] payment-response header set (${paymentResponse.length} bytes)`);

			console.log("[x402-access] → Returning HTTP 200 OK with access grant");
			return res.status(200).json(grant);
		} catch (err: unknown) {
			const elapsed = Date.now() - startTime;
			console.error(`[x402-access] ✗ Error occurred after ${elapsed}ms`);
			console.error("[x402-access] Error type:", err?.constructor?.name || typeof err);
			console.error("[x402-access] Error details:", err);

			if (err instanceof Error) {
				console.error("[x402-access] Error message:", err.message);
				console.error("[x402-access] Error stack:", err.stack);
			}

			if (err instanceof Key0Error) {
				console.error(`[x402-access] Key0 error: ${err.code} (HTTP ${err.httpStatus})`);
				// Return the grant directly for PROOF_ALREADY_REDEEMED (status 200)
				if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
					return res.status(200).json(err.details["grant"]);
				}
				return res.status(err.httpStatus).json(err.toJSON());
			}

			console.error("[x402-access] Returning 500 Internal Server Error");
			return res.status(500).json({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			const elapsed = Date.now() - startTime;
			console.log(`[x402-access] Request completed in ${elapsed}ms`);
			console.log("[x402-access] ========== REQUEST COMPLETE ==========\n");
		}
	});

	router.get("/discovery", (_req: Request, res: Response) => {
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig);
		return res.status(200).json({ discoveryResponse });
	});

	// MCP routes (when mcp: true)
	if (opts.config.mcp) {
		mountMcpRoutes(router, engine, opts.config);
	}

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
			(req as Request & { key0Token?: unknown }).key0Token = payload;
			next();
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				res.status(err.httpStatus).json(err.toJSON());
			} else {
				res.status(500).json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
			}
		}
	};
}

export type { ValidateAccessTokenConfig };
