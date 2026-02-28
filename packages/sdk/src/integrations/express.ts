import { type NextFunction, type Request, type Response, Router } from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { type AgentGateConfig, createAgentGate } from "../factory.js";
import type { ValidateAccessTokenConfig } from "../middleware.js";
import { AgentGateError } from "../types/index.js";
import { validateToken } from "../middleware.js";

/**
 * Create an Express router that serves the agent card and A2A endpoint.
 *
 * Usage:
 *   app.use(agentGateRouter({ config, adapter }));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json
 *   POST {config.basePath} (A2A tasks/send)
 */
export function agentGateRouter(opts: AgentGateConfig): Router {
	const { requestHandler } = createAgentGate(opts);
	const router = Router();

	// Agent Card
	router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));

	// A2A endpoint
	const basePath = opts.config.basePath ?? "/agent";
	router.use(basePath, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
	router.use(`${basePath}/rest`, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

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
