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
import { AgentGateError } from "../types/index.js";

/**
 * Create an Express router that serves the agent card, A2A endpoint,
 * and optionally an MCP endpoint (when `mcp: true`).
 *
 * Usage:
 *   app.use(agentGateRouter({ config, adapter, mcp: true }));
 *
 * This auto-serves:
 *   GET  /.well-known/agent.json
 *   POST {basePath}/jsonrpc   (A2A)
 *   POST /mcp                 (MCP, when enabled)
 *   GET  /mcp                 (MCP SSE, when enabled)
 *   DELETE /mcp               (MCP session close, when enabled)
 */
export function agentGateRouter(opts: AgentGateConfig): Router {
	const { requestHandler, mcpServer } = createAgentGate(opts);
	const router = Router();

	// Agent Card
	router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
	router.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

	// A2A endpoint
	const basePath = opts.config.basePath ?? "/a2a";
	router.use(
		`${basePath}/jsonrpc`,
		jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);
	router.use(
		`${basePath}/rest`,
		restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
	);

	// MCP endpoint (Streamable HTTP transport on /mcp)
	if (mcpServer) {
		const { StreamableHTTPServerTransport } = require(
			"@modelcontextprotocol/sdk/server/streamableHttp.js",
		) as typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js");

		// Stateless mode — no session tracking needed
		const transport = new StreamableHTTPServerTransport({} as Record<string, never>);
		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK's Transport type has exactOptionalPropertyTypes mismatch
		mcpServer.connect(transport as any);

		router.all("/mcp", (req: Request, res: Response) => {
			transport.handleRequest(req, res, req.body);
		});
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
