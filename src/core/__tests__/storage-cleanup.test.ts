import { describe, expect, test } from "bun:test";
import type { ChallengeRecord } from "../../types";
import { InMemoryChallengeStore } from "../storage/memory.js";

function makeChallengeRecord(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
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
		createdAt: new Date(),
		...overrides,
	};
}

describe("InMemoryChallengeStore — size guard", () => {
	test("rejects create when maxEntries exceeded", async () => {
		const store = new InMemoryChallengeStore({
			maxEntries: 2,
			cleanupIntervalMs: 0, // disable auto-cleanup
		});

		await store.create(makeChallengeRecord());
		await store.create(makeChallengeRecord());

		// Third should fail
		await expect(store.create(makeChallengeRecord())).rejects.toThrow("Store capacity exceeded");

		store.stopCleanup();
	});

	test("size property reflects count", async () => {
		const store = new InMemoryChallengeStore({ cleanupIntervalMs: 0 });
		expect(store.size).toBe(0);

		await store.create(makeChallengeRecord());
		expect(store.size).toBe(1);

		await store.create(makeChallengeRecord());
		expect(store.size).toBe(2);

		store.stopCleanup();
	});
});

describe("InMemoryChallengeStore — cleanup", () => {
	test("removes old EXPIRED records", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			expiredRetentionMs: 1000, // 1 second retention
		});

		const record = makeChallengeRecord({
			state: "EXPIRED",
			createdAt: new Date(Date.now() - 2000), // 2 seconds ago
		});
		await store.create(record);
		expect(store.size).toBe(1);

		const removed = store.cleanup();
		expect(removed).toBe(1);
		expect(store.size).toBe(0);

		store.stopCleanup();
	});

	test("removes old CANCELLED records", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			expiredRetentionMs: 1000,
		});

		const record = makeChallengeRecord({
			state: "CANCELLED",
			createdAt: new Date(Date.now() - 2000),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(1);

		store.stopCleanup();
	});

	test("removes old PAID records", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			paidRetentionMs: 1000,
		});

		const record = makeChallengeRecord({
			state: "PAID",
			createdAt: new Date(Date.now() - 2000),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(1);

		store.stopCleanup();
	});

	test("removes old REFUNDED records based on createdAt", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			paidRetentionMs: 1000,
		});

		const record = makeChallengeRecord({
			state: "REFUNDED",
			createdAt: new Date(Date.now() - 2000),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(1);

		store.stopCleanup();
	});

	test("removes old REFUND_FAILED records based on createdAt", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			paidRetentionMs: 1000,
		});

		const record = makeChallengeRecord({
			state: "REFUND_FAILED",
			createdAt: new Date(Date.now() - 2000),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(1);

		store.stopCleanup();
	});

	test("removes old DELIVERED records based on deliveredAt, not createdAt", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			deliveredRetentionMs: 1000,
		});

		// createdAt is recent but deliveredAt is old enough to expire
		const record = makeChallengeRecord({
			state: "DELIVERED",
			createdAt: new Date(), // just now — would NOT be removed by paidRetentionMs
			deliveredAt: new Date(Date.now() - 2000),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(1);

		store.stopCleanup();
	});

	test("keeps recent DELIVERED records within deliveredRetentionMs", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			deliveredRetentionMs: 60_000, // 1 minute
		});

		const record = makeChallengeRecord({
			state: "DELIVERED",
			createdAt: new Date(Date.now() - 999_999), // very old by createdAt
			deliveredAt: new Date(), // just delivered — should be kept
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(0);
		expect(store.size).toBe(1);

		store.stopCleanup();
	});

	test("keeps recent EXPIRED records", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			expiredRetentionMs: 60_000, // 1 minute
		});

		const record = makeChallengeRecord({
			state: "EXPIRED",
			createdAt: new Date(), // just now
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(0);
		expect(store.size).toBe(1);

		store.stopCleanup();
	});

	test("keeps PENDING records regardless of age", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			expiredRetentionMs: 1000,
		});

		const record = makeChallengeRecord({
			state: "PENDING",
			createdAt: new Date(Date.now() - 999_999),
		});
		await store.create(record);

		const removed = store.cleanup();
		expect(removed).toBe(0);
		expect(store.size).toBe(1);

		store.stopCleanup();
	});

	test("cleanup only removes eligible records", async () => {
		const store = new InMemoryChallengeStore({
			cleanupIntervalMs: 0,
			expiredRetentionMs: 1000,
			paidRetentionMs: 1000,
			deliveredRetentionMs: 1000,
		});

		// Old EXPIRED — should be removed
		await store.create(
			makeChallengeRecord({ state: "EXPIRED", createdAt: new Date(Date.now() - 5000) }),
		);
		// Recent PENDING — should be kept
		await store.create(makeChallengeRecord({ state: "PENDING" }));
		// Old PAID — should be removed
		await store.create(
			makeChallengeRecord({ state: "PAID", createdAt: new Date(Date.now() - 5000) }),
		);
		// Old DELIVERED (deliveredAt old) — should be removed
		await store.create(
			makeChallengeRecord({
				state: "DELIVERED",
				createdAt: new Date(),
				deliveredAt: new Date(Date.now() - 5000),
			}),
		);
		// Recent DELIVERED (deliveredAt just now) — should be kept
		await store.create(makeChallengeRecord({ state: "DELIVERED", deliveredAt: new Date() }));

		expect(store.size).toBe(5);
		const removed = store.cleanup();
		expect(removed).toBe(3);
		expect(store.size).toBe(2);

		store.stopCleanup();
	});
});
