import { describe, expect, it } from "bun:test";
import { makeSellerConfig } from "../../test-utils/index.js";
import { buildLlmsTxt, buildSkillsMd, slugifyCliName } from "../standalone-onboarding.js";

const baseConfig = makeSellerConfig({
	agentName: "Weather Pro",
	agentDescription: "Paid weather API for agents",
	agentUrl: "https://api.example.com",
	plans: [{ planId: "basic", unitAmount: "$5.00", description: "Monthly access" }],
	routes: [{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" }],
});

describe("slugifyCliName", () => {
	it("converts names into stable CLI slugs", () => {
		expect(slugifyCliName("Weather Pro")).toBe("weather-pro");
		expect(slugifyCliName("  ")).toBe("key0-agent");
	});
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
		expect(text).not.toContain("/install.sh");
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
});
