/**
 * Refund Failure — verifies REFUND_FAILED state when the refund tx reverts.
 *
 * Uses a separate Docker stack (docker-compose.e2e-refund-fail.yml) that has
 * AGENTGATE_WALLET_PRIVATE_KEY set to a deterministic empty wallet (0 USDC).
 * The refund cron attempts to send USDC from that empty wallet → tx reverts →
 * record transitions to REFUND_FAILED.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	AGENTGATE_URL,
	DEFAULT_TIER_ID,
	REFUND_FAIL_AGENTGATE_URL,
	REFUND_FAIL_REDIS_URL,
	REFUND_POLL_TIMEOUT_MS,
} from "../fixtures/constants.ts";
import { agentgateWalletAddress, clientWalletAddress } from "../fixtures/wallets.ts";
import {
	printLogs,
	startDockerStack,
	type StackConfig,
	stopDockerStack,
} from "../helpers/docker-manager.ts";
import {
	readChallengeState,
	setStorageBackend,
	writePaidChallengeRecord,
} from "../helpers/storage-client.ts";
import { waitForChallengeState } from "../helpers/wait.ts";

// Detect storage backend from env var
const usePostgres = process.env.E2E_STORAGE_BACKEND === "postgres";

const STACK_CONFIG: StackConfig = usePostgres
	? {
			composeFile: "docker-compose.e2e-refund-fail-postgres.yml",
			projectName: "agentgate-e2e-refund-fail-pg",
		}
	: {
			composeFile: "docker-compose.e2e-refund-fail.yml",
			projectName: "agentgate-e2e-refund-fail",
		};

beforeAll(async () => {
	console.log(`[refund-fail] Using storage backend: ${usePostgres ? "postgres" : "redis"}`);
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[refund-fail] Docker stack failed:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	// Verify AgentGate is reachable
	const healthRes = await fetch(`${REFUND_FAIL_AGENTGATE_URL}/health`);
	if (!healthRes.ok) {
		throw new Error(`AgentGate health check failed: ${healthRes.status}`);
	}
	const health = await healthRes.json();
	console.log("[refund-fail] AgentGate health:", health);

	// Configure storage backend for this test's helpers
	// Use refund-fail stack URLs
	setStorageBackend(
		usePostgres ? "postgres" : "redis",
		undefined,
		REFUND_FAIL_AGENTGATE_URL,
		usePostgres ? undefined : REFUND_FAIL_REDIS_URL,
	);
});

afterAll(async () => {
	stopDockerStack(STACK_CONFIG);

	// Reset storage helpers back to the main e2e stack defaults
	// (baseUrl → AGENTGATE_URL, redisUrl → null)
	setStorageBackend(usePostgres ? "postgres" : "redis", undefined, AGENTGATE_URL, null);
});

describe("Refund Failure", () => {
	test(
		"PAID record transitions to REFUND_FAILED when agentgate wallet has 0 USDC",
		async () => {
			const challengeId = `e2e-refund-fail-${crypto.randomUUID()}`;
			const clientAddr = clientWalletAddress();
			const agentgateAddr = agentgateWalletAddress();

			// Write PAID record to the refund-fail stack
			const paidAt = new Date(Date.now() - 10_000);
			await writePaidChallengeRecord({
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
			});

			// Poll until cron transitions to REFUND_FAILED
			// (empty wallet → transferWithAuthorization reverts → REFUND_FAILED)
			const finalState = await waitForChallengeState(
				async () => {
					const s = await readChallengeState(challengeId);
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
