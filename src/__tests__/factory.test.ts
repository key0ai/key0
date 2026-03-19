import { describe, expect, spyOn, test } from "bun:test";
import { createKey0 } from "../factory.js";
import { makeSellerConfig, TestChallengeStore, TestSeenTxStore } from "../test-utils/index.js";

function makeTestStore() {
	return new TestChallengeStore();
}

function makeTestSeenTxStore() {
	return new TestSeenTxStore();
}

// Create a config that omits fetchResourceCredentials entirely
function configWithoutFrc(overrides: object = {}) {
	const { fetchResourceCredentials: _fc, ...rest } = makeSellerConfig();
	return { ...rest, ...overrides };
}

describe("createKey0 — startup validation", () => {
	test("throws if fetchResourceCredentials absent and a subscription plan has no proxyPath", () => {
		expect(() =>
			createKey0({
				config: {
					...configWithoutFrc(),
					plans: [{ planId: "basic", unitAmount: "$0.01" }],
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).toThrow("fetchResourceCredentials");
	});

	test("does not throw when routes are configured with proxyTo", () => {
		expect(() =>
			createKey0({
				config: {
					...configWithoutFrc({
						plans: [],
						proxyTo: { baseUrl: "https://backend.internal" },
					}),
					routes: [
						{
							routeId: "signal",
							method: "GET" as const,
							path: "/signal/{asset}",
							unitAmount: "$0.10",
						},
					],
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("does not throw when only routes are configured, no plans", () => {
		expect(() =>
			createKey0({
				config: {
					...configWithoutFrc({
						plans: [],
						proxyTo: { baseUrl: "https://backend.internal" },
					}),
					routes: [{ routeId: "health", method: "GET" as const, path: "/health" }],
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("warns when routes are configured with proxyTo but no proxySecret", () => {
		const warnSpy = spyOn(console, "warn");
		createKey0({
			config: {
				...configWithoutFrc({
					plans: [],
					proxyTo: { baseUrl: "https://backend.internal" },
				}),
				routes: [{ routeId: "health", method: "GET" as const, path: "/health" }],
			},
			store: makeTestStore(),
			seenTxStore: makeTestSeenTxStore(),
		});
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("proxySecret"));
	});

	test("does not warn when routes have proxySecret set", () => {
		const warnSpy = spyOn(console, "warn").mockReset();
		createKey0({
			config: {
				...configWithoutFrc({
					plans: [],
					proxyTo: {
						baseUrl: "https://backend.internal",
						proxySecret: "secret-at-least-32-chars-long!!",
					},
				}),
				routes: [{ routeId: "health", method: "GET" as const, path: "/health" }],
			},
			store: makeTestStore(),
			seenTxStore: makeTestSeenTxStore(),
		});
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("proxySecret"));
	});
});

describe("createKey0 — new validation rules", () => {
	test("throws if routes without proxyTo", () => {
		expect(() =>
			createKey0({
				config: {
					...configWithoutFrc({
						proxyTo: undefined,
					}),
					plans: [],
					routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("throws if plans without fetchResourceCredentials", () => {
		expect(() =>
			createKey0({
				config: {
					...configWithoutFrc(),
					plans: [{ planId: "basic", unitAmount: "$0.01" }],
				},
				store: makeTestStore(),
				seenTxStore: makeTestSeenTxStore(),
			}),
		).toThrow(/fetchResourceCredentials is required/);
	});
});
