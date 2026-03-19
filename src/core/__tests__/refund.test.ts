import { beforeEach, describe, expect, mock, test } from "bun:test";
import { TestChallengeStore } from "../../test-utils/stores.js";
import type { ChallengeRecord } from "../../types/index.js";

// ─── Module mock — intercepts the sendUsdc import inside refund.ts ──────────

const REFUND_TX_HASH = `0x${"cc".repeat(32)}` as `0x${string}`;

// Mutable delegate — swap per-test to simulate success, failure, or custom behaviour
let sendUsdcImpl: () => Promise<`0x${string}`> = async () => REFUND_TX_HASH;

mock.module("../../adapter/send-usdc.js", () => ({
	sendUsdc: () => sendUsdcImpl(),
}));

// Import processRefunds AFTER mock.module so the mocked sendUsdc is in scope
const { processRefunds } = await import("../refund.js");

// Reset to success before each test
beforeEach(() => {
	sendUsdcImpl = async () => REFUND_TX_HASH;
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

const TX_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const PAYER = `0x${"11".repeat(20)}` as `0x${string}`;
const WALLET_KEY = `0x${"ff".repeat(32)}` as `0x${string}`;
const DESTINATION = `0x${"22".repeat(20)}` as `0x${string}`;

/** Returns a ChallengeRecord in PAID state that is old enough to be eligible for refund. */
function makePaidChallenge(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
	const now = new Date();
	return {
		challengeId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		clientAgentId: "did:example:buyer",
		resourceId: "resource-1",
		planId: "basic",
		amount: "$0.10",
		amountRaw: 100_000n,
		asset: "USDC",
		chainId: 84532,
		destination: DESTINATION,
		state: "PAID",
		expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		createdAt: new Date(Date.now() - 10 * 60 * 1000),
		updatedAt: now,
		// 10 minutes ago — past the default 5-min grace period
		paidAt: new Date(Date.now() - 10 * 60 * 1000),
		txHash: TX_HASH,
		fromAddress: PAYER,
		...overrides,
	};
}

// ─── processRefunds ────────────────────────────────────────────────────────

describe("processRefunds", () => {
	test("returns empty array when store has no records", async () => {
		const store = new TestChallengeStore();

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toEqual([]);
	});

	test("skips records that are newer than the grace period", async () => {
		const store = new TestChallengeStore();
		// Paid 1 minute ago — within default 5-min grace period
		const record = makePaidChallenge({ paidAt: new Date(Date.now() - 60_000) });
		await store.create(record);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
			minAgeMs: 300_000,
		});

		expect(results).toEqual([]);
		const updated = await store.get(record.challengeId);
		expect(updated?.state).toBe("PAID");
	});

	test("refunds an eligible record and returns success result", async () => {
		const store = new TestChallengeStore();
		const record = makePaidChallenge();
		await store.create(record);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(true);
		expect(results[0]?.challengeId).toBe(record.challengeId);
		expect(results[0]?.originalTxHash).toBe(TX_HASH);
		expect(results[0]?.refundTxHash).toBe(REFUND_TX_HASH);
		expect(results[0]?.amount).toBe("$0.10");
		expect(results[0]?.toAddress).toBe(PAYER);
	});

	test("transitions eligible record to REFUNDED with refundTxHash", async () => {
		const store = new TestChallengeStore();
		const record = makePaidChallenge();
		await store.create(record);

		await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		const updated = await store.get(record.challengeId);
		expect(updated?.state).toBe("REFUNDED");
		expect(updated?.refundTxHash).toBe(REFUND_TX_HASH);
		expect(updated?.refundedAt).toBeDefined();
	});

	test("transitions to REFUND_FAILED and returns error result when sendUsdc throws", async () => {
		sendUsdcImpl = async () => {
			throw new Error("RPC connection refused");
		};

		const store = new TestChallengeStore();
		const record = makePaidChallenge();
		await store.create(record);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(false);
		expect(results[0]?.error).toBe("RPC connection refused");
		expect(results[0]?.refundTxHash).toBeUndefined();

		const updated = await store.get(record.challengeId);
		expect(updated?.state).toBe("REFUND_FAILED");
		expect(updated?.refundError).toBe("RPC connection refused");
	});

	test("skips records that are already DELIVERED", async () => {
		const store = new TestChallengeStore();
		const record = makePaidChallenge({ state: "DELIVERED" });
		await store.create(record);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toEqual([]);
		const updated = await store.get(record.challengeId);
		expect(updated?.state).toBe("DELIVERED");
	});

	test("processes multiple eligible records and returns all results", async () => {
		const store = new TestChallengeStore();
		const recordA = makePaidChallenge({ txHash: `0x${"aa".repeat(32)}` as `0x${string}` });
		const recordB = makePaidChallenge({ txHash: `0x${"bb".repeat(32)}` as `0x${string}` });
		await store.create(recordA);
		await store.create(recordB);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);

		const updatedA = await store.get(recordA.challengeId);
		const updatedB = await store.get(recordB.challengeId);
		expect(updatedA?.state).toBe("REFUNDED");
		expect(updatedB?.state).toBe("REFUNDED");
	});

	test("handles mixed batch: some succeed, some fail", async () => {
		const store = new TestChallengeStore();
		const goodRecord = makePaidChallenge({ txHash: `0x${"aa".repeat(32)}` as `0x${string}` });
		const badRecord = makePaidChallenge({ txHash: `0x${"bb".repeat(32)}` as `0x${string}` });
		await store.create(goodRecord);
		await store.create(badRecord);

		let callCount = 0;
		sendUsdcImpl = async () => {
			callCount++;
			if (callCount === 2) throw new Error("insufficient balance");
			return REFUND_TX_HASH;
		};

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(results).toHaveLength(2);
		const successes = results.filter((r) => r.success);
		const failures = results.filter((r) => !r.success);
		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);
	});

	test("retries transient refund broadcast errors before marking REFUND_FAILED", async () => {
		const store = new TestChallengeStore();
		const record = makePaidChallenge();
		await store.create(record);

		let callCount = 0;
		sendUsdcImpl = async () => {
			callCount++;
			if (callCount === 1) throw new Error("RPC network timeout");
			return REFUND_TX_HASH;
		};

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		expect(callCount).toBe(2);
		expect(results).toHaveLength(1);
		expect(results[0]?.success).toBe(true);
		expect((await store.get(record.challengeId))?.state).toBe("REFUNDED");
	});

	test("prevents double-refund: concurrent claim fails silently", async () => {
		const store = new TestChallengeStore();
		const record = makePaidChallenge();
		await store.create(record);

		// Simulate a concurrent worker claiming the record mid-flight
		// by pre-transitioning it to REFUND_PENDING before processRefunds runs
		await store.transition(record.challengeId, "PAID", "REFUND_PENDING");

		let sendCalled = false;
		sendUsdcImpl = async () => {
			sendCalled = true;
			return REFUND_TX_HASH;
		};

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
		});

		// The record was already claimed, so processRefunds skips it
		expect(results).toEqual([]);
		expect(sendCalled).toBe(false);
	});

	test("only refunds records past the custom minAgeMs, ignores newer ones", async () => {
		const store = new TestChallengeStore();
		const oldRecord = makePaidChallenge({ paidAt: new Date(Date.now() - 10 * 60 * 1000) }); // 10 min ago
		const newRecord = makePaidChallenge({ paidAt: new Date(Date.now() - 2 * 60 * 1000) }); // 2 min ago
		await store.create(oldRecord);
		await store.create(newRecord);

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_KEY,
			network: "testnet",
			minAgeMs: 5 * 60 * 1000, // 5-min grace period
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.challengeId).toBe(oldRecord.challengeId);

		expect((await store.get(oldRecord.challengeId))?.state).toBe("REFUNDED");
		expect((await store.get(newRecord.challengeId))?.state).toBe("PAID");
	});
});
