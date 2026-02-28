import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type AgentGateConfig, createAgentGate } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import { AgentGateError } from "../types/index.js";

/**
 * Fastify plugin that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   fastify.register(agentGatePlugin, { config, adapter });
 */
export async function agentGatePlugin(
	fastify: FastifyInstance,
	opts: AgentGateConfig,
): Promise<void> {
	const { requestHandler, agentCard } = createAgentGate(opts);

	// Agent Card
	fastify.get(`/${AGENT_CARD_PATH}`, async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});

	// A2A endpoint
	const basePath = opts.config.basePath ?? "/agent";
	fastify.post(basePath, async (_request: FastifyRequest, reply: FastifyReply) => {
		// TODO: Use official A2A Fastify handler when available
		return reply.code(501).send({ error: "Fastify support pending A2A SDK update" });
	});
}

/**
 * Fastify onRequest hook to validate access tokens.
 */
export function fastifyValidateAccessToken(config: ValidateAccessTokenConfig) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		try {
			const payload = await validateToken(request.headers.authorization, config);
			(request as FastifyRequest & { agentGateToken?: unknown }).agentGateToken = payload;
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				return reply.status(err.httpStatus).send(err.toJSON());
			}
			return reply
				.status(500)
				.send({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" });
		}
	};
}
