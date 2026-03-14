/**
 * x402 Discovery — verifies the discovery flow via GET /discovery.
 *
 * GET /discovery returns HTTP 200 with all available plans.
 * No PENDING record is created — pure discovery.
 * This is the entry point for clients that don't yet know which plan to purchase.
 *
 * POST /x402/access with no planId returns HTTP 400 pointing clients to GET /discovery.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID, KEY0_URL } from "../fixtures/constants.ts";

describe("x402 Discovery", () => {
	test("GET /discovery returns 200 with all plans", async () => {
		const res = await fetch(`${KEY0_URL}/discovery`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as Record<string, unknown>;
		const discoveryResponse = body["discoveryResponse"] as Record<string, unknown>;
		expect(discoveryResponse).toBeDefined();

		const accepts = discoveryResponse["accepts"] as Array<Record<string, unknown>>;
		expect(Array.isArray(accepts)).toBe(true);
		expect(accepts.length).toBeGreaterThan(0);

		// Each plan must have required x402 fields
		const plan = accepts[0]!;
		expect(plan["scheme"]).toBe("exact");
		expect(plan["network"]).toBe("eip155:84532");
		expect(typeof plan["asset"]).toBe("string");
		expect(typeof plan["amount"]).toBe("string");
		expect(BigInt(plan["amount"] as string)).toBeGreaterThan(0n);
		expect(typeof plan["payTo"]).toBe("string");

		// Discovery plans include planId in extra
		const extra = plan["extra"] as Record<string, unknown> | undefined;
		expect(typeof extra?.["planId"]).toBe("string");
		expect(extra?.["planId"]).toBe(DEFAULT_TIER_ID);

		// x402Version must be set
		expect(discoveryResponse["x402Version"]).toBe(2);
	});

	test("GET /discovery response includes key0 extensions with input/output schema", async () => {
		const res = await fetch(`${KEY0_URL}/discovery`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		const discoveryResponse = body["discoveryResponse"] as Record<string, unknown>;

		const extensions = discoveryResponse["extensions"] as Record<string, unknown> | undefined;
		expect(extensions).toBeDefined();

		const key0 = extensions?.["key0"] as Record<string, unknown> | undefined;
		expect(key0).toBeDefined();
		expect(key0?.["inputSchema"]).toBeDefined();
		expect(key0?.["outputSchema"]).toBeDefined();
	});

	test("POST /x402/access with no planId returns 400 pointing to GET /discovery", async () => {
		const res = await fetch(`${KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);

		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body["error"]).toBe("string");
		expect((body["error"] as string).toLowerCase()).toContain("discovery");
	});
});
