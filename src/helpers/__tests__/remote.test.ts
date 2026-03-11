import { describe, expect, mock, test } from "bun:test";
import type { IssueTokenParams } from "../../types/index.js";
import { Key0Error } from "../../types/index.js";
import { createRemoteTokenIssuer } from "../remote.js";

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
		planId: "single",
		txHash: "0xdeadbeef",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createRemoteTokenIssuer
// ---------------------------------------------------------------------------

describe("createRemoteTokenIssuer", () => {
	test(
		"returns TokenIssuanceResult when backend returns { token, tokenType }",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok_abc", tokenType: "Bearer" })),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const result = await issuer(makeParams());
				expect(result.token).toBe("tok_abc");
				expect(result.tokenType).toBe("Bearer");
			},
		),
	);

	test(
		"defaults tokenType to 'Bearer' when not in response",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok_abc" })),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const result = await issuer(makeParams());
				expect(result.tokenType).toBe("Bearer");
			},
		),
	);

	test(
		"throws Key0Error with code TOKEN_ISSUE_FAILED and httpStatus 502 on non-2xx response",
		withFetch(
			mock(async () => makeJsonResponse("Internal Server Error", false, 500)),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
			},
		),
	);

	test(
		"throws Key0Error with code TOKEN_ISSUE_FAILED when response missing 'token' field",
		withFetch(
			mock(async () => makeJsonResponse({ someField: "no-token" })),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
				expect(err.message).toContain("token");
			},
		),
	);

	test(
		"throws Key0Error with code TOKEN_ISSUE_TIMEOUT and httpStatus 504 on abort",
		withFetch(
			mock(async () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("TOKEN_ISSUE_TIMEOUT");
				expect(err.httpStatus).toBe(504);
			},
		),
	);

	test(
		"throws Key0Error with code TOKEN_ISSUE_FAILED and httpStatus 502 on network error",
		withFetch(
			mock(async () => {
				throw new Error("ECONNREFUSED");
			}),
			async () => {
				const issuer = createRemoteTokenIssuer({ url: "https://example.com/issue-token" });
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("TOKEN_ISSUE_FAILED");
				expect(err.httpStatus).toBe(502);
				expect(err.message).toContain("ECONNREFUSED");
			},
		),
	);

	test(
		"sends auth headers when configured with auth strategy",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok_abc", tokenType: "Bearer" })),
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
