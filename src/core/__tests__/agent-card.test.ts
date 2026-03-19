import { describe, expect, it, test } from "bun:test";
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
		expect(card.skills[0]!.id).toBe("discover");
		expect(card.skills[1]!.id).toBe("access");
	});

	test("discover skill has correct structure", () => {
		const card = buildAgentCard(makeConfig());
		const skill = card.skills[0]!;

		expect(skill.id).toBe("discover");
		expect(skill.name).toBe("Discover");
		expect(skill.description).toContain("Browse available");
		expect(skill.description).toContain("/discover");
		expect(skill.tags).toContain("discovery");
		expect(skill.tags).toContain("catalog");
		expect(skill.examples).toBeDefined();
		expect(skill.examples!.length).toBeGreaterThan(0);

		// A2A spec: skills should NOT have pricing, outputSchema, url
		expect((skill as any).pricing).toBeUndefined();
		expect((skill as any).outputSchema).toBeUndefined();
		expect((skill as any).url).toBeUndefined();
	});

	test("access skill has correct structure", () => {
		const card = buildAgentCard(makeConfig());
		const skill = card.skills[1]!;

		expect(skill.id).toBe("access");
		expect(skill.name).toBe("Access");
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
		expect(discoverSkill.examples!.some((ex) => ex.includes("/discover"))).toBe(true);

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
		expect(card.skills[0]!.id).toBe("discover");
		expect(card.skills[1]!.id).toBe("access");
	});

	test("mainnet configuration works", () => {
		const config = makeConfig({ network: "mainnet" });
		const card = buildAgentCard(config);

		// Verify description mentions mainnet
		const discoverSkill = card.skills[0]!;
		expect(discoverSkill.description).toContain("base");
	});
});

function makeSellerConfig(overrides?: Partial<SellerConfig>): SellerConfig {
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

describe("skill renames", () => {
	it("uses id 'discover' (not discover-plans)", () => {
		const card = buildAgentCard(makeSellerConfig());
		const ids = card.skills.map((s) => s.id);
		expect(ids).toContain("discover");
		expect(ids).not.toContain("discover-plans");
	});

	it("uses id 'access' (not request-access)", () => {
		const card = buildAgentCard(makeSellerConfig());
		const ids = card.skills.map((s) => s.id);
		expect(ids).toContain("access");
		expect(ids).not.toContain("request-access");
	});

	it("discover skill endpoint points to /discover", () => {
		const card = buildAgentCard(makeSellerConfig());
		const skill = card.skills.find((s) => s.id === "discover")!;
		expect(skill.endpoint?.url).toContain("/discover");
	});
});

describe("per-route skills from config.routes", () => {
	it("builds one skill per config.routes entry", () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [
				{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" },
			],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const card = buildAgentCard(config);
		const routeSkill = card.skills.find((s) => s.id.startsWith("ppr-weather"));
		expect(routeSkill).toBeDefined();
		const props = routeSkill?.inputSchema?.["properties"] as Record<string, unknown> | undefined;
		expect(props?.["routeId"]).toBeDefined();
	});

	it("does NOT build skills from plans[].routes (old API)", () => {
		const config = makeSellerConfig();
		const card = buildAgentCard(config);
		// No skills with ppr- prefix when config.routes is empty
		const pprSkills = card.skills.filter((s) => s.id.startsWith("ppr-"));
		expect(pprSkills).toHaveLength(0);
	});
});
