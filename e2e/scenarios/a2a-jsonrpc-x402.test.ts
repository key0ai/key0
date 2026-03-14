/**
 * Unified /x402/access endpoint — verifies the x402 payment flow.
 *
 * The /x402/access endpoint handles all payment flows:
 *   - X-A2A-Extensions header present → delegates to A2A JSON-RPC handler
 *   - No header → x402 HTTP flow (discovery / challenge / settle)
 *
 * Three-case flow (x402 HTTP):
 *   1. POST /x402/access (no planId)                         → 402 Discovery
 *   2. POST /x402/access + { planId } (no PAYMENT-SIGNATURE) → 402 Challenge
 *   3. POST /x402/access + { planId } + PAYMENT-SIGNATURE    → settle → 200 AccessGrant
 *
 * A2A-native flow:
 *   POST /x402/access + X-A2A-Extensions header → delegates to JSON-RPC handler
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID, KEY0_URL } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import type { AccessGrant } from "../helpers/client.ts";

const X402_URL = `${KEY0_URL}/x402/access`;

describe("Unified /x402/access endpoint", () => {
	test("POST /x402/access with no planId returns 402 Discovery", async () => {
		const res = await fetch(X402_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(402);

		const body = (await res.json()) as Record<string, unknown>;

		// Discovery returns all tiers
		expect(body["error"]).toBe("Payment required");
		expect(Array.isArray(body["accepts"])).toBe(true);
		expect(body["x402Version"]).toBe(2);

		// payment-required header must be set
		const header = res.headers.get("payment-required");
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf-8"));
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts.length).toBeGreaterThan(0);
	});

	test("POST /x402/access with planId (no signature) returns 402 Challenge", async () => {
		const res = await fetch(X402_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: DEFAULT_TIER_ID }),
		});

		expect(res.status).toBe(402);

		const body = (await res.json()) as Record<string, unknown>;

		// Challenge returns challengeId + payment requirements
		expect(typeof body["challengeId"]).toBe("string");
		expect((body["challengeId"] as string).length).toBeGreaterThan(0);
		expect(body["error"]).toBe("Payment required");
		expect(Array.isArray(body["accepts"])).toBe(true);

		// payment-required header must be set
		const header = res.headers.get("payment-required");
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf-8"));
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts[0].scheme).toBe("exact");
	});

	test("POST /x402/access with planId + PAYMENT-SIGNATURE returns 200 AccessGrant", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Get challenge
		const challengeRes = await fetch(X402_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: DEFAULT_TIER_ID, requestId }),
		});

		expect(challengeRes.status).toBe(402);
		const challengeBody = (await challengeRes.json()) as Record<string, unknown>;
		const challengeId = challengeBody["challengeId"] as string;

		// Decode payment requirements from header
		const header = challengeRes.headers.get("payment-required");
		expect(header).toBeTruthy();
		const paymentRequired = JSON.parse(Buffer.from(header!, "base64").toString("utf-8")) as {
			accepts: Array<{ amount: string; payTo: string }>;
		};

		const requirements = paymentRequired.accepts[0]!;

		// Step 2: Sign EIP-3009
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Build PAYMENT-SIGNATURE payload
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
		const settleRes = await fetch(X402_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"payment-signature": paymentSignature,
			},
			body: JSON.stringify({ planId: DEFAULT_TIER_ID, requestId }),
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
	}, 120_000);

	test("POST /x402/access with X-A2A-Extensions header delegates to JSON-RPC handler", async () => {
		// When X-A2A-Extensions is present, the endpoint delegates to the A2A JSON-RPC
		// handler. Since the body below isn't a valid JSON-RPC request, we expect a
		// non-402 response confirming the middleware correctly detected the header.
		const res = await fetch(X402_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-a2a-extensions": "x402/v2",
			},
			body: JSON.stringify({
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
									requestId: crypto.randomUUID(),
									planId: DEFAULT_TIER_ID,
									resourceId: "default",
									clientAgentId: "agent://e2e-test",
								},
							},
						],
					},
				},
			}),
		});

		// Not 402 — the x402 logic did NOT intercept this request
		expect(res.status).not.toBe(402);
	});
});
