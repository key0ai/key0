import { describe, expect, test } from "bun:test";
import { TestChallengeStore, TestSeenTxStore } from "../../test-utils/stores.js";
import type { ChallengeRecord } from "../../types";

function makeChallengeRecord(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
	const now = new Date();
	return {
		challengeId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		clientAgentId: "agent://test",
		resourceId: "photo-42",
		tierId: "single",
		amount: "$0.10",
		amountRaw: 100000n,
		asset: "USDC",
		chainId: 84532,
		destination: `0x${"ab".repeat(20)}` as `0x${string}`,
		state: "PENDING",
		expiresAt: new Date(Date.now() + 900_000),
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("Concurrency — ChallengeStore transitions", () => {
	test("two simultaneous transitions — only one succeeds", async () => {
		const store = new TestChallengeStore();
		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		// Fire two transitions concurrently
		const [a, b] = await Promise.all([
			store.transition(record.challengeId, "PENDING", "PAID", {
				txHash: `0x${"aa".repeat(32)}` as `0x${string}`,
				paidAt: new Date(),
			}),
			store.transition(record.challengeId, "PENDING", "EXPIRED"),
		]);

		// Exactly one should succeed
		expect([a, b].filter(Boolean).length).toBe(1);

		const loaded = await store.get(record.challengeId);
		// Should be either PAID or EXPIRED, not PENDING
		expect(loaded!.state).not.toBe("PENDING");
	});

	test("three simultaneous transitions — exactly one succeeds", async () => {
		const store = new TestChallengeStore();
		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		const results = await Promise.all([
			store.transition(record.challengeId, "PENDING", "PAID"),
			store.transition(record.challengeId, "PENDING", "EXPIRED"),
			store.transition(record.challengeId, "PENDING", "CANCELLED"),
		]);

		expect(results.filter(Boolean).length).toBe(1);
	});

	test("transition after successful transition fails", async () => {
		const store = new TestChallengeStore();
		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		const first = await store.transition(record.challengeId, "PENDING", "PAID");
		expect(first).toBe(true);

		// Attempting the same transition again must fail
		const second = await store.transition(record.challengeId, "PENDING", "EXPIRED");
		expect(second).toBe(false);
	});
});

describe("Concurrency — SeenTxStore double-spend guard", () => {
	const TX_HASH = `0x${"ff".repeat(32)}` as `0x${string}`;

	test("two simultaneous markUsed — only one succeeds", async () => {
		const store = new TestSeenTxStore();

		const [a, b] = await Promise.all([
			store.markUsed(TX_HASH, "challenge-1"),
			store.markUsed(TX_HASH, "challenge-2"),
		]);

		// Exactly one should succeed
		expect([a, b].filter(Boolean).length).toBe(1);

		// The stored challengeId should match the one that succeeded
		const stored = await store.get(TX_HASH);
		expect(stored).not.toBeNull();
		if (a) {
			expect(stored).toBe("challenge-1");
		} else {
			expect(stored).toBe("challenge-2");
		}
	});

	test("markUsed after successful markUsed always fails", async () => {
		const store = new TestSeenTxStore();

		const first = await store.markUsed(TX_HASH, "challenge-1");
		expect(first).toBe(true);

		const second = await store.markUsed(TX_HASH, "challenge-2");
		expect(second).toBe(false);

		const third = await store.markUsed(TX_HASH, "challenge-3");
		expect(third).toBe(false);

		// Original remains
		expect(await store.get(TX_HASH)).toBe("challenge-1");
	});
});

describe("Concurrency — idempotent create", () => {
	test("creating same challengeId twice rejects second", async () => {
		const store = new TestChallengeStore();
		const record = makeChallengeRecord();

		await store.create(record);
		await expect(store.create(record)).rejects.toThrow("already exists");
	});

	test("concurrent creates with same challengeId — one succeeds, one rejects", async () => {
		const store = new TestChallengeStore();
		const record = makeChallengeRecord();

		const results = await Promise.allSettled([store.create(record), store.create(record)]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
	});
});

describe("Concurrency — rapid sequential operations", () => {
	test("many sequential transitions maintain consistency", async () => {
		const store = new TestChallengeStore();

		// Create 10 challenges and transition them all
		const records = Array.from({ length: 10 }, () => makeChallengeRecord());
		for (const r of records) {
			await store.create(r);
		}

		// Transition all to PAID
		const results = await Promise.all(
			records.map((r) =>
				store.transition(r.challengeId, "PENDING", "PAID", {
					txHash: `0x${"bb".repeat(32)}` as `0x${string}`,
					paidAt: new Date(),
				}),
			),
		);

		// All should succeed (different challenges, no conflict)
		expect(results.every(Boolean)).toBe(true);

		// Verify all are PAID
		for (const r of records) {
			const loaded = await store.get(r.challengeId);
			expect(loaded!.state).toBe("PAID");
		}
	});
});
