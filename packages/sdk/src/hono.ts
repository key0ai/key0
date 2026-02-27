import { Hono } from "hono";
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

export type AgentGateHonoConfig = {
  readonly config: SellerConfig;
  readonly adapter: IPaymentAdapter;
  readonly store?: IChallengeStore | undefined;
  readonly seenTxStore?: ISeenTxStore | undefined;
};

/**
 * Create a Hono app that serves the agent card and A2A endpoint.
 * Mount it as a sub-app: mainApp.route("/", agentGateApp(opts));
 */
export function agentGateApp(opts: AgentGateHonoConfig): Hono {
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
  const app = new Hono();

  app.get("/.well-known/agent.json", async (c) => {
    const result = await handler.handleAgentCard();
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  const basePath = opts.config.basePath ?? "/agent";
  app.post(basePath, async (c) => {
    const body = await c.req.json();
    const result = await handler.handleA2ATask(body);
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  return app;
}

/**
 * Hono middleware to validate access tokens.
 */
export function honoValidateAccessToken(config: ValidateAccessTokenConfig) {
  return async (c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: unknown) => void; json: (data: unknown, status: number) => Response }, next: () => Promise<void>) => {
    try {
      const payload = await validateToken(c.req.header("authorization"), config);
      c.set("agentGateToken", payload);
      await next();
    } catch (err: unknown) {
      if (err instanceof AgentGateError) {
        return c.json(err.toJSON(), err.httpStatus);
      }
      return c.json({ type: "Error", code: "INTERNAL_ERROR", message: "Internal error" }, 500);
    }
  };
}
