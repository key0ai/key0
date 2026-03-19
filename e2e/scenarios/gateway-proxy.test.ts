/**
 * Gateway Proxy — verifies the gateway proxy features:
 *   - Free plans bypass x402 payment and proxy directly to the backend
 *   - X-Key0-Internal-Token is forwarded on every proxied request
 *   - Paid proxyPath plans interpolate params and return ResourceResponse
 *   - Paid proxy failures initiate refunds
 *
 * Uses the same PPR Docker stack (docker-compose.e2e-ppr.yml, port 3002) with
 * two additional plans in the PLANS env:
 *   - "status" — free plan, proxyPath: /api/status
 *   - "weather-by-city" — paid plan, proxyPath: /api/weather/{city}
 *
 * The backend (port 3001) enforces X-Key0-Internal-Token once
 * /test/set-internal-secret is called in beforeAll.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	BACKEND_URL,
	GATEWAY_FREE_PLAN_ID,
	GATEWAY_KEY0_URL,
	GATEWAY_PROXY_SECRET,
	GATEWAY_SIGNAL_PLAN_ID,
	REFUND_POLL_TIMEOUT_MS,
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

describe("Gateway Proxy: free plan", () => {
	test("discover shows free plan with free: true", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/discover`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			plans: Array<{ planId: string; unitAmount?: string; description?: string; free?: boolean }>;
		};
		const statusPlan = data.plans.find((p) => p.planId === GATEWAY_FREE_PLAN_ID);
		expect(statusPlan).toBeDefined();
		expect(statusPlan?.free).toBe(true);
	});

	test("free plan returns data immediately without payment", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ planId: GATEWAY_FREE_PLAN_ID }),
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
			body: JSON.stringify({ planId: GATEWAY_FREE_PLAN_ID }),
		});
		expect(res.status).toBe(200);
	});
});

describe("Gateway Proxy: paid proxyPath plan", () => {
	test("challenge + payment with params interpolates proxyPath and returns backend data", async () => {
		const client = makeClientE2eClient(GATEWAY_KEY0_URL);

		const { resourceResponse } = await client.purchaseProxyPlanAccess({
			planId: GATEWAY_SIGNAL_PLAN_ID,
			params: { city: "lisbon" },
		});

		expect(resourceResponse.type).toBe("ResourceResponse");
		expect(resourceResponse.planId).toBe(GATEWAY_SIGNAL_PLAN_ID);
		expect(resourceResponse.resource.status).toBe(200);

		const body = resourceResponse.resource.body as Record<string, unknown>;
		expect(body["city"]).toBe("lisbon");
		expect(body["planId"]).toBe(GATEWAY_SIGNAL_PLAN_ID);
		expect(typeof body["txHash"]).toBe("string");
		expect((body["txHash"] as string).startsWith("0x")).toBe(true);
	}, 120_000);

	test("missing proxyPath template param returns 400 before challenge creation", async () => {
		const res = await fetch(`${GATEWAY_KEY0_URL}/x402/access`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				planId: GATEWAY_SIGNAL_PLAN_ID,
				requestId: crypto.randomUUID(),
			}),
		});

		expect(res.status).toBe(400);
		const data = (await res.json()) as { code?: string; message?: string };
		expect(data.code).toBe("TEMPLATE_ERROR");
		expect(res.headers.get("payment-required")).toBeNull();
	});

	test("backend non-2xx initiates refund for paid proxyPath plan", async () => {
		const client = makeClientE2eClient(GATEWAY_KEY0_URL);

		await fetch(`${BACKEND_URL}/test/set-ppr-mode`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "error" }),
		});

		try {
			const requestId = crypto.randomUUID();
			const { challengeId, paymentRequired } = await client.requestProxyPlanAccess({
				planId: GATEWAY_SIGNAL_PLAN_ID,
				requestId,
				params: { city: "berlin" },
			});

			const requirements = paymentRequired.accepts[0]!;
			const auth = await client.signEIP3009({
				destination: requirements.payTo as `0x${string}`,
				amountRaw: BigInt(requirements.amount),
			});

			const result = await client.submitProxyPlanPayment({
				planId: GATEWAY_SIGNAL_PLAN_ID,
				requestId,
				params: { city: "berlin" },
				auth,
				paymentRequired,
			});

			expect(result.status).toBe(502);
			expect(result.resourceResponse).toBeUndefined();
			expect(result.error?.["code"]).toBe("PROXY_BACKEND_ERROR");

			const state = await pollUntil(async () => {
				const current = await readGatewayChallengeState(challengeId);
				return current && current !== "PAID" ? current : null;
			}, REFUND_POLL_TIMEOUT_MS);
			expect(["REFUND_PENDING", "REFUNDED"]).toContain(state);
		} finally {
			await fetch(`${BACKEND_URL}/test/set-ppr-mode`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "success" }),
			});
		}
	}, 120_000);
});
