import { describe, expect, test } from "bun:test";
import type { SellerConfig } from "../../types";
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
		products: [
			{
				tierId: "single",
				label: "Single Photo",
				amount: "$0.10",
				resourceType: "photo",
			},
		],
		onIssueToken: async () => ({ token: "test-token", expiresAt: new Date() }),
		onVerifyResource: async () => true,
		...overrides,
	};
}

describe("buildAgentCard", () => {
	test("returns card with correct name and description", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.name).toBe("Test Agent");
		expect(card.description).toBe("A test agent");
	});

	test("returns card with correct url and version", () => {
		const card = buildAgentCard(makeConfig({ version: "2.0.0" }));
		expect(card.url).toBe("https://agent.example.com/a2a/jsonrpc");
		expect(card.version).toBe("2.0.0");
	});

	test("defaults version to 1.0.0", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.version).toBe("1.0.0");
	});

	test("includes a2a capability and x402 protocol", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.capabilities.a2a).toBe(true);
		expect(card.capabilities.paymentProtocols).toContain("x402");
	});

	test("has two skills: request-access and submit-proof", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.skills).toHaveLength(2);
		expect(card.skills[0]!.id).toBe("request-access");
		expect(card.skills[1]!.id).toBe("submit-proof");
	});

	test("request-access skill has pricing from product tiers", () => {
		const card = buildAgentCard(makeConfig());
		const requestSkill = card.skills[0]!;
		expect(requestSkill.pricing).toHaveLength(1);
		expect(requestSkill.pricing![0]!.tierId).toBe("single");
		expect(requestSkill.pricing![0]!.amount).toBe("$0.10");
		expect(requestSkill.pricing![0]!.asset).toBe("USDC");
		expect(requestSkill.pricing![0]!.chainId).toBe(84532); // testnet
	});

	test("multiple tiers produce multiple pricing entries", () => {
		const config = makeConfig({
			products: [
				{ tierId: "basic", label: "Basic", amount: "$0.10", resourceType: "photo" },
				{ tierId: "premium", label: "Premium", amount: "$1.00", resourceType: "photo" },
				{ tierId: "bulk", label: "Bulk", amount: "$5.00", resourceType: "photo" },
			],
		});
		const card = buildAgentCard(config);
		const requestSkill = card.skills[0]!;
		expect(requestSkill.pricing).toHaveLength(3);
		expect(requestSkill.pricing![0]!.tierId).toBe("basic");
		expect(requestSkill.pricing![1]!.tierId).toBe("premium");
		expect(requestSkill.pricing![2]!.tierId).toBe("bulk");
	});

	test("mainnet uses correct chainId", () => {
		const config = makeConfig({ network: "mainnet" });
		const card = buildAgentCard(config);
		const requestSkill = card.skills[0]!;
		expect(requestSkill.pricing![0]!.chainId).toBe(8453);
	});

	test("provider info is correct", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.provider!.name).toBe("Test Provider");
		expect(card.provider!.url).toBe("https://provider.example.com");
	});

	test("default modes are application/json", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.defaultInputModes).toContain("application/json");
		expect(card.defaultOutputModes).toContain("application/json");
	});
});
