import { Router, type Request, type Response, type NextFunction } from "express";
import type { IChallengeStore, IPaymentAdapter, ISeenTxStore, SellerConfig } from "@agentgate/types";
import { AgentGateError } from "@agentgate/types";
import {
  AccessTokenIssuer,
  ChallengeEngine,
  InMemoryChallengeStore,
  InMemorySeenTxStore,
} from "@agentgate/core";
import { AgentGateRouter } from "./router.js";
import { validateToken, type ValidateAccessTokenConfig } from "./middleware.js";

export type AgentGateExpressConfig = {
  readonly config: SellerConfig;
  readonly adapter: IPaymentAdapter;
  readonly store?: IChallengeStore | undefined;
  readonly seenTxStore?: ISeenTxStore | undefined;
};

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
export function agentGateRouter(opts: AgentGateExpressConfig): Router {
  const store = opts.store ?? new InMemoryChallengeStore();
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore();
  const tokenIssuer = new AccessTokenIssuer(opts.config.accessTokenSecret);

  const engine = new ChallengeEngine({
    config: opts.config,
    store,
    seenTxStore,
    adapter: opts.adapter,
    tokenIssuer,
  });

  const handler = new AgentGateRouter({ engine, config: opts.config });
  const router = Router();

  // Agent Card
  router.get("/.well-known/agent.json", async (_req: Request, res: Response) => {
    const result = await handler.handleAgentCard();
    res.status(result.status);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        res.setHeader(k, v);
      }
    }
    res.json(result.body);
  });

  // A2A endpoint
  const basePath = opts.config.basePath ?? "/agent";
  router.post(basePath, async (req: Request, res: Response) => {
    const result = await handler.handleA2ATask(req.body);
    res.status(result.status).json(result.body);
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
