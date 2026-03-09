/**
 * Concurrent Same-Challenge Proof — two clients race to submit proof for the SAME requestId.
 *
 * When two requests are truly simultaneous:
 *   - Both pass the pre-settlement check (both see PENDING)
 *   - Both settle on-chain
 *   - Winner: transition(PENDING → PAID → DELIVERED) succeeds
 *   - Loser: transition(PENDING → PAID) CAS fails → gets PROOF_ALREADY_REDEEMED (200)
 *     or "Concurrent state transition" (500) if winner hasn't reached DELIVERED yet
 *
 * This test verifies:
 *   - At least one succeeds with an AccessGrant
 *   - No uncontrolled crashes (all errors are AgentGateError responses)
 *   - Challenge ends in DELIVERED state (no data corruption)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient, makeGasE2eClient } from "../fixtures/wallets.ts";
import { readChallengeRecord } from "../helpers/storage-client.ts";

describe("Concurrent Same-Challenge Proof Submission", () => {
	test("concurrent submissions resolve safely — at least one succeeds, no corruption", async () => {
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

		const allResults = [resultA, resultB];
		const successes = allResults.filter((r) => r.status === 200);

		// At least one must succeed with a valid AccessGrant
		expect(successes.length).toBeGreaterThanOrEqual(1);
		expect(successes[0]!.grant).toBeDefined();
		expect(successes[0]!.grant!.type).toBe("AccessGrant");

		// All non-200 responses must be controlled errors (not unhandled crashes)
		// Expected: 500 "Concurrent state transition" or 200 cached grant
		for (const r of allResults) {
			if (r.status !== 200) {
				expect(r.error).toBeDefined();
			}
		}

		// Critical: challenge must end in DELIVERED state (no data corruption)
		const record = await readChallengeRecord(challengeId);
		expect(record?.["state"]).toBe("DELIVERED");
	}, 120_000);
});
