import { describe, expect, spyOn, test } from "bun:test";
import { createKey0 } from "../factory.js";
import { makeSellerConfig, TestChallengeStore, TestSeenTxStore } from "../test-utils/index.js";

function makeTestStore() {
	return new TestChallengeStore();
}

function makeTestSeenTxStore() {
	return new TestSeenTxStore();
}

describe("createKey0 — startup validation", () => {
	test("throws if fetchResourceCredentials absent and a subscription plan has no proxyPath", () => {
		expect(() =>
			createKey0({
				config: {
					...makeSellerConfig(),
					plans: [{ planId: "basic", unitAmount: "$0.01" }],
					fetchResourceCredentials: undefined,
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).toThrow("fetchResourceCredentials");
	});

	test("does not throw when all plans have proxyPath", () => {
		expect(() =>
			createKey0({
				config: {
					...makeSellerConfig(),
					plans: [
						{
							planId: "signal",
							unitAmount: "$0.001",
							mode: "per-request" as const,
							proxyPath: "/signal/{asset}",
						},
					],
					fetchResourceCredentials: undefined,
					proxyTo: { baseUrl: "https://backend.internal" },
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("does not throw when all plans are free", () => {
		expect(() =>
			createKey0({
				config: {
					...makeSellerConfig(),
					plans: [{ planId: "health", free: true as const, proxyPath: "/health" }],
					fetchResourceCredentials: undefined,
					proxyTo: { baseUrl: "https://backend.internal" },
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("warns when proxyTo is configured without proxySecret", () => {
		const warnSpy = spyOn(console, "warn");
		createKey0({
			config: {
				...makeSellerConfig(),
				plans: [{ planId: "health", free: true as const, proxyPath: "/health" }],
				fetchResourceCredentials: undefined,
				proxyTo: { baseUrl: "https://backend.internal" }, // no proxySecret
			},
			store: makeTestStore(),
			seenTxStore: makeTestSeenTxStore(),
		});
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("KEY0_PROXY_SECRET"));
	});

	test("does not warn when proxyTo has proxySecret set", () => {
		const warnSpy = spyOn(console, "warn").mockReset();
		createKey0({
			config: {
				...makeSellerConfig(),
				plans: [{ planId: "health", free: true as const, proxyPath: "/health" }],
				fetchResourceCredentials: undefined,
				proxyTo: { baseUrl: "https://backend.internal", proxySecret: "secret-at-least-32-chars-long!!" },
			},
			store: makeTestStore(),
			seenTxStore: makeTestSeenTxStore(),
		});
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("KEY0_PROXY_SECRET"));
	});
});
