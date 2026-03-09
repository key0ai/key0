import type { IssueTokenParams, ProductTier, TokenIssuanceResult } from "../types/index.js";
import { AgentGateError } from "../types/index.js";

export type DockerTokenIssuerOptions = {
	/** Bearer secret for ISSUE_TOKEN_API requests (optional) */
	apiSecret?: string;
	/** Product catalog — used to merge tier fields into request body and read accessDurationSeconds */
	products?: readonly ProductTier[];
};

/**
 * Builds an `onIssueToken` callback suitable for the Docker standalone server.
 *
 * Behaviour:
 * - Merges the matching ProductTier fields into the POST body sent to `issueTokenApiUrl`.
 * - If the response has a `{ token: string }` field, passes it through directly.
 * - Otherwise (e.g. `{ apiKey, apiSecret }`) JSON-serialises the full response as the token
 *   with `tokenType: "custom"`.
 * - `expiresAt` comes from the response when present, otherwise falls back to the tier's
 *   `accessDurationSeconds` (default 3600 s).
 */
export function buildDockerTokenIssuer(
	issueTokenApiUrl: string,
	options: DockerTokenIssuerOptions = {},
): (params: IssueTokenParams) => Promise<TokenIssuanceResult> {
	const { apiSecret, products = [] } = options;

	return async (params: IssueTokenParams): Promise<TokenIssuanceResult> => {
		const tier = products.find((p) => p.tierId === params.tierId);

		// Merge IssueTokenParams with the matching product tier (includes custom fields)
		const body = { ...params, ...(tier ?? {}) };

		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiSecret) {
			headers["Authorization"] = `Bearer ${apiSecret}`;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		let res: Response;
		try {
			res = await fetch(issueTokenApiUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new AgentGateError("TOKEN_ISSUE_TIMEOUT", "Token issuance timed out", 504);
			}
			throw new AgentGateError(
				"TOKEN_ISSUE_FAILED",
				`Network error: ${err instanceof Error ? err.message : String(err)}`,
				502,
			);
		} finally {
			clearTimeout(timeout);
		}

		if (!res.ok) {
			const errorText = await res.text().catch(() => "");
			throw new AgentGateError(
				"TOKEN_ISSUE_FAILED",
				`ISSUE_TOKEN_API returned ${res.status}: ${errorText}`,
				502,
			);
		}

		const data = (await res.json()) as Record<string, unknown>;

		// Passthrough: if response has a `token` string field, use it directly
		if (typeof data["token"] === "string") {
			const expiresAt =
				typeof data["expiresAt"] === "string"
					? new Date(data["expiresAt"])
					: new Date(Date.now() + (tier?.accessDurationSeconds ?? 3600) * 1000);
			return {
				token: data["token"],
				expiresAt,
				...(typeof data["tokenType"] === "string" ? { tokenType: data["tokenType"] } : {}),
			};
		}

		// No `token` field (e.g. { apiKey, apiSecret }) — JSON-serialize the full response
		const accessDurationSeconds = tier?.accessDurationSeconds ?? 3600;
		return {
			token: JSON.stringify(data),
			expiresAt: new Date(Date.now() + accessDurationSeconds * 1000),
			tokenType: "custom",
		};
	};
}
