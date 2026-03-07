/**
 * Concurrent Same-Challenge Proof — two clients race to submit proof for the SAME challenge.
 *
 * This is the core atomicity test for `store.transition(PENDING → PAID)`.
 * Only one should succeed; the other must get a clear rejection
 * (PROOF_ALREADY_REDEEMED or INTERNAL_ERROR from concurrent state transition).
 *
 * Uses CLIENT and GAS wallets signing separate EIP-3009 authorizations for
 * the same challengeId, then submitting simultaneously via Promise.all.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient, makeGasE2eClient } from "../fixtures/wallets.ts";
import { readChallengeRecord } from "../helpers/redis-client.ts";

describe("Concurrent Same-Challenge Proof Submission", () => {
	test("only one of two concurrent proof submissions succeeds for the same challenge", async () => {
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

		// Step 3: Both submit payment for the SAME challenge simultaneously
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

		// Exactly one must succeed, the other must fail
		const successes = [resultA, resultB].filter((r) => r.status === 200);
		const failures = [resultA, resultB].filter((r) => r.status !== 200);

		expect(successes.length).toBe(1);
		expect(failures.length).toBe(1);

		// The winner must have a valid AccessGrant
		const winner = successes[0]!;
		expect(winner.grant).toBeDefined();
		expect(winner.grant!.type).toBe("AccessGrant");
		expect(winner.grant!.challengeId).toBe(challengeId);

		// The loser must have an error
		const loser = failures[0]!;
		expect(loser.error).toBeDefined();

		// Challenge must be in DELIVERED state (winner completed the flow)
		const record = await readChallengeRecord(challengeId);
		expect(record?.["state"]).toBe("DELIVERED");
	}, 120_000);
});
