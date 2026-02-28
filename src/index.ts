// Export Types
export * from "./types/index.js";

// Export Adapter Logic
export * from "./adapter/index.js";

// Export Core Logic
export * from "./core/index.js";

// Middleware
export { validateToken } from "./middleware.js";
export type { AccessTokenPayload, ValidateAccessTokenConfig } from "./middleware.js";

// Validator (lightweight for backend services)
export { validateAgentGateToken } from "./validator/index.js";
export type {
	AccessTokenPayload as ValidatorAccessTokenPayload,
	ValidatorConfig,
} from "./validator/index.js";

// Remote Helpers (for separate service deployments)
export { createRemoteResourceVerifier, createRemoteTokenIssuer } from "./helpers/remote.js";
export type { RemoteVerifierConfig, RemoteTokenIssuerConfig } from "./helpers/remote.js";

// Auth Strategies
export { sharedSecretAuth, signedJwtAuth, oauthClientCredentialsAuth } from "./helpers/auth.js";
export type { AuthHeaderProvider } from "./helpers/auth.js";

// Executor
export { AgentGateExecutor } from "./executor.js";

// Factory
export { createAgentGate } from "./factory.js";
export type { AgentGateConfig } from "./factory.js";

// Export A2A types if needed, or rely on @a2a-js/sdk
export type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
