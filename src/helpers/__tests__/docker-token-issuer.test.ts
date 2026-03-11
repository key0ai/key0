import { describe, expect, mock, test } from "bun:test";
import type { IssueTokenParams, Plan } from "../../types/index.js";
import { buildDockerTokenIssuer } from "../docker-token-issuer.js";

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

function makeProduct(overrides?: Partial<Plan>): Plan {
	return {
		planId: "single",
		unitAmount: "$0.10",
		...overrides,
	};
}

const API_URL = "https://token-api.example.com/issue";

// ---------------------------------------------------------------------------
// response parsing — passthrough (`token` field present)
// ---------------------------------------------------------------------------

describe("response parsing — passthrough (token field present)", () => {
	test(
		"uses token string directly from { token } response",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				const result = await issuer(makeParams());
				expect(result.token).toBe("tok-123");
			},
		),
	);

	test(
		"includes tokenType from response when present",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123", tokenType: "custom-jwt" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				const result = await issuer(makeParams());
				expect(result.tokenType).toBe("custom-jwt");
			},
		),
	);

	test(
		"omits tokenType key from result when not in response",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				const result = await issuer(makeParams());
				expect("tokenType" in result).toBe(false);
			},
		),
	);
});

// ---------------------------------------------------------------------------
// response parsing — JSON-stringify fallback (no `token` field)
// ---------------------------------------------------------------------------

describe("response parsing — JSON-stringify fallback (no token field)", () => {
	test(
		"serializes full response as token and sets tokenType to 'custom'",
		withFetch(
			mock(async () => makeJsonResponse({ apiKey: "k1", apiSecret: "s1" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				const result = await issuer(makeParams());
				expect(result.token).toBe(JSON.stringify({ apiKey: "k1", apiSecret: "s1" }));
				expect(result.tokenType).toBe("custom");
			},
		),
	);
});

// ---------------------------------------------------------------------------
// body merging
// ---------------------------------------------------------------------------

describe("request body", () => {
	test(
		"merges product tier fields into POST body",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123" })),
			async () => {
				const product = makeProduct({
					planId: "single",
					description: "A single photo",
				});
				const issuer = buildDockerTokenIssuer(API_URL, { plans: [product] });
				const params = makeParams({ planId: "single" });
				await issuer(params);

				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				const body = JSON.parse(init.body as string);
				expect(body.description).toBe("A single photo");
				// IssueTokenParams fields are also present
				expect(body.planId).toBe("single");
				expect(body.resourceId).toBe("photo-42");
			},
		),
	);
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
	test(
		"throws Error containing the status code when API returns non-ok (status 500)",
		withFetch(
			mock(async () => makeJsonResponse("Internal Server Error", false, 500)),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				const err = await issuer(makeParams()).catch((e) => e);
				expect(err).toBeInstanceOf(Error);
				expect(err.message).toContain("500");
			},
		),
	);
});

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

describe("authentication", () => {
	test(
		"includes Authorization: Bearer <secret> header when apiSecret is configured",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL, { apiSecret: "my-api-secret" });
				await issuer(makeParams());

				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				const headers = init.headers as Record<string, string>;
				expect(headers["Authorization"]).toBe("Bearer my-api-secret");
			},
		),
	);

	test(
		"omits Authorization header when no secret configured",
		withFetch(
			mock(async () => makeJsonResponse({ token: "tok-123" })),
			async () => {
				const issuer = buildDockerTokenIssuer(API_URL);
				await issuer(makeParams());

				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				const headers = init.headers as Record<string, string>;
				expect("Authorization" in headers).toBe(false);
			},
		),
	);
});
