import { describe, expect, test } from "bun:test";
import type { SellerConfig } from "../../types";
import { validateSellerConfig } from "../config-validation.js";

function makeValidConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test",
		agentUrl: "https://agent.example.com",
		providerName: "Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
		network: "testnet",
		plans: [{ planId: "single", unitAmount: "$0.10" }],
		fetchResourceCredentials: async (params) => ({
			token: `tok_${params.challengeId}`,
		}),
		...overrides,
	};
}

describe("validateSellerConfig", () => {
	test("accepts valid config", () => {
		expect(() => validateSellerConfig(makeValidConfig())).not.toThrow();
	});

	test("rejects empty agentName", () => {
		expect(() => validateSellerConfig(makeValidConfig({ agentName: "" }))).toThrow(
			"agentName must not be empty",
		);
	});

	test("rejects empty agentUrl", () => {
		expect(() => validateSellerConfig(makeValidConfig({ agentUrl: "" }))).toThrow(
			"agentUrl must not be empty",
		);
	});

	test("rejects empty providerName", () => {
		expect(() => validateSellerConfig(makeValidConfig({ providerName: "" }))).toThrow(
			"providerName must not be empty",
		);
	});

	test("rejects invalid wallet address", () => {
		expect(() =>
			validateSellerConfig(makeValidConfig({ walletAddress: "not-an-address" as `0x${string}` })),
		).toThrow("walletAddress");
	});

	test("rejects invalid network", () => {
		expect(() => validateSellerConfig(makeValidConfig({ network: "devnet" as "testnet" }))).toThrow(
			"network must be",
		);
	});

	test("rejects missing fetchResourceCredentials", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({ fetchResourceCredentials: undefined as unknown as never }),
			),
		).toThrow("fetchResourceCredentials is required for subscription plans");
	});

	test("rejects non-function fetchResourceCredentials", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({ fetchResourceCredentials: "not-a-function" as unknown as never }),
			),
		).toThrow("fetchResourceCredentials is required for subscription plans");
	});

	test("rejects empty plans array", () => {
		expect(() => validateSellerConfig(makeValidConfig({ plans: [] }))).toThrow("at least one plan");
	});

	test("rejects plan with empty planId", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({
					plans: [{ planId: "", unitAmount: "$0.10" }],
				}),
			),
		).toThrow("non-empty planId");
	});

	test("rejects duplicate planIds", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({
					plans: [
						{ planId: "same", unitAmount: "$0.10" },
						{ planId: "same", unitAmount: "$0.20" },
					],
				}),
			),
		).toThrow('duplicate planId "same"');
	});

	test("rejects invalid plan unitAmount format", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({
					plans: [{ planId: "bad", unitAmount: "0.10" }],
				}),
			),
		).toThrow('invalid unitAmount "0.10"');
	});

	test("accepts multiple valid plans", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({
					plans: [
						{ planId: "basic", unitAmount: "$0.10" },
						{ planId: "premium", unitAmount: "$1.00" },
					],
				}),
			),
		).not.toThrow();
	});
});
