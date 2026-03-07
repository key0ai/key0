import { describe, expect, mock, spyOn, test } from "bun:test";
import type { IssueTokenParams } from "../../types/index.js";
import { AgentGateError } from "../../types/index.js";
import { createRemoteResourceVerifier, createRemoteTokenIssuer } from "../remote.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps a test body with a temporary global.fetch mock, restoring it after. */
const withFetch =
	(mockFn: (...args: unknown[]) => unknown, fn: () => Promise<void>) => async () => {
		const original = global.fetch;
		global.fetch = mockFn as unknown as typeof global.fetch;
		try {
			await fn();
		} finally {
			global.fetch = original;
		}
	};

function makeJsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	} as unknown as Response;
}

function makeParams(overrides?: Partial<IssueTokenParams>): IssueTokenParams {
	return {
		requestId: crypto.randomUUID(),
		challengeId: crypto.randomUUID(),
		resourceId: "photo-42",
		tierId: "single",
		txHash: "0xdeadbeef",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createRemoteResourceVerifier
// ---------------------------------------------------------------------------

describe("createRemoteResourceVerifier", () => {
	test(
		"returns true when backend returns { valid: true }",
		withFetch(
			mock(async () => makeJsonResponse({ valid: true })),
			async () => {
				const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
				const result = await verifier("photo-42", "single");
				expect(result).toBe(true);
			},
		),
	);

	test(
		"returns true when backend returns bare boolean true",
		withFetch(
			mock(async () => makeJsonResponse(true)),
			async () => {
				const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
				const result = await verifier("photo-42", "single");
				expect(result).toBe(true);
			},
		),
	);

	test(
		"returns false when backend returns { valid: false }",
		withFetch(
			mock(async () => makeJsonResponse({ valid: false })),
			async () => {
				const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
				const result = await verifier("photo-42", "single");
				expect(result).toBe(false);
			},
		),
	);

	test(
		"returns false on non-2xx response (status 403) and calls console.warn",
		withFetch(
			mock(async () => makeJsonResponse("Forbidden", false, 403)),
			async () => {
				const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
				try {
					const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
					const result = await verifier("photo-42", "single");
					expect(result).toBe(false);
					expect(warnSpy).toHaveBeenCalledTimes(1);
					const warnArg = warnSpy.mock.calls[0]?.[0] as string;
					expect(warnArg).toContain("403");
				} finally {
					warnSpy.mockRestore();
				}
			},
		),
	);

	test(
		"throws AgentGateError with code RESOURCE_VERIFY_TIMEOUT and httpStatus 504 on abort",
		withFetch(
			mock(async () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}),
			async () => {
				const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
				const err = await verifier("photo-42", "single").catch((e) => e);
				expect(err).toBeInstanceOf(AgentGateError);
				expect(err.code).toBe("RESOURCE_VERIFY_TIMEOUT");
				expect(err.httpStatus).toBe(504);
			},
		),
	);

	test(
		"returns false on network error (fetch throws non-AbortError) and does NOT throw",
		withFetch(
			mock(async () => {
				throw new Error("ECONNREFUSED");
			}),
			async () => {
				const errorSpy = spyOn(console, "error").mockImplementation(() => {});
				try {
					const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
					const result = await verifier("photo-42", "single");
					expect(result).toBe(false);
				} finally {
					errorSpy.mockRestore();
				}
			},
		),
	);

	test(
		"sends auth headers from a sharedSecretAuth-style auth provider",
		withFetch(
			mock(async () => makeJsonResponse({ valid: true })),
			async () => {
				const auth = async () => ({ "X-Internal-Auth": "super-secret" });
				const verifier = createRemoteResourceVerifier({
					url: "https://example.com/verify",
					auth,
				});
				await verifier("photo-42", "single");
				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				expect((init.headers as Record<string, string>)["X-Internal-Auth"]).toBe("super-secret");
			},
		),
	);

	test(
		"sends POST body with { resourceId, tierId }",
		withFetch(
			mock(async () => makeJsonResponse({ valid: true })),
			async () => {
				const verifier = createRemoteResourceVerifier({ url: "https://example.com/verify" });
				await verifier("photo-42", "single");
				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				expect(init.method).toBe("POST");
				const body = JSON.parse(init.body as string);
				expect(body).toEqual({ resourceId: "photo-42", tierId: "single" });
			},
		),
	);
});

// ---------------------------------------------------------------------------
// createRemoteTokenIssuer
// ---------------------------------------------------------------------------

describe("createRemoteTokenIssuer", () => {
	const FUTURE_DATE = new Date(Date.now() + 3600_000).toISOString();

	test(
		"returns TokenIssuanceResult when backend returns { token, expiresAt, tokenType }",
		withFetch(
			mock(async () =>
				makeJsonResponse({ token: "tok_abc", expiresAt: FUTURE_DATE, tokenType: "Bearer" }),
			),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const result = await issuer(makeParams());
				expect(result.token).toBe("tok_abc");
				expect(result.tokenType).toBe("Bearer");
				expect(result.expiresAt).toBeInstanceOf(Date);
			},
		),
	);

	test(
		"converts expiresAt string to Date object",
		withFetch(
			mock(async () =>
				makeJsonResponse({ token: "tok_abc", expiresAt: FUTURE_DATE, tokenType: "Bearer" }),
			),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const result = await issuer(makeParams());
				expect(result.expiresAt).toBeInstanceOf(Date);
				expect(result.expiresAt.toISOString()).toBe(FUTURE_DATE);
			},
		),
	);

	test(
		"defaults tokenType to 'Bearer' when not in response",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok_abc", expiresAt: FUTURE_DATE })),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const result = await issuer(makeParams());
				expect(result.tokenType).toBe("Bearer");
			},
		),
	);

	test(
		"throws AgentGateError with code TOKEN_ISSUE_FAILED and httpStatus 502 on non-2xx response",
		withFetch(
			mock(async () => makeJsonResponse("Internal Server Error", false, 500)),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(AgentGateError);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
			},
		),
	);

	test(
		"throws AgentGateError with code TOKEN_ISSUE_FAILED when response missing 'token' field",
		withFetch(
			mock(async () => makeJsonResponse({ expiresAt: FUTURE_DATE })),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(AgentGateError);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
				expect(err.message).toContain("token");
			},
		),
	);

	test(
		"throws AgentGateError with code TOKEN_ISSUE_TIMEOUT and httpStatus 504 on abort",
		withFetch(
			mock(async () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(AgentGateError);
				expect(err.code).toBe("TOKEN_ISSUE_TIMEOUT");
				expect(err.httpStatus).toBe(504);
			},
		),
	);

	test(
		"throws AgentGateError with code TOKEN_ISSUE_FAILED and httpStatus 502 on network error",
		withFetch(
			mock(async () => {
				throw new Error("ECONNREFUSED");
			}),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(AgentGateError);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
				expect(err.message).toContain("ECONNREFUSED");
			},
		),
	);

	test(
		"sends auth headers when configured with auth strategy",
		withFetch(
			mock(async () =>
				makeJsonResponse({ token: "tok_abc", expiresAt: FUTURE_DATE, tokenType: "Bearer" }),
			),
			async () => {
				const auth = async () => ({ "X-Internal-Auth": "token-secret" });
				const issuer = createRemoteTokenIssuer({
					url: "https://example.com/issue-token",
					auth,
				});
				await issuer(makeParams());
				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				expect((init.headers as Record<string, string>)["X-Internal-Auth"]).toBe("token-secret");
			},
		),
	);
});
