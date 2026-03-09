/**
 * Token Issuance Failure — critical invariant: record stays PAID when token issuance fails.
 *
 * Security invariant: if onIssueToken fails, the challenge record MUST remain in PAID state
 * so the refund cron can pick it up. It must NOT be rolled back to PENDING or deleted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BACKEND_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import { readChallengeState } from "../helpers/storage-client.ts";

beforeEach(async () => {
	// Set backend to fail mode
	const res = await fetch(`${BACKEND_URL}/test/set-mode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "fail" }),
	});
	expect(res.status).toBe(204);
});

afterEach(async () => {
	// Reset backend to success mode
	await fetch(`${BACKEND_URL}/test/set-mode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "success" }),
	});
});

describe("Token Issuance Failure", () => {
	test("challenge stays in PAID state when backend /issue-token returns 500", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Request access
		const { challengeId, paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Step 2: Sign EIP-3009
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Step 3: Submit payment — gas wallet settles, but backend returns 500
		// AgentGate should return an error response (HTTP 500)
		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		expect(result.status).toBe(500);
		expect(result.error).toBeDefined();

		// Critical invariant: challenge must be in PAID state (not DELIVERED, not PENDING)
		const state = await readChallengeState(challengeId);
		expect(state).toBe("PAID");
	}, 120_000);
});
