import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
 * Fastify plugin that serves the agent card and the unified x402 endpoint.
 *
 * Usage:
 *   fastify.register(key0Plugin, { config, adapter });
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json  — A2A agent card (discovery)
 *   POST /x402/access             — unified x402 HTTP endpoint
 */
export async function key0Plugin(fastify: FastifyInstance, opts: Key0Config): Promise<void> {
	const { engine, agentCard } = createKey0(opts);
	const networkConfig = opts.config.rpcUrl
		? { ...CHAIN_CONFIGS[opts.config.network], rpcUrl: opts.config.rpcUrl }
		: CHAIN_CONFIGS[opts.config.network];

	// Agent Card
	fastify.get(`/${AGENT_CARD_PATH}`, async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});
	fastify.get("/.well-known/agent.json", async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});

	// Unified x402 endpoint
	fastify.post("/x402/access", async (request: FastifyRequest, reply: FastifyReply) => {
		const startTime = Date.now();
		try {
			console.log("\n[x402-access/fastify] ========== NEW REQUEST ==========");

			const body = (request.body as Record<string, unknown>) || {};
			let planId = body["planId"] as string | undefined;
			let requestId = body["requestId"] as string | undefined;
			const resourceId = (body["resourceId"] as string) || "default";

			const paymentSignature = request.headers["payment-signature"] as string | undefined;

			// Extract planId from PAYMENT-SIGNATURE if not in body
			if (!planId && paymentSignature) {
				try {
					const decoded = decodePaymentSignature(paymentSignature);
					const sigPlanId = decoded.accepted?.extra?.["planId"] as string | undefined;
					if (sigPlanId) {
						console.log(
							`[x402-access/fastify] Extracted planId="${sigPlanId}" from PAYMENT-SIGNATURE`,
						);
						planId = sigPlanId;
					}
				} catch {
					// Fall through to discovery
				}
			}

			// CASE 1: No planId → 400 pointing to GET /discovery
			if (!planId) {
				return reply.code(400).send({
					error:
						"Please select a plan from the discovery API response to purchase access. Endpoint: GET /discovery",
				});
			}

			// Auto-generate requestId
			if (!requestId) {
				requestId = `http-${crypto.randomUUID()}`;
			}

			// CASE 2: planId, no PAYMENT-SIGNATURE → Challenge
			if (!paymentSignature) {
				console.log("[x402-access/fastify] → CASE 2: Challenge 402");
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
				reply.header("payment-required", encoded);
				reply.header(
					"www-authenticate",
					`Payment realm="${opts.config.agentUrl}", accept="exact", challenge="${challengeId}"`,
				);

				return reply
					.code(402)
					.send({ ...requirements, challengeId, requestId, error: "Payment required" });
			}

			// CASE 3: planId + PAYMENT-SIGNATURE → Settle
			console.log("[x402-access/fastify] → CASE 3: Settlement");

			const existingGrant = await engine.preSettlementCheck(requestId);
			if (existingGrant) {
				return reply.code(200).send(existingGrant);
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
			reply.header("payment-response", paymentResponse);

			return reply.code(200).send(grant);
		} catch (err: unknown) {
			const elapsed = Date.now() - startTime;
			console.error(`[x402-access/fastify] Error after ${elapsed}ms:`, err);

			if (err instanceof Key0Error) {
				if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
					return reply.code(200).send(err.details["grant"]);
				}
				return reply.code(err.httpStatus).send(err.toJSON());
			}

			return reply.code(500).send({
				error: "INTERNAL_ERROR",
				message: err instanceof Error ? err.message : "Internal server error",
			});
		} finally {
			console.log(`[x402-access/fastify] Request completed in ${Date.now() - startTime}ms`);
		}
	});

	fastify.get("/discovery", async (_request: FastifyRequest, reply: FastifyReply) => {
		const discoveryResponse = buildDiscoveryResponse(opts.config, networkConfig);
		return reply.send({ discoveryResponse });
	});
}

/**
 * Fastify onRequest hook to validate access tokens.
 */
export function fastifyValidateAccessToken(config: ValidateAccessTokenConfig) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		try {
			const payload = await validateToken(request.headers.authorization, config);
			(request as FastifyRequest & { key0Token?: unknown }).key0Token = payload;
		} catch (err: unknown) {
			if (err instanceof Key0Error) {
				return reply.status(err.httpStatus).send(err.toJSON());
			}
			return reply
				.status(500)
				.send({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
		}
	};
}
