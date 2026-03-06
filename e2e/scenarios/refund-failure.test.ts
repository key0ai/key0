/**
 * Refund Failure — verifies REFUND_FAILED state when the refund tx reverts.
 *
 * Uses a separate Docker stack (docker-compose.e2e-refund-fail.yml) that has
 * AGENTGATE_WALLET_PRIVATE_KEY set to a deterministic empty wallet (0 USDC).
 * The refund cron attempts to send USDC from that empty wallet → tx reverts →
 * record transitions to REFUND_FAILED.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import {
	DEFAULT_TIER_ID,
	REFUND_FAIL_REDIS_URL,
	REFUND_POLL_TIMEOUT_MS,
} from "../fixtures/constants.ts";
import { agentgateWalletAddress, clientWalletAddress } from "../fixtures/wallets.ts";
import { printLogs, startDockerStack, stopDockerStack } from "../helpers/docker-manager.ts";
import { writePaidChallengeRecord } from "../helpers/redis-client.ts";
import { waitForChallengeState } from "../helpers/wait.ts";

const STACK_CONFIG = {
	composeFile: "docker-compose.e2e-refund-fail.yml",
	projectName: "agentgate-e2e-refund-fail",
};

let redis: Redis | null = null;

beforeAll(async () => {
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[refund-fail] Docker stack failed:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	redis = new Redis(REFUND_FAIL_REDIS_URL);
});

afterAll(async () => {
	await redis?.quit();
	stopDockerStack(STACK_CONFIG);
});

describe("Refund Failure", () => {
	test(
		"PAID record transitions to REFUND_FAILED when agentgate wallet has 0 USDC",
		async () => {
			if (!redis) throw new Error("Redis not connected");

			const challengeId = `e2e-refund-fail-${crypto.randomUUID()}`;
			const clientAddr = clientWalletAddress();
			const agentgateAddr = agentgateWalletAddress();

			// Write PAID record to the refund-fail Redis instance
			const paidAt = new Date(Date.now() - 10_000);
			await writePaidChallengeRecord(
				{
					challengeId,
					requestId: crypto.randomUUID(),
					clientAgentId: `agent://${clientAddr}`,
					resourceId: "refund-fail-resource",
					tierId: DEFAULT_TIER_ID,
					amount: "$0.10",
					amountRaw: 100_000n,
					destination: agentgateAddr,
					fromAddress: clientAddr,
					txHash: `0x${"cd".repeat(32)}` as `0x${string}`,
					paidAt,
				},
				redis,
			);

			// Poll until cron transitions to REFUND_FAILED
			// (empty wallet → transferWithAuthorization reverts → REFUND_FAILED)
			const finalState = await waitForChallengeState(
				async () => {
					const s = await redis!.hget(`agentgate:challenge:${challengeId}`, "state");
					// Accept both REFUND_FAILED and REFUNDED (in case wallet has dust)
					return s === "REFUND_FAILED" || s === "REFUNDED" ? s : null;
				},
				"REFUND_FAILED",
				REFUND_POLL_TIMEOUT_MS,
			);

			// Wallet has 0 USDC → must fail
			expect(finalState).toBe("REFUND_FAILED");
		},
		REFUND_POLL_TIMEOUT_MS + 10_000,
	);
});
