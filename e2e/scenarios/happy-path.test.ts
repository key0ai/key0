import { describe, expect, test } from "bun:test";
import { BACKEND_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

describe("Happy Path: full purchase → JWT → protected API", () => {
	test("purchase access and call protected API with Bearer token", async () => {
		const client = makeClientE2eClient();

		const { requestId, challengeId, grant } = await client.purchaseAccessWithFreshChallengeRetry({
			planId: DEFAULT_TIER_ID,
			resourceId: "resource-1",
		});
		expect(typeof challengeId).toBe("string");
		expect(challengeId.length).toBeGreaterThan(0);
		expect(grant.type).toBe("AccessGrant");
		expect(typeof grant.accessToken).toBe("string");
		expect(grant.tokenType).toBe("Bearer");
		expect(typeof grant.txHash).toBe("string");
		expect(grant.txHash).toMatch(/^0x/);
		expect(grant.challengeId).toBe(challengeId);
		expect(grant.requestId).toBe(requestId);

		// Step 4: Call backend's protected API with Bearer token
		const apiRes = await fetch(`${BACKEND_URL}/api/resource/resource-1`, {
			headers: { Authorization: `Bearer ${grant.accessToken}` },
		});

		expect(apiRes.status).toBe(200);
		const apiBody = (await apiRes.json()) as Record<string, unknown>;
		expect(apiBody["data"]).toBe("resource content");
		expect(apiBody["resourceId"]).toBe("resource-1");
	}, 120_000);

	test("rejected request without token returns 401", async () => {
		const res = await fetch(`${BACKEND_URL}/api/resource/resource-1`);
		expect(res.status).toBe(401);
	});

	test("invalid token returns 401", async () => {
		const res = await fetch(`${BACKEND_URL}/api/resource/resource-1`, {
			headers: { Authorization: "Bearer invalid-jwt-token" },
		});
		expect(res.status).toBe(401);
	});
});
