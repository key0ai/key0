/**
 * Challenge Timeout — verifies that once the requestId index key expires,
 * the same requestId creates a NEW challenge (idempotency resets after TTL).
 *
 * Simulates TTL expiry by deleting `agentgate:request:{requestId}` directly
 * from Redis, avoiding the need for a separate short-TTL Docker stack.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";
import { connectRedis } from "../helpers/redis-client.ts";

describe("Challenge Timeout", () => {
	test(
		"same requestId creates a new challenge after TTL expires (simulated via Redis key deletion)",
		async () => {
			const client = makeClientE2eClient();
			const redis = connectRedis();
			const requestId = crypto.randomUUID();

			// Step 1: Get first challenge
			const first = await client.requestAccess({ tierId: DEFAULT_TIER_ID, requestId });
			const challengeId1 = first.challengeId;
			expect(typeof challengeId1).toBe("string");
			expect(challengeId1.length).toBeGreaterThan(0);

			// Simulate TTL expiry: delete the requestId→challengeId index key
			const deleted = await redis.del(`agentgate:request:${requestId}`);
			expect(deleted).toBe(1);

			// Step 2: Same requestId → should create a NEW challenge (index key gone)
			const second = await client.requestAccess({ tierId: DEFAULT_TIER_ID, requestId });
			const challengeId2 = second.challengeId;
			expect(typeof challengeId2).toBe("string");
			expect(challengeId2).not.toBe(challengeId1);
		},
		30_000,
	);
});
