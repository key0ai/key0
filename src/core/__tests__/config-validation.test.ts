import { describe, expect, it, test } from "bun:test";
import { makeSellerConfig } from "../../test-utils/index.js";
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
		).toThrow("fetchResourceCredentials is required when plans are configured");
	});

	test("rejects non-function fetchResourceCredentials", () => {
		expect(() =>
			validateSellerConfig(
				makeValidConfig({ fetchResourceCredentials: "not-a-function" as unknown as never }),
			),
		).toThrow("fetchResourceCredentials is required when plans are configured");
	});

	test("empty plans array does not throw (developer mode)", () => {
		expect(() => validateSellerConfig(makeValidConfig({ plans: [] }))).not.toThrow();
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

describe("routes validation", () => {
	it("passes when routes configured without proxyTo (embedded mode)", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [],
					fetchResourceCredentials: undefined as unknown as never,
					routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
				}),
			),
		).not.toThrow();
	});

	it("passes when routes + proxyTo both present", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [],
					fetchResourceCredentials: undefined as unknown as never,
					routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
					proxyTo: { baseUrl: "http://localhost:3001" },
				}),
			),
		).not.toThrow();
	});

	it("passes with free route (no unitAmount)", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [],
					fetchResourceCredentials: undefined as unknown as never,
					routes: [{ routeId: "health", method: "GET", path: "/health" }],
					proxyTo: { baseUrl: "http://localhost:3001" },
				}),
			),
		).not.toThrow();
	});

	it("throws on duplicate routeId", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [],
					fetchResourceCredentials: undefined as unknown as never,
					routes: [
						{ routeId: "dup", method: "GET", path: "/a" },
						{ routeId: "dup", method: "GET", path: "/b" },
					],
					proxyTo: { baseUrl: "http://localhost:3001" },
				}),
			),
		).toThrow(/duplicate routeId/);
	});

	it("throws when a routeId overlaps an existing planId", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [{ planId: "shared", unitAmount: "$1.00" }],
					routes: [{ routeId: "shared", method: "GET", path: "/shared", unitAmount: "$0.01" }],
					proxyTo: { baseUrl: "http://localhost:3001" },
				}),
			),
		).toThrow(/must not overlap an existing planId/);
	});

	it("throws if route path does not start with /", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({
					plans: [],
					fetchResourceCredentials: undefined as unknown as never,
					routes: [{ routeId: "r1", method: "GET", path: "no-slash" }],
					proxyTo: { baseUrl: "http://localhost:3001" },
				}),
			),
		).toThrow(/path must start with/);
	});
});

describe("plans-only seller", () => {
	it("throws if plans configured without fetchResourceCredentials", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({ fetchResourceCredentials: undefined as unknown as never }),
			),
		).toThrow(/fetchResourceCredentials is required when plans are configured/);
	});
});

describe("neither plans nor routes", () => {
	it("does not throw — warns and proceeds (developer mode)", () => {
		expect(() =>
			validateSellerConfig(
				makeSellerConfig({ plans: [], fetchResourceCredentials: undefined as unknown as never }),
			),
		).not.toThrow();
	});
});
