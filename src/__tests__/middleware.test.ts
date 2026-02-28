import { describe, expect, test } from "bun:test";
import { AccessTokenIssuer } from "../core";
import { validateToken } from "../middleware.js";
import { AgentGateError } from "../types";

const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const CLAIMS = {
	sub: "550e8400-e29b-41d4-a716-446655440000",
	jti: "660e8400-e29b-41d4-a716-446655440000",
	resourceId: "photo-42",
	tierId: "single",
	txHash: `0x${"ab".repeat(32)}`,
};

describe("validateToken", () => {
	test("returns decoded payload for valid token", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const header = `Bearer ${token}`;

		const payload = await validateToken(header, { secret: SECRET });
		expect(payload.sub).toBe(CLAIMS.sub);
		expect(payload.jti).toBe(CLAIMS.jti);
		expect(payload.resourceId).toBe(CLAIMS.resourceId);
		expect(payload.tierId).toBe(CLAIMS.tierId);
		expect(payload.txHash).toBe(CLAIMS.txHash);
	});

	test("throws for missing Authorization header", async () => {
		try {
			await validateToken(undefined, { secret: SECRET });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
			expect((err as AgentGateError).httpStatus).toBe(401);
		}
	});

	test("throws for null Authorization header", async () => {
		try {
			await validateToken(null, { secret: SECRET });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
		}
	});

	test("throws for malformed Authorization header (no Bearer)", async () => {
		try {
			await validateToken("Token abc123", { secret: SECRET });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
			expect((err as AgentGateError).message).toContain("Missing or malformed");
		}
	});

	test("throws for tampered token", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);
		const tampered = `Bearer ${token}x`;

		try {
			await validateToken(tampered, { secret: SECRET });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
			expect((err as AgentGateError).httpStatus).toBe(401);
		}
	});

	test("throws for token signed with wrong secret", async () => {
		const issuer = new AccessTokenIssuer(SECRET);
		const { token } = await issuer.sign(CLAIMS, 3600);

		try {
			await validateToken(`Bearer ${token}`, {
				secret: "a-completely-different-secret-that-is-32-chars!",
			});
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
			expect((err as AgentGateError).httpStatus).toBe(401);
		}
	});

	test("throws for empty Bearer token", async () => {
		try {
			await validateToken("Bearer ", { secret: SECRET });
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentGateError);
		}
	});
});
