import { describe, expect, it } from "bun:test";
import { TestSeenTxStore } from "../../test-utils/stores.js";
import { makeSellerConfig } from "../../test-utils/index.js";
import { key0PayPerRequest, resolveConfigFetchResource } from "../pay-per-request.js";

describe("resolveConfigFetchResource", () => {
	it("returns undefined when neither fetchResource nor proxyTo is configured", () => {
		const config = makeSellerConfig({
			routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
		});
		expect(resolveConfigFetchResource(config)).toBeUndefined();
	});

	it("builds a proxy fetcher from proxyTo", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = ((async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown) as typeof fetch;

		try {
			const config = makeSellerConfig({
				routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
				proxyTo: { baseUrl: "https://backend.example.com" },
			});
			const fetchResource = resolveConfigFetchResource(config);
			expect(fetchResource).toBeDefined();

			const result = await fetchResource!({
				method: "GET",
				path: "/api/weather/london",
				headers: {},
				paymentInfo: {
					txHash: `0x${"a".repeat(64)}` as `0x${string}`,
					payer: undefined,
					planId: "weather",
					amount: "$0.01",
					method: "GET",
					path: "/api/weather/london",
					challengeId: "ppr-1",
				},
			});

			expect(result.status).toBe(200);
			expect(result.body).toEqual({ ok: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("key0PayPerRequest", () => {
	it("returns 402 for a paid route when no PAYMENT-SIGNATURE is present", async () => {
		const config = makeSellerConfig({
			plans: [],
			fetchResourceCredentials: undefined as unknown as never,
			routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
		});
		const middleware = key0PayPerRequest({
			routeId: "weather",
			config,
			seenTxStore: new TestSeenTxStore(),
		});

		let statusCode = 200;
		let responseBody: unknown;
		const res = {
			status: (code: number) => {
				statusCode = code;
				return {
					json: (data: unknown) => {
						responseBody = data;
						return data;
					},
				};
			},
			setHeader: () => undefined,
			statusCode: 200,
			on: () => undefined,
		};

		await middleware(
			{
				method: "GET",
				path: "/api/weather/london",
				originalUrl: "/api/weather/london",
				headers: {},
			},
			res,
			() => undefined,
		);

		expect(statusCode).toBe(402);
		expect(responseBody).toBeDefined();
		expect((responseBody as Record<string, unknown>)["x402Version"]).toBe(2);
	});

	it("throws when the configured routeId does not exist", () => {
		const config = makeSellerConfig({
			plans: [],
			fetchResourceCredentials: undefined as unknown as never,
			routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
		});

		expect(() =>
			key0PayPerRequest({
				routeId: "missing",
				config,
				seenTxStore: new TestSeenTxStore(),
			}),
		).toThrow(/route "missing" not found/);
	});
});
