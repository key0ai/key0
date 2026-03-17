import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { Hono } from "hono";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import type { X402PaymentRequiredResponse } from "../types/index.js";
import { CHAIN_CONFIGS, Key0Error } from "../types/index.js";
import {
	buildDiscoveryResponse,
	buildHttpPaymentRequirements,
	decodePaymentSignature,
	settlePayment,
} from "./settlement.js";

/**
 * Create a Hono app that serves the agent card and the unified x402 endpoint.
 *
 * Usage:
 *   mainApp.route("/", key0App(opts));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json  — A2A agent card (discovery)
 *   POST /x402/access             — unified x402 HTTP endpoint
 */
export function key0App(opts: Key0Config): Hono {
	const { engine, agentCard } = createKey0(opts);
	const app = new Hono();
	const networkConfig = opts.config.rpcUrl
		? { ...CHAIN_CONFIGS[opts.config.network], rpcUrl: opts.config.rpcUrl }
		: CHAIN_CONFIGS[opts.config.network];

	// Agent Card
	app.get(`/${AGENT_CARD_PATH}`, (c) => c.json(agentCard));
	app.get("/.well-known/agent.json", (c) => c.json(agentCard));

	// Unified x402 endpoint
	app.post("/x402/access", async (c) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access/hono] ========== NEW REQUEST ==========");

			const body = await c.req.json().catch(() => ({}));
			let { planId, resourceId = "default" } = body as {
				planId?: string;
				resourceId?: string;
			};
			let { requestId } = body as { requestId?: string };

			const paymentSignature = c.req.header("payment-signature");

			// Extract planId from PAYMENT-SIGNATURE if not in body
			if (!planId && paymentSignature) {
				try {
					const decoded = decodePaymentSignature(paymentSignature);
					const sigPlanId = decoded.accepted?.extra?.["planId"] as string | undefined;
					if (sigPlanId) {
						console.log(
							`[x402-access/hono] Extracted planId="${sigPlanId}" from PAYMENT-SIGNATURE`,
						);
						planId = sigPlanId;
					}
				} catch {
					// Fall through to discovery
				}
			}

			// CASE 1: No planId → 400 pointing to GET /discovery
			if (!planId) {
				return c.json(
					{
						error:
							"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discovery",
					},
					400,
				);
			}

			// Auto-generate requestId
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
			}

			// CASE 2: planId, no PAYMENT-SIGNATURE → Challenge
			if (!paymentSignature) {
				console.log("[x402-access/hono] → CASE 2: Challenge 402");
				const { challengeId } = await engine.requestHttpAccess(requestId, planId, resourceId);

				const requirements: X402PaymentRequiredResponse = buildHttpPaymentRequirements(
					planId,
					resourceId,
					opts.config,
					networkConfig,
					{
						inputSchema: {
							type: "object",
							properties: {
								planId: { type: "string", description: `Tier to purchase. Must be '${planId}'` },
								requestId: { type: "string", description: "Client-generated UUID for idempotency" },
								resourceId: { type: "string", description: "Optional resource identifier" },
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

				const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
				c.header("payment-required", encoded);
				c.header(
					"www-authenticate",
					`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`,
				);

				return c.json({ ...requirements, challengeId, requestId, error: "Payment required" }, 402);
			}

			// CASE 3: planId + PAYMENT-SIGNATURE → Settle
			console.log("[x402-access/hono] → CASE 3: Settlement");

			const existingGrant = await engine.preSettlementCheck(requestId);
			if (existingGrant) {
				return c.json(existingGrant, 200);
			}

			const paymentPayload = decodePaymentSignature(paymentSignature);
			const { txHash, settleResponse, payer } = await settlePayment(
				paymentPayload,
				opts.config,
				networkConfig,
			);

			const grant = await engine.processHttpPayment(
				requestId,
				planId,
				resourceId,
				txHash,
				payer as `0x${string}` | undefined,
			);

			const paymentResponse = Buffer.from(JSON.stringify(settleResponse)).toString("base64");
			c.header("payment-response", paymentResponse);

			return c.json(grant, 200);
		} catch (err: unknown) {
			const elapsed = Date.now() - startTime;
			console.error(`[x402-access/hono] Error after ${elapsed}ms:`, err);

			if (err instanceof Key0Error) {
				if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
					return c.json(err.details["grant"], 200);
				}
				return c.json(err.toJSON(), err.httpStatus as any);
			}

			return c.json(
				{
					error: "INTERNAL_ERROR",
					message: err instanceof Error ? err.message : "Internal server error",
				},
				500,
			);
		} finally {
			console.log(`[x402-access/hono] Request completed in ${Date.now() - startTime}ms`);
		}
	});

	app.get("/discovery", (c) => {
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig);
		return c.json({ discoveryResponse });
	});

	return app;
}

/**
 * Hono middleware to validate access tokens.
 */
export function honoValidateAccessToken(config: ValidateAccessTokenConfig) {
	return async (
		c: {
			req: { header: (name: string) => string | undefined };
			set: (key: string, value: unknown) => void;
			json: (data: unknown, status: number) => Response;
		},
		next: () => Promise<void>,
	) => {
		try {
			const payload = await validateToken(c.req.header("authorization"), config);
			c.set("key0Token", payload);
			await next();
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return c.json(err.toJSON(), err.httpStatus);
			}
			return c.json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" }, 500);
		}
	};
}
