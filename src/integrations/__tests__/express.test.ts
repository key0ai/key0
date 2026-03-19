import { describe, expect, it } from "bun:test";
import express from "express";
import request from "supertest";
import { makeSellerConfig, TestChallengeStore, TestSeenTxStore } from "../../test-utils/index.js";
import { key0Router } from "../express.js";

function makeApp(configOverrides = {}) {
	const app = express();
	app.use(express.json());
	app.use(
		key0Router({
			config: makeSellerConfig(configOverrides),
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		}),
	);
	return app;
}

describe("GET /discover", () => {
	it("returns plans and routes unwrapped (no discoveryResponse key)", async () => {
		const app = makeApp({
			plans: [],
			routes: [{ routeId: "health", method: "GET", path: "/health", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const res = await request(app).get("/discover");
		expect(res.status).toBe(200);
		expect(res.body.routes).toBeDefined();
		expect(res.body.discoveryResponse).toBeUndefined();
	});

	it("old /discovery returns 404", async () => {
		const app = makeApp();
		const res = await request(app).get("/discovery");
		expect(res.status).toBe(404);
	});
});

describe("POST /x402/access — routeId", () => {
	it("returns 400 when both planId and routeId present", async () => {
		const app = makeApp({
			plans: [],
			routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const res = await request(app)
			.post("/x402/access")
			.send({ planId: "p1", routeId: "r1", resource: { method: "GET", path: "/foo" } });
		expect(res.status).toBe(400);
	});

	it("returns 404 for unknown routeId", async () => {
		const app = makeApp({
			plans: [],
			routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const res = await request(app)
			.post("/x402/access")
			.send({ routeId: "nonexistent", resource: { method: "GET", path: "/foo" } });
		expect(res.status).toBe(404);
	});
});

describe("transparent proxy route mounting", () => {
	it("auto-mounts routes from config.routes at startup", () => {
		const router = key0Router({
			config: makeSellerConfig({
				plans: [],
				routes: [{ routeId: "health", method: "GET", path: "/health", unitAmount: "$0.01" }],
				proxyTo: { baseUrl: "http://localhost:9999" },
			}),
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		});
		// Express router layers include our mounted route
		const paths = router.stack
			.map((l: { route?: { path: string } }) => l.route?.path)
			.filter(Boolean);
		expect(paths).toContain("/health");
	});
});
