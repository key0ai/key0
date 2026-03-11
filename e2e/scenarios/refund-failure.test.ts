/**
 * Refund Failure — verifies REFUND_FAILED state when the refund tx reverts.
 *
 * Uses a separate Docker stack (docker-compose.e2e-refund-fail.yml) that has
 * KEY0_WALLET_PRIVATE_KEY set to a deterministic empty wallet (0 USDC).
 * The refund cron attempts to send USDC from that empty wallet → tx reverts →
 * record transitions to REFUND_FAILED.
 *
 * IMPORTANT: This test uses a dedicated Redis client to avoid polluting the
 * shared storage-client module state (redisUrl / baseUrl) which would break
 * concurrently running tests that rely on the main Docker stack's Redis.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import {
	DEFAULT_TIER_ID,
	REFUND_FAIL_KEY0_URL,
	REFUND_FAIL_REDIS_URL,
	REFUND_POLL_TIMEOUT_MS,
} from "../fixtures/constants.ts";
import { clientWalletAddress, key0WalletAddress } from "../fixtures/wallets.ts";
import {
	printLogs,
	type StackConfig,
	startDockerStack,
	stopDockerStack,
} from "../helpers/docker-manager.ts";
import {
	readChallengeState as redisReadState,
	writePaidChallengeRecord as redisWritePaid,
} from "../helpers/redis-client.ts";
import { waitForChallengeState } from "../helpers/wait.ts";

// Detect storage backend from env var
const usePostgres = process.env.E2E_STORAGE_BACKEND === "postgres";

const STACK_CONFIG: StackConfig = usePostgres
	? {
			composeFile: "docker-compose.e2e-refund-fail-postgres.yml",
			projectName: "key0-e2e-refund-fail-pg",
		}
	: {
			composeFile: "docker-compose.e2e-refund-fail.yml",
			projectName: "key0-e2e-refund-fail",
		};

/** Dedicated Redis client for the refund-fail stack — no shared state pollution. */
let refundFailRedis: Redis | null = null;

beforeAll(async () => {
	console.log(`[refund-fail] Using storage backend: ${usePostgres ? "postgres" : "redis"}`);
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[refund-fail] Docker stack failed:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	// Verify Key0 is reachable
	const healthRes = await fetch(`${REFUND_FAIL_KEY0_URL}/health`);
	if (!healthRes.ok) {
		throw new Error(`Key0 health check failed: ${healthRes.status}`);
	}
	const health = await healthRes.json();
	console.log("[refund-fail] Key0 health:", health);

	// Create a dedicated Redis client for this stack (Redis path only)
	if (!usePostgres) {
		refundFailRedis = new Redis(REFUND_FAIL_REDIS_URL);
		refundFailRedis.on("error", (err) => {
			console.error("[refund-fail redis] connection error:", err.message);
		});
	}
});

afterAll(async () => {
	if (refundFailRedis) {
		await refundFailRedis.quit();
		refundFailRedis = null;
	}
	stopDockerStack(STACK_CONFIG);
});

describe("Refund Failure", () => {
	test(
		"PAID record transitions to REFUND_FAILED when key0 wallet has 0 USDC",
		async () => {
			const challengeId = `e2e-refund-fail-${crypto.randomUUID()}`;
			const clientAddr = clientWalletAddress();
			const key0Addr = key0WalletAddress();

			// Write PAID record to the refund-fail stack's storage
			const paidAt = new Date(Date.now() - 10_000);
			const record = {
				challengeId,
				requestId: crypto.randomUUID(),
				clientAgentId: `agent://${clientAddr}`,
				resourceId: "refund-fail-resource",
				planId: DEFAULT_TIER_ID,
				amount: "$0.10",
				amountRaw: 100_000n,
				destination: key0Addr,
				fromAddress: clientAddr,
				txHash: `0x${"cd".repeat(32)}` as `0x${string}`,
				paidAt,
			};

			if (usePostgres) {
				const res = await fetch(`${REFUND_FAIL_KEY0_URL}/test/write-paid-challenge`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...record,
						amountRaw: record.amountRaw.toString(),
						paidAt: record.paidAt.toISOString(),
					}),
				});
				if (!res.ok) {
					throw new Error(`Failed to write PAID challenge: ${res.status} ${await res.text()}`);
				}
			} else {
				await redisWritePaid(record, refundFailRedis!);
			}

			// Poll until cron transitions to REFUND_FAILED
			// (empty wallet → transferWithAuthorization reverts → REFUND_FAILED)
			const finalState = await waitForChallengeState(
				async () => {
					if (usePostgres) {
						const res = await fetch(`${REFUND_FAIL_KEY0_URL}/test/challenge/${challengeId}`);
						if (res.status === 404) return null;
						if (!res.ok) return null;
						const data = (await res.json()) as { state?: string };
						const s = data.state ?? null;
						return s === "REFUND_FAILED" || s === "REFUNDED" ? s : null;
					}
					const s = await redisReadState(challengeId, refundFailRedis!);
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
