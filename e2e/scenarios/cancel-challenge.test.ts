/**
 * Cancel Challenge — verifies PENDING → CANCELLED transition.
 *
 * Tests that a PENDING challenge can be cancelled via direct Redis state manipulation
 * (simulating what the cancelChallenge() engine method does) and that subsequent
 * proof submission is rejected.
 *
 * Also tests that re-requesting with the same requestId after cancellation
 * creates a new challenge (the CANCELLED record is skipped by idempotency).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import {
	expireRequestIdIndex,
	readChallengeState,
	transitionChallengeState,
} from "../helpers/storage-client.ts";

describe("Cancel Challenge", () => {
	test("submitting proof for a CANCELLED challenge is rejected", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Request access → PENDING
		const { challengeId, paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		const state = await readChallengeState(challengeId);
		expect(state).toBe("PENDING");

		// Step 2: Cancel the challenge (simulate engine.cancelChallenge)
		// Atomic transition: PENDING → CANCELLED
		const cancelled = await transitionChallengeState(challengeId, "PENDING", "CANCELLED");
		expect(cancelled).toBe(true);

		const cancelledState = await readChallengeState(challengeId);
		expect(cancelledState).toBe("CANCELLED");

		// Step 3: Try to submit payment → should fail
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		expect(result.status).not.toBe(200);
		expect(result.error).toBeDefined();
	}, 60_000);

	test("re-requesting access after cancellation creates a new challenge", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Create and cancel
		const { challengeId: firstId } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Cancel the challenge
		await transitionChallengeState(firstId, "PENDING", "CANCELLED");
		// Expire requestId index so a new challenge can be created
		await expireRequestIdIndex(requestId);

		// Re-request with same requestId
		const { challengeId: secondId } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		expect(secondId).not.toBe(firstId);
		expect(typeof secondId).toBe("string");
		expect(secondId.length).toBeGreaterThan(0);

		const newState = await readChallengeState(secondId);
		expect(newState).toBe("PENDING");
	}, 30_000);
});
