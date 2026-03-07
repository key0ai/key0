/**
 * Already Redeemed — verifies PROOF_ALREADY_REDEEMED responses.
 *
 * Two scenarios:
 *   1. Re-request access (no payment) after DELIVERED → returns existing grant directly
 *   2. Re-submit payment after DELIVERED → pre-settlement check returns cached grant
 *
 * The middleware returns the AccessGrant directly (not wrapped in an error shape)
 * for better client UX.
 */

import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL, DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import { readChallengeState } from "../helpers/redis-client.ts";

describe("Already Redeemed", () => {
	test("re-submitting payment after DELIVERED returns the existing grant directly", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Complete a full purchase
		const { challengeId, grant: originalGrant } = await client.purchaseAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Verify it's DELIVERED
		const state = await readChallengeState(challengeId);
		expect(state).toBe("DELIVERED");

		// Sign a new EIP-3009 authorization and re-submit payment
		// The pre-settlement check should find DELIVERED and return the cached grant
		// WITHOUT settling on-chain (no USDC burned)
		const { paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId: crypto.randomUUID(), // need a fresh requestId for requestAccess
		});
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId, // original requestId → already DELIVERED
			auth,
			paymentRequired,
		});

		// Should return 200 with the original grant (from pre-settlement check)
		expect(result.status).toBe(200);
		expect(result.grant).toBeDefined();
		expect(result.grant!.type).toBe("AccessGrant");
		expect(result.grant!.challengeId).toBe(challengeId);
		expect(result.grant!.accessToken).toBe(originalGrant.accessToken);

		// State must still be DELIVERED
		const finalState = await readChallengeState(challengeId);
		expect(finalState).toBe("DELIVERED");
	}, 120_000);

	test("re-requesting access (no payment) after DELIVERED returns existing grant", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Complete a full purchase
		const { challengeId, grant: originalGrant } = await client.purchaseAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Re-request access with same requestId (no payment)
		// The /x402/access endpoint should detect DELIVERED and return the grant
		const res = await fetch(`${AGENTGATE_URL}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tierId: DEFAULT_TIER_ID,
				requestId,
				resourceId: "default",
			}),
		});

		const body = (await res.json()) as Record<string, unknown>;

		// Should return the existing grant (200) since the challenge is DELIVERED
		// The engine's requestHttpAccess throws PROOF_ALREADY_REDEEMED which
		// the middleware converts to a direct grant response
		expect(res.status).toBe(200);
		expect(body["type"]).toBe("AccessGrant");
		expect(body["challengeId"]).toBe(challengeId);
		expect(body["accessToken"]).toBe(originalGrant.accessToken);
	}, 120_000);
});
