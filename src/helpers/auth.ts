import type { AccessTokenIssuer } from "../core/access-token.js";
import { AgentGateError } from "../types/index.js";

/**
 * A function that returns headers for authentication.
 * Used by remote helpers to authenticate with backend services.
 */
export type AuthHeaderProvider = () => Promise<Record<string, string>>;

/**
 * Strategy 1: Shared Secret / API Key
 * Returns a static header with a secret value.
 *
 * @example
 * ```typescript
 * const auth = sharedSecretAuth("X-Internal-Auth", process.env.INTERNAL_SECRET);
 * ```
 */
export function sharedSecretAuth(headerName: string, secret: string): AuthHeaderProvider {
	return async () => ({ [headerName]: secret });
}

/**
 * Strategy 2: Signed JWT (Service-to-Service)
 * Uses the existing AccessTokenIssuer to sign a short-lived JWT.
 * Useful when AgentGate is configured with RS256 keys and the backend has the public key.
 *
 * @example
 * ```typescript
 * const auth = signedJwtAuth(tokenIssuer, "backend-service");
 * ```
 */
export function signedJwtAuth(
	issuer: AccessTokenIssuer,
	audience: string, // resourceId in claims
	ttlSeconds = 60,
): AuthHeaderProvider {
	return async () => {
		const { token } = await issuer.sign(
			{
				sub: "agentgate-service",
				jti: crypto.randomUUID(),
				resourceId: audience,
				tierId: "system",
				txHash: "system-auth",
			},
			ttlSeconds,
		);
		return { Authorization: `Bearer ${token}` };
	};
}

/**
 * Strategy 3: OAuth 2.0 Client Credentials
 * Fetches an access token from an OAuth provider using client_id/client_secret.
 * Caches the token until it expires.
 *
 * Note: Does not support refresh tokens (not needed for Client Credentials flow).
 * automatically re-fetches when the token expires.
 *
 * @example
 * ```typescript
 * const auth = oauthClientCredentialsAuth({
 *   tokenUrl: "https://auth.example.com/token",
 *   clientId: process.env.CLIENT_ID,
 *   clientSecret: process.env.CLIENT_SECRET,
 *   scopes: ["api:access"]
 * });
 * ```
 */
export function oauthClientCredentialsAuth(config: {
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scopes?: string[];
	audience?: string;
}): AuthHeaderProvider {
	let cachedToken: string | null = null;
	let expiresAt = 0;

	return async () => {
		const now = Date.now();

		// Return cached token if valid (with 10s buffer)
		if (cachedToken && now < expiresAt - 10000) {
			return { Authorization: `Bearer ${cachedToken}` };
		}

		// Fetch new token
		try {
			const body = new URLSearchParams({
				grant_type: "client_credentials",
				client_id: config.clientId,
				client_secret: config.clientSecret,
			});

			if (config.scopes?.length) {
				body.append("scope", config.scopes.join(" "));
			}
			if (config.audience) {
				body.append("audience", config.audience);
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			let res: Response;
			try {
				res = await fetch(config.tokenUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body,
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`OAuth token request failed: ${res.status} ${text}`);
			}

			const data = await res.json();

			if (!data.access_token || typeof data.expires_in !== "number") {
				throw new Error("Invalid OAuth response: missing access_token or expires_in");
			}

			cachedToken = data.access_token;
			// expires_in is in seconds
			expiresAt = now + data.expires_in * 1000;

			return { Authorization: `Bearer ${cachedToken}` };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new AgentGateError("INTERNAL_ERROR", `Failed to authenticate via OAuth: ${msg}`, 500);
		}
	};
}
