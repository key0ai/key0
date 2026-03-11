import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AccessTokenIssuer } from "../../core/access-token.js";
import { Key0Error } from "../../types/index.js";
import { oauthClientCredentialsAuth, sharedSecretAuth, signedJwtAuth } from "../auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockIssuer(token = "mock-jwt"): AccessTokenIssuer {
	return {
		sign: mock(async (_claims, _ttl) => ({ token, expiresAt: new Date(Date.now() + 60_000) })),
	} as unknown as AccessTokenIssuer;
}

function makeOauthResponse(opts?: {
	ok?: boolean;
	status?: number;
	accessToken?: string;
	expiresIn?: number;
	body?: unknown;
}): Response {
	const ok = opts?.ok ?? true;
	const status = opts?.status ?? 200;
	const body =
		opts?.body ??
		(ok
			? { access_token: opts?.accessToken ?? "oauth-token", expires_in: opts?.expiresIn ?? 3600 }
			: "Bad Request");
	return {
		ok,
		status,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		json: async () => body,
	} as unknown as Response;
}

// Wraps a test body with a temporary global.fetch mock, restoring it after.
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

// ---------------------------------------------------------------------------
// sharedSecretAuth
// ---------------------------------------------------------------------------

describe("sharedSecretAuth", () => {
	test("returns the configured header name and secret value", async () => {
		const auth = sharedSecretAuth("X-Internal-Auth", "super-secret");
		const headers = await auth();
		expect(headers).toEqual({ "X-Internal-Auth": "super-secret" });
	});

	test("different calls return the same static value (no mutation)", async () => {
		const auth = sharedSecretAuth("X-Api-Key", "static-value");
		const first = await auth();
		const second = await auth();
		expect(first).toEqual(second);
		expect(first["X-Api-Key"]).toBe("static-value");
	});
});

// ---------------------------------------------------------------------------
// signedJwtAuth
// ---------------------------------------------------------------------------

describe("signedJwtAuth", () => {
	test("returns Authorization: Bearer <token> header", async () => {
		const issuer = makeMockIssuer("mock-jwt");
		const auth = signedJwtAuth(issuer, "backend-service");
		const headers = await auth();
		expect(headers).toEqual({ Authorization: "Bearer mock-jwt" });
	});

	test("calls issuer.sign with sub: 'key0-service'", async () => {
		const issuer = makeMockIssuer();
		const auth = signedJwtAuth(issuer, "backend-service");
		await auth();
		expect(issuer.sign).toHaveBeenCalledTimes(1);
		const [claims] = (issuer.sign as ReturnType<typeof mock>).mock.calls[0] as [
			{ sub: string; resourceId: string },
			number,
		];
		expect(claims.sub).toBe("key0-service");
	});

	test("calls issuer.sign with resourceId equal to the audience arg", async () => {
		const issuer = makeMockIssuer();
		const auth = signedJwtAuth(issuer, "my-backend");
		await auth();
		const [claims] = (issuer.sign as ReturnType<typeof mock>).mock.calls[0] as [
			{ resourceId: string },
			number,
		];
		expect(claims.resourceId).toBe("my-backend");
	});

	test("uses default ttlSeconds of 60 when not provided", async () => {
		const issuer = makeMockIssuer();
		const auth = signedJwtAuth(issuer, "backend-service");
		await auth();
		const [, ttl] = (issuer.sign as ReturnType<typeof mock>).mock.calls[0] as [unknown, number];
		expect(ttl).toBe(60);
	});

	test("passes custom ttlSeconds to issuer.sign", async () => {
		const issuer = makeMockIssuer();
		const auth = signedJwtAuth(issuer, "backend-service", 300);
		await auth();
		const [, ttl] = (issuer.sign as ReturnType<typeof mock>).mock.calls[0] as [unknown, number];
		expect(ttl).toBe(300);
	});
});

// ---------------------------------------------------------------------------
// oauthClientCredentialsAuth
// ---------------------------------------------------------------------------

describe("oauthClientCredentialsAuth", () => {
	// beforeEach is declared here for documentation purposes; the actual
	// fetch swap/restore is handled inside each withFetch wrapper.
	beforeEach(() => {});

	test(
		"fetches token on first call and returns Authorization: Bearer <token>",
		withFetch(
			mock(async () => makeOauthResponse({ accessToken: "first-token" })),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
				});
				const headers = await auth();
				expect(headers).toEqual({ Authorization: "Bearer first-token" });
				expect(global.fetch).toHaveBeenCalledTimes(1);
			},
		),
	);

	test(
		"caches token — second call within expiry does NOT fetch again",
		withFetch(
			mock(async () => makeOauthResponse({ accessToken: "cached-token", expiresIn: 3600 })),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
				});
				const first = await auth();
				const second = await auth();
				expect(first).toEqual({ Authorization: "Bearer cached-token" });
				expect(second).toEqual({ Authorization: "Bearer cached-token" });
				// fetch must have been called exactly once (cache hit on second call)
				expect(global.fetch).toHaveBeenCalledTimes(1);
			},
		),
	);

	test(
		"re-fetches after token expires",
		withFetch(
			mock(async () => makeOauthResponse({ accessToken: "refreshed-token", expiresIn: 0 })),
			async () => {
				// expiresIn: 0 means expiresAt = now + 0ms; the 10s buffer (now < expiresAt - 10000)
				// is always false, so every call triggers a new fetch.
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
				});
				await auth(); // first fetch
				await auth(); // should fetch again because token is expired
				expect(global.fetch).toHaveBeenCalledTimes(2);
			},
		),
	);

	test(
		"includes scope in request body when scopes configured",
		withFetch(
			mock(async () => makeOauthResponse()),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
					scopes: ["api:read", "api:write"],
				});
				await auth();
				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				const body = new URLSearchParams(init.body as string);
				expect(body.get("scope")).toBe("api:read api:write");
			},
		),
	);

	test(
		"includes audience in request body when configured",
		withFetch(
			mock(async () => makeOauthResponse()),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
					audience: "https://api.example.com",
				});
				await auth();
				const [, init] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as [
					string,
					RequestInit,
				];
				const body = new URLSearchParams(init.body as string);
				expect(body.get("audience")).toBe("https://api.example.com");
			},
		),
	);

	test(
		"throws Key0Error with code INTERNAL_ERROR on non-ok OAuth response",
		withFetch(
			mock(async () => makeOauthResponse({ ok: false, status: 401, body: "Unauthorized" })),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
				});
				const err = await auth().catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("INTERNAL_ERROR");
				expect(err.httpStatus).toBe(500);
			},
		),
	);

	test(
		"throws Key0Error with code INTERNAL_ERROR on invalid OAuth response (missing access_token)",
		withFetch(
			mock(async () => makeOauthResponse({ body: { expires_in: 3600 } })),
			async () => {
				const auth = oauthClientCredentialsAuth({
					tokenUrl: "https://auth.example.com/token",
					clientId: "client-id",
					clientSecret: "client-secret",
				});
				const err = await auth().catch((e) => e);
				expect(err).toBeInstanceOf(Key0Error);
				expect(err.code).toBe("INTERNAL_ERROR");
				expect(err.httpStatus).toBe(500);
				expect(err.message).toContain("missing access_token");
			},
		),
	);
});
