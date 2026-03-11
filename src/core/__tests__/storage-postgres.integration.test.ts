import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AccessGrant, ChallengeRecord } from "../../types";
import { PostgresChallengeStore, PostgresSeenTxStore } from "../storage/postgres.js";

// ─── Environment ──────────────────────────────────────────────────────────────
//
// These tests talk to a REAL Postgres instance via postgres.js.
// They use KEY0_TEST_PG_URL when set, otherwise fall back to the local
// development URL you provided:
//   postgresql://localhost:5432/key0
//
// In CI, point KEY0_TEST_PG_URL at a dedicated throwaway database or a
// Testcontainers-managed instance.

const PG_URL = process.env["KEY0_TEST_PG_URL"] ?? "postgresql://localhost:5432/key0";

// Use a distinct prefix so we never collide with production tables even if the
// same database is (mis)configured.
const TABLE_PREFIX = "key0_it";

// Helper to generate a minimal ChallengeRecord for integration tests.
function makeChallengeRecord(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
	return {
		challengeId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		clientAgentId: "agent://itest",
		resourceId: "photo-42",
		tierId: "single",
		amount: "$0.10",
		amountRaw: 100000n,
		asset: "USDC",
		chainId: 84532,
		destination: `0x${"ab".repeat(20)}` as `0x${string}`,
		state: "PENDING",
		expiresAt: new Date("2025-01-01T12:00:00.000Z"),
		createdAt: new Date("2025-01-01T11:45:00.000Z"),
		updatedAt: new Date("2025-01-01T11:45:00.000Z"),
		...overrides,
	};
}

function makeGrant(): AccessGrant {
	return {
		type: "AccessGrant",
		challengeId: "c1",
		requestId: "r1",
		accessToken: "tok",
		tokenType: "Bearer",
		expiresAt: "2025-01-01T13:00:00.000Z",
		resourceEndpoint: "https://example.com/api/photos/42",
		resourceId: "photo-42",
		tierId: "single",
		txHash: `0x${"cc".repeat(32)}` as `0x${string}`,
		explorerUrl: "https://sepolia.basescan.org/tx/0x...",
	};
}

// Skip the whole suite if no Postgres URL is configured.
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg("PostgresChallengeStore (real Postgres)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: postgres.js runtime type
	let sql: any;
	let challengeStore: PostgresChallengeStore;
	let seenTxStore: PostgresSeenTxStore;

	beforeAll(async () => {
		// Lazy-import postgres.js so it's only required when these tests run.
		const postgresModule = await import("postgres");
		const postgres = (postgresModule as unknown as { default: unknown }).default as (
			// biome-ignore lint/suspicious/noExplicitAny: postgres.js signature
			url: string,
		) => any;

		sql = postgres(PG_URL as string);
		challengeStore = new PostgresChallengeStore({
			sql,
			tablePrefix: TABLE_PREFIX,
			autoMigrate: true,
		});
		seenTxStore = new PostgresSeenTxStore({
			sql,
			tablePrefix: TABLE_PREFIX,
			autoMigrate: true,
		});
	});

	afterAll(async () => {
		if (sql) {
			await sql.end?.();
		}
	});

	beforeEach(async () => {
		// Truncate tables between tests to get clean state.
		await sql`
			TRUNCATE TABLE ${sql(`${TABLE_PREFIX}_seen_txs`)} RESTART IDENTITY CASCADE
		`;
		await sql`
			TRUNCATE TABLE ${sql(`${TABLE_PREFIX}_challenges`)} RESTART IDENTITY CASCADE
		`;
	});

	test("create rejects duplicate challengeId under concurrency", async () => {
		const record = makeChallengeRecord();

		const attempts = Array.from({ length: 10 }, () =>
			challengeStore.create(record).then(
				() => "ok" as const,
				(err) => err as Error,
			),
		);

		const results = await Promise.all(attempts);
		const successes = results.filter((r) => r === "ok");
		const failures = results.filter((r) => r instanceof Error) as Error[];

		expect(successes.length).toBe(1);
		expect(failures.length).toBe(9);
		for (const err of failures) {
			expect(err.message).toContain("already exists");
		}

		// Sanity check: row is actually present.
		const loaded = await challengeStore.get(record.challengeId);
		expect(loaded).not.toBeNull();
	});

	test("transition is atomic with fromState check under concurrency", async () => {
		const record = makeChallengeRecord({ state: "PENDING" });
		await challengeStore.create(record);

		const [resPaid, resCancelled] = await Promise.all([
			challengeStore.transition(record.challengeId, "PENDING", "PAID", {
				txHash: `0x${"11".repeat(32)}` as `0x${string}`,
				paidAt: new Date("2025-01-01T11:55:00.000Z"),
			}),
			challengeStore.transition(record.challengeId, "PENDING", "CANCELLED"),
		]);

		// Exactly one of the two transitions should succeed.
		expect([resPaid, resCancelled].filter(Boolean).length).toBe(1);

		const loaded = await challengeStore.get(record.challengeId);
		expect(loaded).not.toBeNull();
		expect(loaded!.state === "PAID" || loaded!.state === "CANCELLED").toBe(true);
	});

	test("transition stores potentially malicious values safely (no SQL injection)", async () => {
		const record = makeChallengeRecord({ state: "PENDING" });
		await challengeStore.create(record);

		const maliciousTxHash =
			`0x${"aa".repeat(30)}'; DROP TABLE ${TABLE_PREFIX}_challenges; --` as `0x${string}`;

		const ok = await challengeStore.transition(record.challengeId, "PENDING", "PAID", {
			txHash: maliciousTxHash,
			paidAt: new Date("2025-01-01T11:55:00.000Z"),
			accessGrant: makeGrant(),
		});

		expect(ok).toBe(true);

		// Value should round-trip as data, not execute as SQL.
		const loaded = await challengeStore.get(record.challengeId);
		expect(loaded).not.toBeNull();
		expect(loaded!.txHash).toBe(maliciousTxHash);

		// Table should still exist and be writable.
		const another = makeChallengeRecord({ challengeId: crypto.randomUUID() });
		await challengeStore.create(another);
		const loaded2 = await challengeStore.get(another.challengeId);
		expect(loaded2).not.toBeNull();
	});

	test("PostgresSeenTxStore enforces uniqueness via ON CONFLICT", async () => {
		const txHash = `0x${"bb".repeat(32)}` as `0x${string}`;

		const first = await seenTxStore.markUsed(txHash, "challenge-1");
		const second = await seenTxStore.markUsed(txHash, "challenge-2");

		expect(first).toBe(true);
		expect(second).toBe(false);

		const owner = await seenTxStore.get(txHash);
		expect(owner).toBe("challenge-1");
	});
});

// If PG_URL is not set, surface a single skipped test so the reason is visible
// in test output instead of the file being silently ignored.
if (!PG_URL) {
	test.skip("Postgres integration tests (KEY0_TEST_PG_URL not set)", () => {});
}
