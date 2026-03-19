import { describe, expect, it } from "bun:test";
import type { Plan, Route, SellerConfig } from "../config.js";

describe("Route type", () => {
	it("accepts a paid route", () => {
		const r: Route = {
			routeId: "weather",
			method: "GET",
			path: "/api/weather/:city",
			unitAmount: "$0.01",
		};
		expect(r.routeId).toBe("weather");
	});

	it("accepts a free route (no unitAmount)", () => {
		const r: Route = { routeId: "health", method: "GET", path: "/health" };
		expect(r.unitAmount).toBeUndefined();
	});
});

describe("Plan type — subscription-only", () => {
	it("has planId and unitAmount", () => {
		const p: Plan = { planId: "premium", unitAmount: "$5.00" };
		expect(p.planId).toBe("premium");
	});
});

describe("SellerConfig", () => {
	it("accepts routes at top level", () => {
		const c: Partial<SellerConfig> = {
			routes: [{ routeId: "r1", method: "GET", path: "/foo" }],
		};
		expect(c.routes?.length).toBe(1);
	});
});
