/**
 * x402 Discovery — verifies the discovery flow via POST /x402/access with no tierId.
 *
 * When a client POSTs to /x402/access without a tierId, AgentGate returns HTTP 402
 * with all available tiers in the accepts array. No PENDING record is created.
 * This is the entry point for clients that don't yet know which tier to purchase.
 */

import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";

describe("x402 Discovery", () => {
	test("POST /x402/access with no body returns 402 with all tiers", async () => {
		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(402);

		const body = (await res.json()) as Record<string, unknown>;
		const accepts = body["accepts"] as Array<Record<string, unknown>>;

		expect(Array.isArray(accepts)).toBe(true);
		expect(accepts.length).toBeGreaterThan(0);

		// Each tier in accepts must have required x402 fields
		const tier = accepts[0]!;
		expect(tier["scheme"]).toBe("exact");
		expect(tier["network"]).toBe("eip155:84532");
		expect(typeof tier["asset"]).toBe("string");
		expect(typeof tier["amount"]).toBe("string");
		expect(BigInt(tier["amount"] as string)).toBeGreaterThan(0n);
		expect(typeof tier["payTo"]).toBe("string");

		// Discovery tiers include tierId in extra
		const extra = tier["extra"] as Record<string, unknown> | undefined;
		expect(typeof extra?.["tierId"]).toBe("string");
		expect(extra?.["tierId"]).toBe(DEFAULT_TIER_ID);

		// No challengeId — pure discovery, no PENDING record created
		expect(body["challengeId"]).toBeUndefined();

		// payment-required header is set
		const header = res.headers.get("payment-required");
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf-8"));
		expect(decoded.x402Version).toBe(2);
	});

	test("discovery response includes agentgate extensions with input/output schema", async () => {
		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(402);
		const body = (await res.json()) as Record<string, unknown>;

		const extensions = body["extensions"] as Record<string, unknown> | undefined;
		expect(extensions).toBeDefined();

		const agentgate = extensions?.["agentgate"] as Record<string, unknown> | undefined;
		expect(agentgate).toBeDefined();
		expect(agentgate?.["inputSchema"]).toBeDefined();
		expect(agentgate?.["outputSchema"]).toBeDefined();
	});

	test("www-authenticate header is set on discovery response", async () => {
		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(402);
		const wwwAuth = res.headers.get("www-authenticate");
		expect(wwwAuth).toBeTruthy();
		expect(wwwAuth).toContain("Payment");
	});
});
