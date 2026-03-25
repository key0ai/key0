import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import {
	makeSellerConfig,
	MockPaymentAdapter,
	TestChallengeStore,
	TestSeenTxStore,
} from "../../test-utils/index.js";
import { createKey0Fastify } from "../fastify.js";

describe("createKey0Fastify", () => {
	it("does not auto-mount routes in embedded mode", async () => {
		const key0 = createKey0Fastify({
			config: makeSellerConfig({
				plans: [],
				routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
			}),
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
			adapter: new MockPaymentAdapter(),
		});

		const fastify = Fastify();
		try {
			await fastify.register(key0.plugin);
			expect(() =>
				fastify.get(
					"/api/weather/:city",
					{ preHandler: key0.payPerRequest("weather") },
					async () => ({ ok: true }),
				),
			).not.toThrow();
		} finally {
			await fastify.close();
		}
	});
});
