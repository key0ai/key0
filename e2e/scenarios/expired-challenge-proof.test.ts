/**
 * Expired Challenge Proof — verifies that payment is rejected when a challenge has expired.
 *
 * The pre-settlement check and processHttpPayment both reject EXPIRED challenges.
 * No USDC is burned — the rejection happens before on-chain settlement.
 *
 * Also tests that re-requesting access after expiry creates a new challenge.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import {
	expireRequestIdIndex,
	readChallengeState,
	transitionChallengeState,
} from "../helpers/storage-client.ts";

describe("Expired Challenge Proof Submission", () => {
	test("submitting proof for an expired challenge returns error (not 200)", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Request access → get challenge
		const { challengeId, paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Step 2: Simulate challenge expiry by transitioning to EXPIRED
		await transitionChallengeState(challengeId, "PENDING", "EXPIRED");

		// Step 3: Sign a valid EIP-3009 authorization
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Step 4: Submit payment — should be rejected by pre-settlement check
		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		// Must not succeed — challenge is expired
		expect(result.status).not.toBe(200);
		expect(result.error).toBeDefined();

		// Verify the challenge is still in EXPIRED state (not re-activated)
		const finalState = await readChallengeState(challengeId);
		expect(finalState).toBe("EXPIRED");
	}, 60_000);

	test("requesting access with same requestId after expiry creates a new challenge", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Create initial challenge
		const { challengeId: firstId } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Step 2: Simulate expiry
		await transitionChallengeState(firstId, "PENDING", "EXPIRED");
		// Expire the requestId index so a new challenge can be created
		await expireRequestIdIndex(requestId);

		// Step 3: Re-request with same requestId → new challenge
		const { challengeId: secondId } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		expect(secondId).not.toBe(firstId);
		expect(typeof secondId).toBe("string");
		expect(secondId.length).toBeGreaterThan(0);
	}, 30_000);
});
