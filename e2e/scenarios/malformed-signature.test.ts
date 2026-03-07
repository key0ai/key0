/**
 * Malformed Signature — verifies that invalid PAYMENT-SIGNATURE headers are rejected.
 *
 * decodePaymentSignature() in src/integrations/settlement.ts:
 *   1. Tries base64url decode → JSON.parse
 *   2. Falls back to standard base64 → JSON.parse
 *   3. If both fail → throws AgentGateError("INVALID_REQUEST", ..., 400)
 *
 * The /x402/access handler catches AgentGateError and returns the HTTP status
 * from the error (400 in this case).
 *
 * No wallet needed — pure HTTP test.
 */

import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";

describe("Malformed PAYMENT-SIGNATURE", () => {
	test("completely invalid string returns 400 INVALID_REQUEST", async () => {
		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"payment-signature": "this-is-not-valid-base64-json!!!",
			},
			body: JSON.stringify({
				tierId: DEFAULT_TIER_ID,
				requestId: crypto.randomUUID(),
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["code"]).toBe("INVALID_REQUEST");
	});

	test("valid base64 of non-JSON content returns 400 INVALID_REQUEST", async () => {
		// "hello world" is valid base64-decodable but not JSON
		const nonJsonBase64 = Buffer.from("hello world — not json").toString("base64");

		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"payment-signature": nonJsonBase64,
			},
			body: JSON.stringify({
				tierId: DEFAULT_TIER_ID,
				requestId: crypto.randomUUID(),
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["code"]).toBe("INVALID_REQUEST");
	});

	test("valid base64 of JSON but wrong structure still reaches settlement and fails", async () => {
		// Valid JSON but missing required x402 fields → settlement layer rejects it
		const badPayload = { foo: "bar", not: "a payment payload" };
		const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64");

		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"payment-signature": encoded,
			},
			body: JSON.stringify({
				tierId: DEFAULT_TIER_ID,
				requestId: crypto.randomUUID(),
			}),
		});

		// Decoded successfully but settlement verify() fails → not 200
		expect(res.status).not.toBe(200);
	});
});
