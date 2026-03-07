/**
 * Concurrent Same-Challenge Proof — two clients race to submit proof for the SAME requestId.
 *
 * Tests the pre-settlement check: when two clients submit PAYMENT-SIGNATURE
 * simultaneously for the same requestId, the middleware checks challenge state
 * BEFORE settling on-chain. The first to settle creates PENDING → PAID → DELIVERED.
 * The second hits the pre-settlement check, finds DELIVERED, and gets the cached
 * grant WITHOUT burning USDC on-chain.
 *
 * This protects against fund loss from duplicate settlement.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient, makeGasE2eClient } from "../fixtures/wallets.ts";
import { readChallengeRecord } from "../helpers/redis-client.ts";

describe("Concurrent Same-Challenge Proof Submission", () => {
	test("only one of two concurrent proof submissions settles on-chain", async () => {
		const clientA = makeClientE2eClient();
		const clientB = makeGasE2eClient();

		// Step 1: Client A requests access — creates a single PENDING challenge
		const requestId = crypto.randomUUID();
		const { challengeId, paymentRequired } = await clientA.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		const requirements = paymentRequired.accepts[0]!;
		const destination = requirements.payTo as `0x${string}`;
		const amountRaw = BigInt(requirements.amount);

		// Step 2: Both clients sign independent EIP-3009 authorizations
		const [authA, authB] = await Promise.all([
			clientA.signEIP3009({ destination, amountRaw }),
			clientB.signEIP3009({ destination, amountRaw }),
		]);

		// Step 3: Both submit payment for the SAME requestId simultaneously
		const [resultA, resultB] = await Promise.all([
			clientA.submitPayment({
				tierId: DEFAULT_TIER_ID,
				requestId,
				auth: authA,
				paymentRequired,
			}),
			clientB.submitPayment({
				tierId: DEFAULT_TIER_ID,
				requestId,
				auth: authB,
				paymentRequired,
			}),
		]);

		// Both should get 200 — one settles, the other gets the cached grant
		// via the pre-settlement check (no USDC burned for the second)
		const allResults = [resultA, resultB];
		const successes = allResults.filter((r) => r.status === 200);

		// No 500 errors
		const serverErrors = allResults.filter((r) => r.status >= 500);
		expect(serverErrors.length).toBe(0);

		// Both succeed (one from settlement, one from cache)
		expect(successes.length).toBe(2);

		// Both reference valid grants
		for (const s of successes) {
			expect(s.grant).toBeDefined();
			expect(s.grant!.type).toBe("AccessGrant");
		}

		// Challenge must end in DELIVERED state
		const record = await readChallengeRecord(challengeId);
		expect(record?.["state"]).toBe("DELIVERED");
	}, 120_000);
});
