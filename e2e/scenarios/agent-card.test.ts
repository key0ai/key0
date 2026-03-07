import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import type { AgentCard } from "../helpers/client.ts";

describe("Agent Card", () => {
	test("GET /.well-known/agent.json returns valid agent card", async () => {
		const res = await fetch(`${AGENTGATE_URL}/.well-known/agent.json`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const card = (await res.json()) as AgentCard;

		expect(typeof card.name).toBe("string");
		expect(card.name.length).toBeGreaterThan(0);
		expect(typeof card.description).toBe("string");
		expect(typeof card.url).toBe("string");

		// Must have skills
		expect(Array.isArray(card.skills)).toBe(true);
		expect(card.skills.length).toBeGreaterThan(0);

		// Must have a "request-access" skill
		const requestSkill = card.skills.find((s) => s.id === DEFAULT_TIER_ID);
		expect(requestSkill).toBeDefined();
		expect(Array.isArray(requestSkill?.pricing)).toBe(true);
		expect(requestSkill?.pricing?.length ?? 0).toBeGreaterThan(0);

		// x402 extension must be declared
		expect(Array.isArray(card.capabilities.extensions)).toBe(true);
		const x402ext = card.capabilities.extensions?.find((e) => e.uri.includes("x402"));
		expect(x402ext).toBeDefined();
		expect(x402ext?.required).toBe(true);
	});

	test("Agent card pricing includes USDC on Base Sepolia", async () => {
		const res = await fetch(`${AGENTGATE_URL}/.well-known/agent.json`);
		const card = (await res.json()) as AgentCard;

		const skill = card.skills.find((s) => s.id === DEFAULT_TIER_ID);
		const tier = skill?.pricing?.[0];
		expect(tier).toBeDefined();
		expect(typeof tier?.amount).toBe("string");
		// Amount should be a dollar string
		expect(tier?.amount).toMatch(/^\$/);
		expect(tier?.chainId).toBe(84532); // Base Sepolia
	});
});
