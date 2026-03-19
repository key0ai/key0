/**
 * x402 Discovery — verifies the discovery flow via GET /discover.
 *
 * GET /discover returns HTTP 200 with all available plans and routes.
 * No PENDING record is created — pure discovery.
 * This is the entry point for clients that don't yet know which plan/route to use.
 *
 * POST /x402/access with no planId/routeId returns HTTP 400 pointing clients to GET /discover.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID, KEY0_URL } from "../fixtures/constants.ts";

describe("x402 Discovery", () => {
	test("GET /discover returns 200 with plans array", async () => {
		const res = await fetch(`${KEY0_URL}/discover`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as Record<string, unknown>;

		// Response is unwrapped — no discoveryResponse wrapper
		expect(body["discoveryResponse"]).toBeUndefined();

		// plans is a top-level array
		const plans = body["plans"] as Array<Record<string, unknown>>;
		expect(Array.isArray(plans)).toBe(true);
		expect(plans.length).toBeGreaterThan(0);

		// Each plan must have required fields
		const plan = plans[0]!;
		expect(typeof plan["planId"]).toBe("string");
		expect(plan["planId"]).toBe(DEFAULT_TIER_ID);
		expect(typeof plan["unitAmount"]).toBe("string");
	});

	test("GET /discover returns routes array at top level", async () => {
		const res = await fetch(`${KEY0_URL}/discover`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;

		// routes is a top-level array (may be empty for the default stack which has no routes)
		expect(Array.isArray(body["routes"])).toBe(true);

		// No discoveryResponse wrapper
		expect(body["discoveryResponse"]).toBeUndefined();
	});

	test("GET /discover response has agentName at top level", async () => {
		const res = await fetch(`${KEY0_URL}/discover`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		// agentName is top-level (not inside a wrapper)
		expect(typeof body["agentName"]).toBe("string");
		expect((body["agentName"] as string).length).toBeGreaterThan(0);
	});

	test("POST /x402/access with no planId returns 400 pointing to GET /discover", async () => {
		const res = await fetch(`${KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);

		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body["error"]).toBe("string");
		// Error message should reference discover endpoint
		const errMsg = (body["error"] as string).toLowerCase();
		expect(errMsg.includes("discover") || errMsg.includes("plan") || errMsg.includes("route")).toBe(
			true,
		);
	});
});
