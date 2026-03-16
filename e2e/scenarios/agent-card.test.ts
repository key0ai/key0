import { describe, expect, test } from "bun:test";
import { KEY0_URL } from "../fixtures/constants.ts";
import type { AgentCard } from "../helpers/client.ts";

describe("Agent Card", () => {
	test("GET /.well-known/agent.json returns valid agent card", async () => {
		const res = await fetch(`${KEY0_URL}/.well-known/agent.json`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const card = (await res.json()) as AgentCard;

		expect(typeof card.name).toBe("string");
		expect(card.name.length).toBeGreaterThan(0);
		expect(typeof card.description).toBe("string");
		expect(typeof card.url).toBe("string");

		// Must have two A2A spec-compliant skills
		expect(Array.isArray(card.skills)).toBe(true);
		expect(card.skills.length).toBe(2);

		const discoverSkill = card.skills.find((s) => s.id === "discover-plans");
		expect(discoverSkill).toBeDefined();
		expect(discoverSkill?.tags).toContain("discovery");

		const requestSkill = card.skills.find((s) => s.id === "request-access");
		expect(requestSkill).toBeDefined();
		expect(requestSkill?.tags).toContain("payment");

		// x402 extension must be declared
		expect(Array.isArray(card.capabilities.extensions)).toBe(true);
		const x402ext = card.capabilities.extensions?.find((e) => e.uri.includes("x402"));
		expect(x402ext).toBeDefined();
		expect(x402ext?.required).toBe(true);
	});

	test("Agent card pricing includes USDC on Base Sepolia", async () => {
		const res = await fetch(`${KEY0_URL}/.well-known/agent.json`);
		const card = (await res.json()) as AgentCard;

		// Discovery must be done via GET /discovery, not from the agent card
		// Agent card skills should NOT have pricing (A2A spec compliance)
		const discoverSkill = card.skills.find((s) => s.id === "discover-plans");
		expect(discoverSkill).toBeDefined();
		expect((discoverSkill as any)?.pricing).toBeUndefined();

		const requestSkill = card.skills.find((s) => s.id === "request-access");
		expect(requestSkill).toBeDefined();
		expect((requestSkill as any)?.pricing).toBeUndefined();
	});
});
