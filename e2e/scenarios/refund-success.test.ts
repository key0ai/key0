/**
 * Refund Success — verifies PAID records are refunded by the cron.
 *
 * Setup: write a PAID record directly to Redis (faster than going through the full payment
 * flow, and doesn't depend on the token issuance failure path).
 *
 * The record has fromAddress = CLIENT_WALLET_ADDRESS and amountRaw = $0.01 USDC.
 * The refund cron picks it up (after REFUND_MIN_AGE_MS = 3s), sends USDC back,
 * and transitions the record to REFUNDED.
 *
 * USDC cost per run: $0.01 (the refunded amount is sent from AGENTGATE_WALLET to client).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID, REFUND_POLL_TIMEOUT_MS } from "../fixtures/constants.ts";
import { agentgateWalletAddress, clientWalletAddress } from "../fixtures/wallets.ts";
import {
	connectRedis,
	readChallengeState,
	writePaidChallengeRecord,
} from "../helpers/redis-client.ts";
import { waitForChallengeState } from "../helpers/wait.ts";

// $0.01 USDC — small amount to minimize testnet spend
const REFUND_AMOUNT_RAW = 10_000n;

describe("Refund Success", () => {
	test(
		"PAID record with fromAddress is refunded by the cron within timeout",
		async () => {
			const challengeId = `e2e-refund-${crypto.randomUUID()}`;
			const clientAddr = clientWalletAddress();
			const agentgateAddr = agentgateWalletAddress();
			const redis = connectRedis();

			// Record balance before refund
			// (actual USDC check requires on-chain read — simplified here to state check)

			// Write a PAID record to Redis that is past REFUND_MIN_AGE_MS (3s)
			// paidAt is in the past to be immediately eligible
			const paidAt = new Date(Date.now() - 10_000); // 10 seconds ago
			await writePaidChallengeRecord(
				{
					challengeId,
					requestId: crypto.randomUUID(),
					clientAgentId: `agent://${clientAddr}`,
					resourceId: "refund-test-resource",
					tierId: DEFAULT_TIER_ID,
					amount: "$0.01",
					amountRaw: REFUND_AMOUNT_RAW,
					destination: agentgateAddr,
					fromAddress: clientAddr,
					txHash: `0x${"ab".repeat(32)}` as `0x${string}`,
					paidAt,
				},
				redis,
			);

			// Verify initial state
			const initialState = await readChallengeState(challengeId, redis);
			expect(initialState).toBe("PAID");

			// Poll until refund cron transitions to REFUNDED (or REFUND_FAILED = also accepted, check error)
			const finalState = await waitForChallengeState(
				() => readChallengeState(challengeId, redis),
				"REFUNDED",
				REFUND_POLL_TIMEOUT_MS,
			);

			expect(finalState).toBe("REFUNDED");
		},
		REFUND_POLL_TIMEOUT_MS + 10_000,
	);
});
