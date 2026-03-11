/**
 * Refund Batch — verifies the refund cron handles multiple PAID records in one cycle.
 *
 * Writes 3 PAID records to Redis (all past REFUND_MIN_AGE_MS) and verifies
 * all transition to REFUNDED within the poll timeout.
 *
 * USDC cost per run: $0.03 (3 x $0.01 refunds).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID, REFUND_POLL_TIMEOUT_MS } from "../fixtures/constants.ts";
import { key0WalletAddress, clientWalletAddress } from "../fixtures/wallets.ts";
import { readChallengeState, writePaidChallengeRecord } from "../helpers/storage-client.ts";
import { pollUntil } from "../helpers/wait.ts";

const REFUND_AMOUNT_RAW = 10_000n; // $0.01 USDC
const BATCH_SIZE = 3;

describe("Refund Batch Processing", () => {
	test(
		`${BATCH_SIZE} PAID records are all refunded by the cron within timeout`,
		async () => {
			const clientAddr = clientWalletAddress();
			const key0Addr = key0WalletAddress();

			// Write multiple PAID records, all eligible for refund
			const challengeIds: string[] = [];
			for (let i = 0; i < BATCH_SIZE; i++) {
				const challengeId = `e2e-batch-refund-${i}-${crypto.randomUUID()}`;
				challengeIds.push(challengeId);

				await writePaidChallengeRecord({
					challengeId,
					requestId: crypto.randomUUID(),
					clientAgentId: `agent://${clientAddr}`,
					resourceId: `batch-refund-resource-${i}`,
					tierId: DEFAULT_TIER_ID,
					amount: "$0.01",
					amountRaw: REFUND_AMOUNT_RAW,
					destination: key0Addr,
					fromAddress: clientAddr,
					txHash: `0x${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}` as `0x${string}`,
					paidAt: new Date(Date.now() - 10_000), // 10s ago — past REFUND_MIN_AGE_MS
				});
			}

			// Verify all are PAID initially
			for (const id of challengeIds) {
				const state = await readChallengeState(id);
				expect(state).toBe("PAID");
			}

			// Poll until all have transitioned
			await pollUntil(async () => {
				const states = await Promise.all(challengeIds.map((id) => readChallengeState(id)));
				const allDone = states.every((s) => s === "REFUNDED" || s === "REFUND_FAILED");
				return allDone ? true : null;
			}, REFUND_POLL_TIMEOUT_MS);

			// Verify final states — all should be REFUNDED
			for (const id of challengeIds) {
				const finalState = await readChallengeState(id);
				expect(finalState).toBe("REFUNDED");
			}
		},
		REFUND_POLL_TIMEOUT_MS + 15_000,
	);
});
