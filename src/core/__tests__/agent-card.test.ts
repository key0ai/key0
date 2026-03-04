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
		products: [
			{
				tierId: "single",
				label: "Single Photo",
				amount: "$0.10",
				resourceType: "photo",
			},
		],
		onVerifyResource: async () => true,
		onIssueToken: async () => ({
			token: "test-token",
			expiresAt: new Date(),
		}),
		...overrides,
	};
}

describe("buildAgentCard", () => {
	test("returns card with correct name and description", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.name).toBe("Test Agent");
		expect(card.description).toContain("A test agent");
	});

	test("description includes x402 payment protocol explanation", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.description).toContain("x402 payment protocol");
		expect(card.description).toContain("USDC");
		expect(card.description).toContain("HTTP 402");
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

	test("has one skill per product tier", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.skills).toHaveLength(1);
		expect(card.skills[0]!.id).toBe("single");
		expect(card.skills[0]!.name).toBe("Single Photo");
	});

	test("skill description mentions x402 and PAYMENT-REQUIRED", () => {
		const card = buildAgentCard(makeConfig());
		expect(card.skills[0]!.description).toContain("x402 payment protocol");
		expect(card.skills[0]!.description).toContain("PAYMENT-REQUIRED");
	});

	test("skill has pricing from its product tier", () => {
		const card = buildAgentCard(makeConfig());
		const skill = card.skills[0]!;
		expect(skill.pricing).toHaveLength(1);
		expect(skill.pricing![0]!.tierId).toBe("single");
		expect(skill.pricing![0]!.amount).toBe("$0.10");
		expect(skill.pricing![0]!.asset).toBe("USDC");
		expect(skill.pricing![0]!.chainId).toBe(84532); // testnet
	});

	test("multiple tiers produce multiple skills with one pricing each", () => {
		const config = makeConfig({
			products: [
				{ tierId: "basic", label: "Basic", amount: "$0.10", resourceType: "photo" },
				{ tierId: "premium", label: "Premium", amount: "$1.00", resourceType: "photo" },
				{ tierId: "bulk", label: "Bulk", amount: "$5.00", resourceType: "photo" },
			],
		});
		const card = buildAgentCard(config);
		expect(card.skills).toHaveLength(3);
		expect(card.skills[0]!.id).toBe("basic");
		expect(card.skills[0]!.pricing).toHaveLength(1);
		expect(card.skills[0]!.pricing![0]!.tierId).toBe("basic");
		expect(card.skills[1]!.id).toBe("premium");
		expect(card.skills[1]!.pricing![0]!.tierId).toBe("premium");
		expect(card.skills[2]!.id).toBe("bulk");
		expect(card.skills[2]!.pricing![0]!.tierId).toBe("bulk");
	});

	test("mainnet uses correct chainId", () => {
		const config = makeConfig({ network: "mainnet" });
		const card = buildAgentCard(config);
		const skill = card.skills[0]!;
		expect(skill.pricing![0]!.chainId).toBe(8453);
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
});
