import { describe, expect, it } from "bun:test";
import { makeSellerConfig } from "../../test-utils/index.js";
import { buildLlmsTxt, buildSkillsMd } from "../standalone-onboarding.js";

const baseConfig = makeSellerConfig({
	agentName: "Weather Pro",
	agentDescription: "Paid weather API for agents",
	agentUrl: "https://api.example.com",
	plans: [{ planId: "basic", unitAmount: "$5.00", description: "Monthly access" }],
	routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
});

describe("buildLlmsTxt", () => {
	it("lists only enabled onboarding surfaces", () => {
		const text = buildLlmsTxt(baseConfig, {
			a2aEnabled: false,
			mcpEnabled: false,
			llmsEnabled: true,
			skillsMdEnabled: true,
		});

		expect(text).toContain("GET https://api.example.com/discover");
		expect(text).not.toContain(".well-known/agent.json");
		expect(text).toContain("A2A: disabled");
	});
});

describe("buildSkillsMd", () => {
	it("documents both plans and routes with /discover", () => {
		const text = buildSkillsMd(baseConfig, {
			a2aEnabled: true,
			mcpEnabled: true,
			llmsEnabled: true,
			skillsMdEnabled: true,
		});

		expect(text).toContain("`https://api.example.com/discover`");
		expect(text).toContain("Subscription Plans");
		expect(text).toContain("Pay-Per-Call Routes");
	});

	it("does not invent pay-per-call routes from plans", () => {
		const text = buildSkillsMd(
			makeSellerConfig({
				agentName: "Weather Pro",
				agentDescription: "Paid weather API for agents",
				agentUrl: "https://api.example.com",
				plans: [
					{
						planId: "weather-query",
						unitAmount: "$0.01",
						description: "Subscription only",
					},
				],
				routes: [],
			}),
			{
				a2aEnabled: true,
				mcpEnabled: false,
				llmsEnabled: true,
				skillsMdEnabled: true,
			},
		);

		expect(text).not.toContain("GET /api/weather/:city");
	});
});
