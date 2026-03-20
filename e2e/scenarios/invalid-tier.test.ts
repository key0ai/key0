/**
 * Invalid Plan — verifies that requesting a nonexistent planId returns an error.
 *
 * The /x402/access endpoint validates the plan before creating a challenge.
 * No on-chain tx needed.
 */

import { describe, expect, test } from "bun:test";
import { KEY0_URL } from "../fixtures/constants.ts";

describe("Invalid Plan", () => {
	test("nonexistent planId returns 404 TIER_NOT_FOUND", async () => {
		const res = await fetch(`${KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				planId: "nonexistent-tier-xyz",
				requestId: crypto.randomUUID(),
				resourceId: "test-resource",
			}),
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["code"]).toBe("TIER_NOT_FOUND");
	});

	test("missing planId returns 400 pointing to GET /discover", async () => {
		// POST /x402/access with no planId returns 400 — clients should use GET /discover instead
		const res = await fetch(`${KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: crypto.randomUUID() }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body["error"]).toBe("string");
		expect((body["error"] as string).toLowerCase()).toContain("discovery");
	});
});
