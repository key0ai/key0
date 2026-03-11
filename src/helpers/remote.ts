import type { IssueTokenParams, ResourceVerifier, TokenIssuanceResult } from "../types/index.js";
import { Key0Error } from "../types/index.js";
import { type AuthHeaderProvider, sharedSecretAuth } from "./auth.js";

export type RemoteVerifierConfig = {
	/** The backend endpoint to call (e.g. https://api.myapp.com/internal/verify) */
	url: string;
	/** Timeout in ms (default: 5000) */
	timeoutMs?: number;

	/** Authentication strategy */
	auth?: AuthHeaderProvider;

	// Legacy support (mapped to auth provider internally)
	/** @deprecated Use `auth` instead */
	secret?: string;
	/** @deprecated Use `auth` instead */
	headerName?: string;
};

export type RemoteTokenIssuerConfig = {
	/** The backend endpoint to call (e.g. https://api.myapp.com/internal/issue-token) */
	url: string;
	/** Timeout in ms (default: 10000) */
	timeoutMs?: number;

	/** Authentication strategy */
	auth?: AuthHeaderProvider;

	// Legacy support (mapped to auth provider internally)
	/** @deprecated Use `auth` instead */
	secret?: string;
	/** @deprecated Use `auth` instead */
	headerName?: string;
};

/**
 * Helper to resolve auth provider from config
 */
function resolveAuth(
	auth?: AuthHeaderProvider,
	secret?: string,
	headerName?: string,
): AuthHeaderProvider {
	if (auth) return auth;
	if (secret) {
		return sharedSecretAuth(headerName || "X-Internal-Auth", secret);
	}
	// No auth (public endpoint?)
	return async () => ({});
}

/**
 * Creates an onVerifyResource callback that calls a remote HTTP endpoint.
 * This is useful when Key0 is deployed as a separate service.
 *
 * @example
 * ```typescript
 * const verifier = createRemoteResourceVerifier({
 *   url: "https://api.myapp.com/internal/verify-resource",
 *   auth: sharedSecretAuth("X-Internal-Auth", process.env.INTERNAL_SECRET)
 * });
 * ```
 */
export function createRemoteResourceVerifier(config: RemoteVerifierConfig): ResourceVerifier {
	const getAuthHeaders = resolveAuth(config.auth, config.secret, config.headerName);

	return async (resourceId: string, tierId: string): Promise<boolean> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 5000);

		try {
			const headers = await getAuthHeaders();
			const response = await fetch(config.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body: JSON.stringify({ resourceId, tierId }),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (!response.ok) {
				console.warn(
					`[RemoteVerifier] Backend returned ${response.status} for resource ${resourceId}`,
				);
				return false;
			}

			const data = await response.json();

			// Expecting { valid: boolean } or just boolean
			if (typeof data === "boolean") return data;
			if (data && typeof data.valid === "boolean") return data.valid;

			return false;
		} catch (err: unknown) {
			clearTimeout(timeout);

			if (err instanceof Error && err.name === "AbortError") {
				throw new Key0Error("RESOURCE_VERIFY_TIMEOUT", "Remote verification timed out", 504);
			}

			console.error("[RemoteVerifier] Network error:", err);
			return false;
		}
	};
}

/**
 * Creates an onIssueToken callback that calls a remote HTTP endpoint.
 * This is useful when you want your backend to issue custom tokens/API keys
 * instead of Key0's native JWT.
 *
 * @example
 * ```typescript
 * const issuer = createRemoteTokenIssuer({
 *   url: "https://api.myapp.com/internal/issue-token",
 *   secret: process.env.INTERNAL_AUTH_SECRET
 * });
 *
 * const config = {
 *   tokenMode: "remote",
 *   onIssueToken: issuer,
 *   // ...
 * };
 * ```
 */
export function createRemoteTokenIssuer(
	config: RemoteTokenIssuerConfig,
): (params: IssueTokenParams) => Promise<TokenIssuanceResult> {
	const getAuthHeaders = resolveAuth(config.auth, config.secret, config.headerName);

	return async (params: IssueTokenParams): Promise<TokenIssuanceResult> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);

		try {
			const headers = await getAuthHeaders();
			const response = await fetch(config.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body: JSON.stringify(params),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Key0Error(
					"TOKEN_ISSUE_FAILED",
					`Backend failed to issue token: ${response.status} ${errorText}`,
					502,
				);
			}

			const data = await response.json();

			// Expecting { token: string, expiresAt: string|Date, tokenType?: string }
			if (!data.token) {
				throw new Key0Error(
					"TOKEN_ISSUE_FAILED",
					"Backend response missing 'token' field",
					502,
				);
			}

			return {
				token: data.token,
				expiresAt: data.expiresAt instanceof Date ? data.expiresAt : new Date(data.expiresAt),
				tokenType: data.tokenType || "Bearer",
			};
		} catch (err: unknown) {
			clearTimeout(timeout);

			if (err instanceof Key0Error) {
				throw err;
			}

			if (err instanceof Error && err.name === "AbortError") {
				throw new Key0Error("TOKEN_ISSUE_TIMEOUT", "Remote token issuance timed out", 504);
			}

			throw new Key0Error(
				"TOKEN_ISSUE_FAILED",
				`Network error: ${err instanceof Error ? err.message : String(err)}`,
				502,
			);
		}
	};
}
