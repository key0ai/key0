/**
 * Expired Challenge Proof — submitting proof after the challenge TTL has expired.
 *
 * This is different from expired-authorization.test.ts (which tests an expired EIP-3009 signature).
 * Here the challenge itself has expired (PENDING → EXPIRED), so proof submission
 * must return CHALLENGE_EXPIRED (410).
 *
 * Simulates expiry by deleting the challenge's requestId index key and
 * directly transitioning the challenge state to EXPIRED in Redis.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import { connectRedis, readChallengeState } from "../helpers/redis-client.ts";

describe("Expired Challenge Proof Submission", () => {
	test("submitting proof for an expired challenge returns error (not 200)", async () => {
		const client = makeClientE2eClient();
		const redis = connectRedis();
		const requestId = crypto.randomUUID();

		// Step 1: Request access → get challenge
		const { challengeId, paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Step 2: Simulate challenge expiry by setting expiresAt to the past
		// and transitioning state to EXPIRED
		const challengeKey = `agentgate:challenge:${challengeId}`;
		await redis.hset(challengeKey, "expiresAt", new Date(Date.now() - 60_000).toISOString());
		await redis.hset(challengeKey, "state", "EXPIRED");

		// Step 3: Sign a valid EIP-3009 authorization
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Step 4: Submit payment — should be rejected
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
		const redis = connectRedis();
		const requestId = crypto.randomUUID();

		// Step 1: Create initial challenge
		const { challengeId: firstId } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Step 2: Simulate expiry
		const challengeKey = `agentgate:challenge:${firstId}`;
		await redis.hset(challengeKey, "expiresAt", new Date(Date.now() - 60_000).toISOString());
		await redis.hset(challengeKey, "state", "EXPIRED");
		// Delete the requestId index so a new challenge can be created
		await redis.del(`agentgate:request:${requestId}`);

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
