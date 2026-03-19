import { describe, expect, it } from "bun:test";
import { makeSellerConfig } from "../../test-utils/index.js";
import { buildDiscoveryResponse } from "../settlement.js";

describe("buildDiscoveryResponse", () => {
	it("includes routes array with paid and free routes", () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [
				{
					routeId: "weather",
					method: "GET",
					path: "/api/weather/:city",
					unitAmount: "$0.01",
					description: "Weather",
				},
				{ routeId: "health", method: "GET", path: "/health" },
			],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const response = buildDiscoveryResponse(config);
		expect(response.routes).toHaveLength(2);
		expect(response.routes[0]).toMatchObject({ routeId: "weather", unitAmount: "$0.01" });
		// free route has no unitAmount
		const freeRoute = response.routes[1];
		expect(freeRoute?.unitAmount).toBeUndefined();
	});

	it("includes plans for subscription sellers", () => {
		const config = makeSellerConfig({
			plans: [{ planId: "premium", unitAmount: "$5.00", description: "Monthly" }],
		});
		const response = buildDiscoveryResponse(config);
		expect(response.plans).toHaveLength(1);
		expect(response.plans[0]).toMatchObject({ planId: "premium" });
	});

	it("has no discoveryResponse wrapper — top-level keys are agentName, plans, routes", () => {
		const response = buildDiscoveryResponse(makeSellerConfig());
		expect(response).toHaveProperty("agentName");
		expect(response).toHaveProperty("plans");
		expect(response).toHaveProperty("routes");
		expect((response as Record<string, unknown>)["discoveryResponse"]).toBeUndefined();
	});
});
