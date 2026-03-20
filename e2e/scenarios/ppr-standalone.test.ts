/**
 * PPR Standalone — verifies the pay-per-request flow through the Key0 gateway/proxy.
 *
 * Uses a dedicated Docker stack (docker-compose.e2e-ppr.yml) that has:
 *   - Key0 on port 3002 with PROXY_TO_BASE_URL=http://host.docker.internal:3001
 *   - Plans: weather-query ($0.01) and joke-of-the-day ($0.005) in per-request mode
 *   - Redis on port 6382
 *
 * The backend routes (/api/weather/:city and /api/joke) are served by the
 * in-process backend-server started in global-setup (port 3001).
 *
 * Scenarios:
 *   1. Happy path — weather query    → ResourceResponse with city + txHash
 *   2. Happy path — joke query       → ResourceResponse with joke + txHash
 *   3. Missing resource field        → 400 error
 *   4. Backend non-2xx response      → ResourceResponse with non-2xx status; challenge stays PAID
 *   5. Double-spend (PPR)            → second call with same auth rejected
 *   6. No accessToken in response    → ResourceResponse has no accessToken field
 *   7. State verification            → PENDING → PAID → DELIVERED on success
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PPR_JOKE_ROUTE_ID, PPR_KEY0_URL, PPR_WEATHER_ROUTE_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
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

/** Read challenge state via Key0's test endpoint (works across all storage backends). */
async function readPprChallengeState(challengeId: string): Promise<string | null> {
	const res = await fetch(`${PPR_KEY0_URL}/test/challenge/${challengeId}`);
	if (res.status === 404) return null;
	if (!res.ok) return null;
	const data = (await res.json()) as { state?: string };
	return data.state ?? null;
}

async function transitionPprChallengeState(
	challengeId: string,
	fromState: string,
	toState: string,
): Promise<boolean> {
	const res = await fetch(`${PPR_KEY0_URL}/test/transition-challenge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ challengeId, fromState, toState }),
	});
	if (res.ok) return true;
	if (res.status === 409) return false;
	throw new Error(`Failed to transition PPR challenge: ${res.status} ${await res.text()}`);
}

beforeAll(async () => {
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[ppr-standalone] Docker stack failed:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	const healthRes = await fetch(`${PPR_KEY0_URL}/health`);
	if (!healthRes.ok) throw new Error(`PPR Key0 health check failed: ${healthRes.status}`);
	console.log("[ppr-standalone] Key0 health:", await healthRes.json());
}, 120_000);

afterAll(() => {
	stopDockerStack(STACK_CONFIG);
});

describe("PPR Standalone: weather-query plan", () => {
	test("happy path — ResourceResponse with city data and txHash", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);

		const { resourceResponse } = await client.purchasePprAccess({
			routeId: PPR_WEATHER_ROUTE_ID,
			resource: { method: "GET", path: "/api/weather/london" },
		});

		expect(resourceResponse.type).toBe("ResourceResponse");
		expect(resourceResponse.routeId).toBe(PPR_WEATHER_ROUTE_ID);
		expect(typeof resourceResponse.txHash).toBe("string");
		expect(resourceResponse.txHash).toMatch(/^0x/);
		expect(typeof resourceResponse.explorerUrl).toBe("string");
		expect(resourceResponse.explorerUrl).toContain("sepolia");
		expect(resourceResponse.explorerUrl).toContain(resourceResponse.txHash);

		// Backend response
		expect(resourceResponse.resource.status).toBe(200);
		const body = resourceResponse.resource.body as Record<string, unknown>;
		expect(body["city"]).toBe("london");
		expect(typeof body["tempF"]).toBe("number");
		expect(typeof body["condition"]).toBe("string");
	}, 120_000);

	test("no accessToken field in ResourceResponse (per-request, not subscription)", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);

		const { resourceResponse } = await client.purchasePprAccess({
			routeId: PPR_WEATHER_ROUTE_ID,
			resource: { method: "GET", path: "/api/weather/paris" },
		});

		expect(resourceResponse.type).toBe("ResourceResponse");
		// AccessGrant fields must NOT be present
		expect((resourceResponse as Record<string, unknown>)["accessToken"]).toBeUndefined();
		expect((resourceResponse as Record<string, unknown>)["tokenType"]).toBeUndefined();
		expect((resourceResponse as Record<string, unknown>)["resourceEndpoint"]).toBeUndefined();
	}, 120_000);
});

describe("PPR Standalone: joke-of-the-day plan", () => {
	test("happy path — ResourceResponse with joke data and txHash", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);

		const { resourceResponse } = await client.purchasePprAccess({
			routeId: PPR_JOKE_ROUTE_ID,
			resource: { method: "GET", path: "/api/joke" },
		});

		expect(resourceResponse.type).toBe("ResourceResponse");
		expect(resourceResponse.routeId).toBe(PPR_JOKE_ROUTE_ID);
		expect(resourceResponse.resource.status).toBe(200);

		const body = resourceResponse.resource.body as Record<string, unknown>;
		expect(typeof body["joke"]).toBe("string");
		expect((body["joke"] as string).length).toBeGreaterThan(0);
	}, 120_000);
});

describe("PPR Standalone: validation and error cases", () => {
	test("missing resource field → 400 error", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);

		// Call /x402/access without resource field for a per-request plan
		const res = await fetch(`${PPR_KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				routeId: PPR_WEATHER_ROUTE_ID,
				requestId: crypto.randomUUID(),
				clientAgentId: `agent://${client.account}`,
				// resource field intentionally omitted
			}),
		});

		// per-request plan without resource should be rejected
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["type"]).toBe("Error");
	}, 30_000);

	test("backend returns non-2xx → ResourceResponse with non-2xx status, challenge stays PAID", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);
		let challengeId: string | null = null;

		// Instruct the backend to return 500 for PPR routes
		await fetch("http://localhost:3001/test/set-ppr-mode", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "error" }),
		});

		try {
			const result = await client.purchasePprAccess({
				routeId: PPR_WEATHER_ROUTE_ID,
				resource: { method: "GET", path: "/api/weather/berlin" },
			});
			challengeId = result.challengeId;
			const { resourceResponse } = result;

			// The response itself is a ResourceResponse (payment succeeded and we proxied)
			expect(resourceResponse.type).toBe("ResourceResponse");
			expect(resourceResponse.resource.status).toBe(500);

			// Challenge must still be PAID (not DELIVERED) — refund eligible
			const state = await readPprChallengeState(challengeId);
			expect(state).toBe("PAID");
		} finally {
			// Always reset backend mode
			await fetch("http://localhost:3001/test/set-ppr-mode", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "success" }),
			});

			if (challengeId) {
				// Cleanup: close the PAID record deterministically instead of leaving
				// refund work behind for later scenarios in the shared stack.
				const cleaned = await transitionPprChallengeState(challengeId, "PAID", "REFUND_FAILED");
				expect(cleaned).toBeTrue();
			}
		}
	}, 120_000);

	test("double-spend protection — same auth rejected on second PPR call", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);

		// First call — get payment requirements
		const req1 = crypto.randomUUID();
		const { paymentRequired: pr1 } = await client.requestPprAccess({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId: req1,
			resource: { method: "GET", path: "/api/weather/tokyo" },
		});

		const requirements = pr1.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// First submission — should succeed
		const result1 = await client.submitPprPayment({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId: req1,
			resource: { method: "GET", path: "/api/weather/tokyo" },
			auth,
			paymentRequired: pr1,
		});
		expect(result1.status).toBe(200);
		expect(result1.resourceResponse).toBeDefined();

		// Second call — reuse same auth (burned nonce)
		const req2 = crypto.randomUUID();
		const { paymentRequired: pr2 } = await client.requestPprAccess({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId: req2,
			resource: { method: "GET", path: "/api/weather/sydney" },
		});

		const result2 = await client.submitPprPayment({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId: req2,
			resource: { method: "GET", path: "/api/weather/sydney" },
			auth,
			paymentRequired: pr2,
		});

		// Must fail — burned nonce or seenTxStore guard
		expect(result2.status).not.toBe(200);
		expect(result2.error).toBeDefined();
	}, 120_000);
});

describe("PPR Standalone: state verification", () => {
	test("challenge transitions PENDING → PAID → DELIVERED on successful purchase", async () => {
		const client = makeClientE2eClient(PPR_KEY0_URL);
		const requestId = crypto.randomUUID();

		// Step 1: request access → challenge created (PENDING)
		const { challengeId, paymentRequired } = await client.requestPprAccess({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId,
			resource: { method: "GET", path: "/api/weather/madrid" },
		});

		const pendingState = await readPprChallengeState(challengeId);
		expect(pendingState).toBe("PENDING");

		// Step 2: sign + submit payment
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		const result = await client.submitPprPayment({
			routeId: PPR_WEATHER_ROUTE_ID,
			requestId,
			resource: { method: "GET", path: "/api/weather/madrid" },
			auth,
			paymentRequired,
		});

		expect(result.status).toBe(200);
		expect(result.resourceResponse).toBeDefined();

		// Challenge should now be DELIVERED
		const finalState = await readPprChallengeState(challengeId);
		expect(finalState).toBe("DELIVERED");
	}, 120_000);
});
