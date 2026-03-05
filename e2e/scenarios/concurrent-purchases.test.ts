/**
 * Concurrent Purchases — two clients buying simultaneously.
 *
 * Uses CLIENT and GAS wallets as two independent buyers.
 * Both complete the full purchase flow in parallel.
 * Asserts: distinct grants, distinct txHashes, both in DELIVERED state in Redis.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient, makeGasE2eClient } from "../fixtures/wallets.ts";
import { readChallengeRecord } from "../helpers/redis-client.ts";

describe("Concurrent Purchases", () => {
	test(
		"two clients purchasing simultaneously both receive distinct grants",
		async () => {
			const clientA = makeClientE2eClient();
			const clientB = makeGasE2eClient();

			const [resultA, resultB] = await Promise.all([
				clientA.purchaseAccess({ tierId: DEFAULT_TIER_ID }),
				clientB.purchaseAccess({ tierId: DEFAULT_TIER_ID }),
			]);

			// Both must succeed
			expect(resultA.grant.type).toBe("AccessGrant");
			expect(resultB.grant.type).toBe("AccessGrant");

			// Grants must be distinct
			expect(resultA.grant.challengeId).not.toBe(resultB.grant.challengeId);
			expect(resultA.grant.txHash).not.toBe(resultB.grant.txHash);
			expect(resultA.grant.accessToken).not.toBe(resultB.grant.accessToken);

			// Both challenges must be in DELIVERED state
			const [recordA, recordB] = await Promise.all([
				readChallengeRecord(resultA.challengeId),
				readChallengeRecord(resultB.challengeId),
			]);

			expect(recordA?.["state"]).toBe("DELIVERED");
			expect(recordB?.["state"]).toBe("DELIVERED");
		},
		120_000,
	);
});
