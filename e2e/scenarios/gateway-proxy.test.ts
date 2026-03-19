/**
 * Gateway Proxy — verifies the gateway proxy features:
 *   - Free plans bypass x402 payment and proxy directly to the backend
 *   - X-Key0-Internal-Token is forwarded on every proxied request
 *   - Per-plan proxyPath with {param} template interpolation
 *
 * Uses the same PPR Docker stack (docker-compose.e2e-ppr.yml, port 3002) with
 * two additional plans in the PLANS env:
 *   - "status" — free plan, proxyPath: /api/status
 *   - "weather-by-city" — paid plan, proxyPath: /api/weather/{city}
 *
 * The backend (port 3001) enforces X-Key0-Internal-Token once
 * /test/set-internal-secret is called in beforeAll.
 *
 * Note: Paid proxyPath tests require a real testnet transaction and are
 * skipped here. Only free plan and token forwarding are verified.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BACKEND_URL, GATEWAY_PROXY_SECRET, PPR_KEY0_URL } from "../fixtures/constants.ts";
import {
	printLogs,
	type StackConfig,
	startDockerStack,
	stopDockerStack,
} from "../helpers/docker-manager.ts";

const STACK_CONFIG: StackConfig = {
	composeFile: "docker-compose.e2e-ppr.yml",
	projectName: "key0-e2e-ppr",
};

const GATEWAY_KEY0_URL = PPR_KEY0_URL; // same stack, port 3002

beforeAll(async () => {
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[gateway-proxy] Docker stack failed:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	// Activate internal token enforcement on the backend
	await fetch(`${BACKEND_URL}/test/set-internal-secret`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secret: GATEWAY_PROXY_SECRET }),
	});

	const health = await fetch(`${GATEWAY_KEY0_URL}/health`);
	if (!health.ok) throw new Error(`Key0 health check failed: ${health.status}`);
	console.log("[gateway-proxy] Key0 health:", await health.json());
}, 120_000);

afterAll(async () => {
	// Disable token enforcement so other tests are unaffected
	await fetch(`${BACKEND_URL}/test/set-internal-secret`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secret: undefined }),
	});
	stopDockerStack(STACK_CONFIG);
});

describe("Gateway Proxy: free plan", () => {
	test("discover shows free plan with free: true", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/discover`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			plans: Array<{ planId: string; unitAmount?: string; description?: string; free?: boolean }>;
		};
		const statusPlan = data.plans.find((p) => p.planId === "status");
		expect(statusPlan).toBeDefined();
		expect(statusPlan?.free).toBe(true);
	});

	test("free plan returns data immediately without payment", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ planId: "status" }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			type: string;
			resource: { status: number; body: unknown };
		};
		expect(data.type).toBe("ResourceResponse");
		expect(data.resource.status).toBe(200);
		expect((data.resource.body as Record<string, unknown>)["status"]).toBe("ok");
	});

	test("backend rejects direct call without X-Key0-Internal-Token", async () => {
		const res = await fetch(`${BACKEND_URL}/api/status`);
		expect(res.status).toBe(401);
	});

	test("Key0 forwards X-Key0-Internal-Token — backend accepts proxied call", async () => {
		// Key0 adds the internal token automatically; backend returns 200
		const res = await fetch(`${GATEWAY_KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ planId: "status" }),
		});
		expect(res.status).toBe(200);
	});
});
