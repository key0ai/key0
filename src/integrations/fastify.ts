import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createKey0, type Key0Config } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { validateToken } from "../middleware.js";
import { Key0Error } from "../types/index.js";

/**
 * Fastify plugin that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   fastify.register(key0Plugin, { config, adapter });
 */
export async function key0Plugin(fastify: FastifyInstance, opts: Key0Config): Promise<void> {
	const { requestHandler: _requestHandler, agentCard } = createKey0(opts);

	// Agent Card
	fastify.get(`/${AGENT_CARD_PATH}`, async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.send(agentCard);
	});

	// A2A endpoint
	const basePath = opts.config.basePath ?? "/a2a";
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
