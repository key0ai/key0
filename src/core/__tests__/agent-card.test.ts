import { describe, expect, test } from "bun:test";
import type { SellerConfig } from "../../types";
import { X402_EXTENSION_URI } from "../../types";
import { buildAgentCard } from "../agent-card.js";

function makeConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "A test agent",
		agentUrl: "https://agent.example.com",
		providerName: "Test Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
		network: "testnet",
		plans: [{ planId: "single", unitAmount: "$0.10" }],
		fetchResourceCredentials: async () => ({ token: "test-token" }),
		...overrides,
	};
}

describe("buildAgentCard", () => {
	test("returns card with correct name and description", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.name).toBe("Test Agent");
		expect(card.description).toContain("A test agent");
	});

	test("description includes agent description", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.description).toContain("A test agent");
	});

	test("returns card with correct url and version", () => {
		const card = buildAgentCard(makeConfig({ version: "2.0.0" }));
		expect(card.url).toBe("https://agent.example.com/x402/access");
		expect(card.version).toBe("2.0.0");
	});

	test("defaults version to 1.0.0", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.version).toBe("1.0.0");
	});

	test("includes standard A2A capabilities", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.capabilities.pushNotifications).toBe(false);
		expect(card.capabilities.streaming).toBe(false);
		expect(card.capabilities.stateTransitionHistory).toBe(false);
	});

	test("declares x402 extension in capabilities", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.capabilities.extensions).toBeDefined();
		expect(card.capabilities.extensions!.length).toBe(1);

		const ext = card.capabilities.extensions![0]!;
		expect(ext.uri).toBe(X402_EXTENSION_URI);
		expect(ext.required).toBe(true);
		expect(ext.description).toContain("x402");
	});

	test("has two A2A spec-compliant skills", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.skills).toHaveLength(2);
		expect(card.skills[0]!.id).toBe("discover-plans");
		expect(card.skills[1]!.id).toBe("request-access");
	});

	test("discover-plans skill has correct structure", () => {
		const card = buildAgentCard(makeConfig());
		const skill = card.skills[0]!;

		expect(skill.id).toBe("discover-plans");
		expect(skill.name).toBe("Discover Plans");
		expect(skill.description).toContain("Browse available");
		expect(skill.description).toContain("/discovery");
		expect(skill.tags).toContain("discovery");
		expect(skill.tags).toContain("catalog");
		expect(skill.examples).toBeDefined();
		expect(skill.examples!.length).toBeGreaterThan(0);

		// A2A spec: skills should NOT have pricing, outputSchema, url
		expect((skill as any).pricing).toBeUndefined();
		expect((skill as any).outputSchema).toBeUndefined();
		expect((skill as any).url).toBeUndefined();
	});

	test("request-access skill has correct structure", () => {
		const card = buildAgentCard(makeConfig());
		const skill = card.skills[1]!;

		expect(skill.id).toBe("request-access");
		expect(skill.name).toBe("Request Access");
		expect(skill.description).toContain("Purchase access");
		expect(skill.description).toContain("x402 payment");
		expect(skill.tags).toContain("payment");
		expect(skill.tags).toContain("x402");
		expect(skill.tags).toContain("purchase");
		expect(skill.examples).toBeDefined();
		expect(skill.examples!.length).toBeGreaterThan(0);

		// inputSchema is present for machine-readable validation
		expect((skill as any).inputSchema).toBeDefined();
		expect((skill as any).inputSchema.required).toContain("planId");
		expect((skill as any).inputSchema.required).toContain("requestId");

		// A2A spec: skills should NOT have pricing, outputSchema, url
		expect((skill as any).pricing).toBeUndefined();
		expect((skill as any).outputSchema).toBeUndefined();
		expect((skill as any).url).toBeUndefined();
	});

	test("skills have examples", () => {
		const card = buildAgentCard(makeConfig());

		const discoverSkill = card.skills[0]!;
		expect(discoverSkill.examples).toBeDefined();
		expect(discoverSkill.examples!.length).toBeGreaterThan(0);
		expect(discoverSkill.examples!.some((ex) => ex.includes("/discovery"))).toBe(true);

		const requestSkill = card.skills[1]!;
		expect(requestSkill.examples).toBeDefined();
		expect(requestSkill.examples!.length).toBeGreaterThan(0);
		expect(requestSkill.examples!.some((ex) => ex.includes("planId"))).toBe(true);
	});

	test("provider info is correct", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.provider!.organization).toBe("Test Provider");
		expect(card.provider!.url).toBe("https://provider.example.com");
	});

	test("protocol version matches A2A v0.3.0 spec", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.protocolVersion).toBe("0.3.0");
	});

	test("default input modes are text, output modes are application/json", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.defaultInputModes).toContain("text");
		expect(card.defaultOutputModes).toContain("application/json");
	});

	test("card works with multiple product tiers", () => {
		const config = makeConfig({
			plans: [
				{ planId: "basic", unitAmount: "$0.10" },
				{ planId: "premium", unitAmount: "$1.00" },
				{ planId: "bulk", unitAmount: "$5.00" },
			],
		});
		const card = buildAgentCard(config);

		// Still just two skills regardless of tier count
		expect(card.skills).toHaveLength(2);
		expect(card.skills[0]!.id).toBe("discover-plans");
		expect(card.skills[1]!.id).toBe("request-access");
	});

	test("mainnet configuration works", () => {
		const config = makeConfig({ network: "mainnet" });
		const card = buildAgentCard(config);

		// Verify description mentions mainnet
		const discoverSkill = card.skills[0]!;
		expect(discoverSkill.description).toContain("base");
	});
});
