import { describe, expect, test } from "bun:test";
import { AccessTokenIssuer } from "../access-token.js";

const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const CLAIMS = {
	sub: "550e8400-e29b-41d4-a716-446655440000",
	jti: "660e8400-e29b-41d4-a716-446655440000",
	resourceId: "photo-42",
	planId: "single",
	txHash: `0x${"ab".repeat(32)}`,
};

describe("AccessTokenIssuer", () => {
	test("constructor rejects short secret", () => {
		expect(() => new AccessTokenIssuer("short")).toThrow("at least 32 characters");
	});

	test("constructor accepts 32+ char secret", () => {
		expect(() => new AccessTokenIssuer(SECRET)).not.toThrow();
	});

	test("sign returns token", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const result = await issuer.sign(CLAIMS, 3600);
		expect(result.token).toBeTypeOf("string");
		expect(result.token.length).toBeGreaterThan(0);
	});

	test("verify returns correct claims", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const decoded = await issuer.verify(token);
		expect(decoded.sub).toBe(CLAIMS.sub);
		expect(decoded.jti).toBe(CLAIMS.jti);
		expect(decoded.resourceId).toBe(CLAIMS.resourceId);
		expect(decoded.planId).toBe(CLAIMS.planId);
		expect(decoded.txHash).toBe(CLAIMS.txHash);
	});

	test("verify includes iat and exp", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const decoded = await issuer.verify(token);
		expect(decoded.iat).toBeTypeOf("number");
		expect(decoded.exp).toBeTypeOf("number");
		expect(decoded.exp - decoded.iat).toBe(3600);
	});

	test("verify rejects tampered token", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const tampered = `${token}x`;
		await expect(issuer.verify(tampered)).rejects.toThrow();
	});

	test("verify rejects token signed with different secret", async () => {
		const issuer1 = new AccessTokenIssuer(SECRET);
		const issuer2 = new AccessTokenIssuer("a-completely-different-secret-that-is-32-chars!");
		const { token } = await issuer1.sign(CLAIMS, 3600);
		await expect(issuer2.verify(token)).rejects.toThrow();
	});

	test("verifyWithFallback succeeds with primary secret", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const decoded = await issuer.verifyWithFallback(token, []);
		expect(decoded.sub).toBe(CLAIMS.sub);
	});

	test("verifyWithFallback succeeds with fallback secret", async () => {
		const fallbackSecret = "another-secret-that-is-at-least-32-characters!!";
		const fallbackIssuer = new AccessTokenIssuer(fallbackSecret);
		const { token } = await fallbackIssuer.sign(CLAIMS, 3600);

		// Primary secret is different, but fallback matches
		const primaryIssuer = new AccessTokenIssuer(SECRET);
		const decoded = await primaryIssuer.verifyWithFallback(token, [fallbackSecret]);
		expect(decoded.sub).toBe(CLAIMS.sub);
	});

	test("verifyWithFallback throws when all secrets fail", async () => {
		const otherIssuer = new AccessTokenIssuer("completely-unrelated-secret-at-least-32-chars!!");
		const { token } = await otherIssuer.sign(CLAIMS, 3600);

		const primaryIssuer = new AccessTokenIssuer(SECRET);
		await expect(
			primaryIssuer.verifyWithFallback(token, ["yet-another-wrong-secret-at-least-32-chars!!"]),
		).rejects.toThrow("Token verification failed with all secrets");
	});

	test("sign embeds exp claim in JWT", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const result = await issuer.sign(CLAIMS, 60);
		const decoded = await issuer.verify(result.token);
		expect(decoded.exp - decoded.iat).toBe(60);
	});
});
