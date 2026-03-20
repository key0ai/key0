/**
 * Gateway Proxy — verifies the gateway proxy features:
 *   - Free routes bypass x402 payment and proxy directly to the backend
 *   - X-Key0-Internal-Token is forwarded on every proxied request
 *   - Paid routes proxy and return ResourceResponse
 *   - Paid route backend failures return a ResourceResponse and leave the challenge PAID
 *
 * Uses the same PPR Docker stack (docker-compose.e2e-ppr.yml, port 3002) with
 * an additional free route in ROUTES:
 *   - "status" — free route at /api/status
 *
 * The backend (port 3001) enforces X-Key0-Internal-Token once
 * /test/set-internal-secret is called in beforeAll.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	BACKEND_URL,
	GATEWAY_FREE_ROUTE_ID,
	GATEWAY_KEY0_URL,
	GATEWAY_PROXY_SECRET,
	GATEWAY_WEATHER_ROUTE_ID,
} from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import {
	printLogs,
	type StackConfig,
	startDockerStack,
	stopDockerStack,
} from "../helpers/docker-manager.ts";
import { pollUntil } from "../helpers/wait.ts";

const STACK_CONFIG: StackConfig = {
	composeFile: "docker-compose.e2e-ppr.yml",
	projectName: "key0-e2e-ppr",
};

async function readGatewayChallengeState(challengeId: string): Promise<string | null> {
	const res = await fetch(`${GATEWAY_KEY0_URL}/test/challenge/${challengeId}`);
	if (res.status === 404) return null;
	if (!res.ok) return null;
	const data = (await res.json()) as { state?: string };
	return data.state ?? null;
}

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

describe("Gateway Proxy: free route", () => {
	test("discover shows the free route", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/discover`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			routes: Array<{ routeId: string; method: string; path: string; unitAmount?: string }>;
		};
		const statusRoute = data.routes.find((r) => r.routeId === GATEWAY_FREE_ROUTE_ID);
		expect(statusRoute).toBeDefined();
		expect(statusRoute?.unitAmount).toBeUndefined();
	});

	test("free route returns data immediately without payment", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/api/status`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data["status"]).toBe("ok");
	});

	test("backend rejects direct call without X-Key0-Internal-Token", async () => {
		const res = await fetch(`${BACKEND_URL}/api/status`);
		expect(res.status).toBe(401);
	});

	test("Key0 forwards X-Key0-Internal-Token — backend accepts proxied call", async () => {
		// Key0 adds the internal token automatically; backend returns 200
		const res = await fetch(`${GATEWAY_KEY0_URL}/api/status`);
		expect(res.status).toBe(200);
	});
});

describe("Gateway Proxy: paid route", () => {
	test("challenge + payment proxies the route and returns backend data", async () => {
		const client = makeClientE2eClient(GATEWAY_KEY0_URL);

		const { resourceResponse } = await client.purchasePprAccess({
			routeId: GATEWAY_WEATHER_ROUTE_ID,
			resource: { method: "GET", path: "/api/weather/lisbon" },
		});

		expect(resourceResponse.type).toBe("ResourceResponse");
		expect(resourceResponse.routeId).toBe(GATEWAY_WEATHER_ROUTE_ID);
		expect(resourceResponse.resource.status).toBe(200);

		const body = resourceResponse.resource.body as Record<string, unknown>;
		expect(body["city"]).toBe("lisbon");
		expect(body["planId"]).toBe(GATEWAY_WEATHER_ROUTE_ID);
		expect(typeof body["txHash"]).toBe("string");
		expect((body["txHash"] as string).startsWith("0x")).toBe(true);
	}, 120_000);

	test("backend non-2xx returns ResourceResponse and keeps the challenge PAID", async () => {
		const client = makeClientE2eClient(GATEWAY_KEY0_URL);

		await fetch(`${BACKEND_URL}/test/set-ppr-mode`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "error" }),
		});

		try {
			const requestId = crypto.randomUUID();
			const { challengeId, paymentRequired } = await client.requestPprAccess({
				routeId: GATEWAY_WEATHER_ROUTE_ID,
				requestId,
				resource: { method: "GET", path: "/api/weather/berlin" },
			});

			const requirements = paymentRequired.accepts[0]!;
			const auth = await client.signEIP3009({
				destination: requirements.payTo as `0x${string}`,
				amountRaw: BigInt(requirements.amount),
			});

			const result = await client.submitPprPayment({
				routeId: GATEWAY_WEATHER_ROUTE_ID,
				requestId,
				resource: { method: "GET", path: "/api/weather/berlin" },
				auth,
				paymentRequired,
			});

			expect(result.status).toBe(200);
			expect(result.error).toBeUndefined();
			expect(result.resourceResponse?.type).toBe("ResourceResponse");
			expect(result.resourceResponse?.resource.status).toBe(500);

			const state = await pollUntil(async () => readGatewayChallengeState(challengeId), 10_000);
			expect(state).toBe("PAID");
		} finally {
			await fetch(`${BACKEND_URL}/test/set-ppr-mode`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "success" }),
			});
		}
	}, 120_000);
});
