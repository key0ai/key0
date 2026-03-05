/**
 * A2A JSON-RPC x402 Middleware — verifies the x402 payment flow on /a2a/jsonrpc.
 *
 * The x402-http-middleware intercepts POST /a2a/jsonrpc when:
 *   - X-A2A-Extensions header is ABSENT (non-A2A client)
 *   - method === "message/send"
 *   - params.message.parts contains a part with type === "AccessRequest"
 *
 * Two-step flow:
 *   1. POST /a2a/jsonrpc + AccessRequest (no PAYMENT-SIGNATURE) → 402 + challengeId
 *   2. POST /a2a/jsonrpc + AccessRequest + PAYMENT-SIGNATURE → settle → 200 AccessGrant
 *
 * This is the code path used by non-MCP HTTP clients that POST JSON-RPC directly
 * rather than using the /x402/access simple HTTP endpoint.
 */

import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import type { AccessGrant } from "../helpers/client.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

const JSONRPC_URL = `${AGENTGATE_URL}/a2a/jsonrpc`;

/** Build a JSON-RPC message/send body with an AccessRequest data part */
function buildJsonRpcRequest(
	tierId: string,
	requestId: string,
	resourceId = "default",
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id: "1",
		method: "message/send",
		params: {
			message: {
				parts: [
					{
						kind: "data",
						data: {
							type: "AccessRequest",
							requestId,
							tierId,
							resourceId,
							clientAgentId: "agent://e2e-test",
						},
					},
				],
			},
		},
	};
}

describe("A2A JSON-RPC x402 Middleware", () => {
	test("POST /a2a/jsonrpc with AccessRequest (no signature) returns 402 + challengeId", async () => {
		const requestId = crypto.randomUUID();

		const res = await fetch(JSONRPC_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// No X-A2A-Extensions header → middleware intercepts
			body: JSON.stringify(buildJsonRpcRequest(DEFAULT_TIER_ID, requestId)),
		});

		expect(res.status).toBe(402);

		const body = (await res.json()) as Record<string, unknown>;

		// Middleware returns challengeId + payment requirements inline
		expect(typeof body["challengeId"]).toBe("string");
		expect((body["challengeId"] as string).length).toBeGreaterThan(0);
		expect(body["error"]).toBe("PAYMENT-SIGNATURE header is required");
		expect(Array.isArray(body["accepts"])).toBe(true);

		// payment-required header must be set
		const header = res.headers.get("payment-required");
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf-8"));
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts[0].scheme).toBe("exact");
	});

	test(
		"POST /a2a/jsonrpc with AccessRequest + PAYMENT-SIGNATURE returns 200 AccessGrant",
		async () => {
			const client = makeClientE2eClient();
			const requestId = crypto.randomUUID();

			// Step 1: Get challenge (no signature)
			const challengeRes = await fetch(JSONRPC_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildJsonRpcRequest(DEFAULT_TIER_ID, requestId)),
			});

			expect(challengeRes.status).toBe(402);
			const challengeBody = (await challengeRes.json()) as Record<string, unknown>;
			const challengeId = challengeBody["challengeId"] as string;

			// Decode payment requirements from header
			const header = challengeRes.headers.get("payment-required");
			expect(header).toBeTruthy();
			const paymentRequired = JSON.parse(
				Buffer.from(header!, "base64").toString("utf-8"),
			) as { accepts: Array<{ amount: string; payTo: string }> };

			const requirements = paymentRequired.accepts[0]!;

			// Step 2: Sign EIP-3009
			const auth = await client.signEIP3009({
				destination: requirements.payTo as `0x${string}`,
				amountRaw: BigInt(requirements.amount),
			});

			// Build PAYMENT-SIGNATURE payload (same format as /x402/access)
			const paymentPayload = {
				x402Version: 2,
				network: `eip155:84532`,
				scheme: "exact",
				payload: {
					signature: auth.signature,
					authorization: auth.authorization,
					from: client.account,
				},
				accepted: requirements,
			};
			const paymentSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

			// Step 3: POST with signature
			const settleRes = await fetch(JSONRPC_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"payment-signature": paymentSignature,
				},
				body: JSON.stringify(buildJsonRpcRequest(DEFAULT_TIER_ID, requestId)),
			});

			expect(settleRes.status).toBe(200);

			const grant = (await settleRes.json()) as AccessGrant;
			expect(grant.type).toBe("AccessGrant");
			expect(typeof grant.accessToken).toBe("string");
			expect(grant.tokenType).toBe("Bearer");
			expect(grant.txHash).toMatch(/^0x/);
			expect(grant.challengeId).toBe(challengeId);
			expect(grant.requestId).toBe(requestId);

			// payment-response header must be set
			const paymentResponse = settleRes.headers.get("payment-response");
			expect(paymentResponse).toBeTruthy();
		},
		120_000,
	);

	test("POST /a2a/jsonrpc with X-A2A-Extensions header passes through to A2A handler", async () => {
		// When X-A2A-Extensions is present, the middleware skips x402 logic and
		// passes the request to the A2A JSON-RPC handler. The A2A handler processes
		// the request normally (not as a payment flow).
		// Since the request doesn't match a valid A2A task, it returns an A2A error response —
		// NOT a 402. This confirms the middleware correctly detected the header and passed through.
		const res = await fetch(JSONRPC_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-a2a-extensions": "x402/v2", // presence alone triggers passthrough
			},
			body: JSON.stringify(buildJsonRpcRequest(DEFAULT_TIER_ID, crypto.randomUUID())),
		});

		// Not 402 — the middleware did NOT intercept this request
		expect(res.status).not.toBe(402);
	});

	test("POST /a2a/jsonrpc without AccessRequest in parts passes through to A2A handler", async () => {
		// message/send with non-AccessRequest parts → middleware passes through
		const res = await fetch(JSONRPC_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				method: "message/send",
				params: {
					message: {
						parts: [{ kind: "text", text: "Hello, not an access request" }],
					},
				},
			}),
		});

		// Passes through — not intercepted as x402 — not 402
		expect(res.status).not.toBe(402);
	});
});
