/**
 * Invalid Tier — verifies that requesting a nonexistent tierId returns an error.
 *
 * The /a2a/access endpoint validates the tier before creating a challenge.
 * No on-chain tx needed.
 */

import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL } from "../fixtures/constants.ts";

describe("Invalid Tier", () => {
	test("nonexistent tierId returns 400 TIER_NOT_FOUND", async () => {
		const res = await fetch(`${AGENTGATE_URL}/a2a/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tierId: "nonexistent-tier-xyz",
				requestId: crypto.randomUUID(),
				resourceId: "test-resource",
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["code"]).toBe("TIER_NOT_FOUND");
	});

	test("missing tierId returns 400", async () => {
		const res = await fetch(`${AGENTGATE_URL}/a2a/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: crypto.randomUUID() }),
		});

		expect(res.status).toBe(400);
	});
});
