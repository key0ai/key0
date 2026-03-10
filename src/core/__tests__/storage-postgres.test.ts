import { describe, expect, test } from "bun:test";
import type { AccessGrant, ChallengeRecord } from "../../types";
import { PostgresChallengeStore, PostgresSeenTxStore } from "../storage/postgres.js";

// ─── Mock postgres.js Sql instance ───────────────────────────────────

type Row = Record<string, unknown>;

function createMockSql() {
	const tables = new Map<string, Row[]>();

	// Helper to find rows
	const findRows = (tableName: string, filter?: (row: Row) => boolean): Row[] => {
		const rows = tables.get(tableName) || [];
		return filter ? rows.filter(filter) : rows;
	};

	// Helper to update rows
	const updateRows = (
		tableName: string,
		filter: (row: Row) => boolean,
		updates: Partial<Row>,
	): number => {
		const rows = tables.get(tableName) || [];
		let count = 0;
		for (const row of rows) {
			if (filter(row)) {
				Object.assign(row, updates);
				count++;
			}
		}
		return count;
	};

	// biome-ignore lint/suspicious/noExplicitAny: mock implementation
	const sql = (strings: any, ...values: any[]): any => {
		// Handle sql(identifier) — used for table/column names
		if (typeof strings === "string") {
			return strings;
		}

		// Handle sql(updateObj, ...columns) helper used for SET clause
		// Return a special object that the outer template handler can interpret.
		if (!Array.isArray(strings)) {
			const updateObj = strings as Row;
			const columns = values as string[];
			const updates: Row = {};
			for (const col of columns) {
				if (col in updateObj) {
					updates[col] = updateObj[col];
				}
			}
			return { __updates: updates };
		}

		const query = (strings as unknown as TemplateStringsArray).join("?").toLowerCase();

		let result: Row[] = [];
		let count = 0;

		// CREATE TABLE
		if (query.includes("create table if not exists")) {
			const tableName = values[0];
			if (!tables.has(tableName)) {
				tables.set(tableName, []);
			}
			result = [];
			count = 0;
		}
		// CREATE INDEX
		else if (query.includes("create index if not exists")) {
			result = [];
			count = 0;
		}
		// SELECT * WHERE challenge_id
		if (query.includes("select * from") && query.includes("where challenge_id")) {
			const tableName = values[0];
			const challengeId = values[1];
			result = findRows(
				tableName,
				(r) =>
					r["challenge_id"] === challengeId &&
					(r["deleted_at"] === null || r["deleted_at"] === undefined),
			);
			count = 0;
		}
		// SELECT * WHERE request_id
		else if (query.includes("select * from") && query.includes("where request_id")) {
			const tableName = values[0];
			const requestId = values[1];
			const matches = findRows(
				tableName,
				(r) =>
					r["request_id"] === requestId &&
					(r["deleted_at"] === null || r["deleted_at"] === undefined),
			);
			// Sort by created_at DESC and take first (matching ORDER BY created_at DESC LIMIT 1)
			if (query.includes("order by") && query.includes("limit")) {
				result = matches
					.sort(
						(a, b) =>
							new Date(b["created_at"] as Date).getTime() -
							new Date(a["created_at"] as Date).getTime(),
					)
					.slice(0, 1);
			} else {
				result = matches;
			}
			count = 0;
		}
		// SELECT * WHERE state = 'PAID'
		else if (query.includes("select * from") && query.includes("where state = 'paid'")) {
			const tableName = values[0];
			result = findRows(
				tableName,
				(r) =>
					r["state"] === "PAID" &&
					r["from_address"] !== null &&
					r["from_address"] !== undefined &&
					(r["deleted_at"] === null || r["deleted_at"] === undefined),
			);
			count = 0;
		}
		// INSERT INTO challenges or audit table
		else if (query.includes("insert into") && !query.includes("on conflict")) {
			const tableName = values[0];
			const rows = tables.get(tableName) || [];

			// Distinguish challenges INSERT (22 column values) from audit INSERT (4 column values)
			if (values.length > 10) {
				// Challenges table INSERT
				// Enforce primary key uniqueness on challenge_id to mimic Postgres behavior.
				const existing = rows.find((r) => r["challenge_id"] === values[1]);
				if (existing) {
					const error = new Error(
						'duplicate key value violates unique constraint "challenges_pkey"',
					) as Error & { code?: string };
					error.code = "23505";
					throw error;
				}

				const newRow: Row = {
					challenge_id: values[1],
					request_id: values[2],
					client_agent_id: values[3],
					resource_id: values[4],
					tier_id: values[5],
					amount: values[6],
					amount_raw: values[7],
					asset: values[8],
					chain_id: values[9],
					destination: values[10],
					state: values[11],
					expires_at: values[12],
					created_at: values[13],
					updated_at: values[14],
					paid_at: values[15],
					tx_hash: values[16],
					access_grant: values[17],
					from_address: values[18],
					delivered_at: values[19],
					refund_tx_hash: values[20],
					refunded_at: values[21],
					refund_error: values[22],
					deleted_at: null, // Default to null for new records
				};
				rows.push(newRow);
				tables.set(tableName, rows);
			} else {
				// Audit table INSERT (challenge_id, request_id, client_agent_id, from_state, to_state, updates, actor, reason)
				const auditRow: Row = {
					id: String(rows.length + 1),
					challenge_id: values[1],
					request_id: values[2],
					client_agent_id: values[3],
					from_state: values[4],
					to_state: values[5],
					updates: values[6],
					actor: values[7],
					reason: values[8],
					created_at: new Date(),
				};
				rows.push(auditRow);
				tables.set(tableName, rows);
			}
			result = [];
			count = 1;
		}
		// INSERT INTO seen_txs with ON CONFLICT
		else if (query.includes("insert into") && query.includes("on conflict")) {
			const tableName = values[0];
			const txHash = values[1];
			const challengeId = values[2];
			const rows = tables.get(tableName) || [];

			// Check if already exists
			const existing = rows.find((r) => r["tx_hash"] === txHash);
			if (existing) {
				result = [];
				count = 0; // ON CONFLICT DO NOTHING
			} else {
				rows.push({
					tx_hash: txHash,
					challenge_id: challengeId,
					seen_at: new Date(),
				});
				tables.set(tableName, rows);
				result = [];
				count = 1;
			}
		}
		// SELECT * FROM seen_txs WHERE tx_hash
		else if (query.includes("select * from") && query.includes("where tx_hash")) {
			const tableName = values[0];
			const txHash = values[1];
			result = findRows(tableName, (r) => r["tx_hash"] === txHash);
			count = 0;
		}
		// UPDATE (for transition and cleanup)
		else if (query.includes("update") && query.includes("where challenge_id")) {
			const tableName = values[0];
			const setArg = values[1];
			const challengeId = values[2];
			const fromState = values[3];

			// For updates we expect setArg to be the special object produced by
			// sql(updateObj, ...columns) above.
			const updates: Partial<Row> =
				setArg && typeof setArg === "object" && "__updates" in setArg
					? (setArg.__updates as Partial<Row>)
					: {};

			count = updateRows(
				tableName,
				(r) =>
					r["challenge_id"] === challengeId &&
					r["state"] === fromState &&
					(r["deleted_at"] === null || r["deleted_at"] === undefined),
				updates,
			);
			result = [];
		}
		// UPDATE for cleanup (soft-delete old records)
		else if (query.includes("update") && query.includes("set deleted_at = now()")) {
			const tableName = values[0];
			const now = new Date();
			let updated = 0;
			const rows = tables.get(tableName) || [];
			for (const row of rows) {
				if (row["deleted_at"] !== null && row["deleted_at"] !== undefined) continue;

				const state = row["state"] as string;
				const deliveredAt = row["delivered_at"] as Date | undefined;
				const createdAt = new Date(row["created_at"] as Date);

				let shouldDelete = false;
				if (state === "DELIVERED" && deliveredAt) {
					const deliveredTTL = values.find((v) => typeof v === "number" && v === 43200) || 43200;
					const ttlMs = deliveredTTL * 1000;
					if (new Date(deliveredAt).getTime() <= now.getTime() - ttlMs) {
						shouldDelete = true;
					}
				} else {
					const recordTTL = values.find((v) => typeof v === "number" && v === 604800) || 604800;
					const ttlMs = recordTTL * 1000;
					if (createdAt.getTime() <= now.getTime() - ttlMs) {
						shouldDelete = true;
					}
				}

				if (shouldDelete) {
					row["deleted_at"] = now;
					updated++;
				}
			}
			count = updated;
			result = [];
		}
		// DELETE for purgeDeleted
		else if (query.includes("delete from") && query.includes("where deleted_at")) {
			const tableName = values[0];
			const olderThan = values[1] as Date;
			const rows = tables.get(tableName) || [];
			const beforeCount = rows.length;
			const filtered = rows.filter((r) => {
				if (r["deleted_at"] === null || r["deleted_at"] === undefined) return true;
				return new Date(r["deleted_at"] as Date) >= olderThan;
			});
			tables.set(tableName, filtered);
			count = beforeCount - filtered.length;
			result = [];
		}

		// Return a promise that resolves to an array with a count property
		// This mimics postgres.js behavior where the result array has a .count property
		const resultWithCount = result as Row[] & { count: number };
		resultWithCount.count = count;
		return Promise.resolve(resultWithCount);
	};

	// Add helper methods
	sql.unsafe = (str: string) => str;
	sql.json = (obj: unknown) => obj;

	// Expose tables for inspection
	(sql as unknown as { _tables: Map<string, Row[]> })._tables = tables;

	return sql as unknown as {
		// biome-ignore lint/suspicious/noExplicitAny: mock type
		<T = any>(
			strings: TemplateStringsArray,
			...values: any[]
		): Promise<T[]> & {
			count: number;
		};
		// biome-ignore lint/suspicious/noExplicitAny: mock type
		(value: string): any;
		// biome-ignore lint/suspicious/noExplicitAny: mock type
		unsafe(value: string): any;
		// biome-ignore lint/suspicious/noExplicitAny: mock type
		json(value: unknown): any;
		_tables: Map<string, Row[]>; // for inspection
	} & { _tables: Map<string, Row[]> };
}

// ─── Test helpers ────────────────────────────────────────────────────

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

// ─── PostgresChallengeStore tests ────────────────────────────────────

describe("PostgresChallengeStore", () => {
	test("get returns null for missing challenge", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const result = await store.get("nonexistent");
		expect(result).toBeNull();
	});

	test("create + get round-trips all fields", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord();
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded).not.toBeNull();
		expect(loaded!.challengeId).toBe(record.challengeId);
		expect(loaded!.requestId).toBe(record.requestId);
		expect(loaded!.clientAgentId).toBe(record.clientAgentId);
		expect(loaded!.resourceId).toBe(record.resourceId);
		expect(loaded!.tierId).toBe(record.tierId);
		expect(loaded!.amount).toBe(record.amount);
		expect(loaded!.amountRaw).toBe(record.amountRaw);
		expect(loaded!.asset).toBe(record.asset);
		expect(loaded!.chainId).toBe(record.chainId);
		expect(loaded!.destination).toBe(record.destination);
		expect(loaded!.state).toBe("PENDING");
		expect(loaded!.expiresAt).toEqual(record.expiresAt);
		expect(loaded!.createdAt).toEqual(record.createdAt);
	});

	test("create + get round-trips bigint amountRaw", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord({ amountRaw: 999999999n });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.amountRaw).toBe(999999999n);
		expect(typeof loaded!.amountRaw).toBe("bigint");
	});

	test("create + get round-trips AccessGrant", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const grant = makeGrant();
		const record = makeChallengeRecord({ accessGrant: grant, state: "PAID" });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.accessGrant).toEqual(grant);
	});

	test("create + get round-trips optional paidAt and txHash", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const paidAt = new Date("2025-01-01T11:50:00.000Z");
		const txHash = `0x${"dd".repeat(32)}` as `0x${string}`;
		const record = makeChallengeRecord({ paidAt, txHash, state: "PAID" });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.paidAt).toEqual(paidAt);
		expect(loaded!.txHash).toBe(txHash);
	});

	test("create rejects duplicate challengeId", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord();
		await store.create(record);

		await expect(store.create(record)).rejects.toThrow("already exists");
	});

	test("findActiveByRequestId returns record", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord();
		await store.create(record);

		const found = await store.findActiveByRequestId(record.requestId);
		expect(found).not.toBeNull();
		expect(found!.challengeId).toBe(record.challengeId);
	});

	test("findActiveByRequestId returns null for missing requestId", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const found = await store.findActiveByRequestId("no-such-request");
		expect(found).toBeNull();
	});

	test("findActiveByRequestId returns latest challenge for requestId", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const requestId = crypto.randomUUID();

		// Older record
		const older = makeChallengeRecord({
			requestId,
			createdAt: new Date(Date.now() - 60_000),
			state: "PENDING",
		});
		await store.create(older);

		// Newer record with different state
		const newer = makeChallengeRecord({
			requestId,
			createdAt: new Date(),
			state: "DELIVERED",
		});
		await store.create(newer);

		const found = await store.findActiveByRequestId(requestId);
		expect(found).not.toBeNull();
		expect(found!.challengeId).toBe(newer.challengeId);
		expect(found!.state).toBe("DELIVERED");
	});

	test("transition succeeds when state matches", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		const ok = await store.transition(record.challengeId, "PENDING", "PAID", {
			txHash: `0x${"ee".repeat(32)}` as `0x${string}`,
			paidAt: new Date("2025-01-01T11:55:00.000Z"),
		});
		expect(ok).toBe(true);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.state).toBe("PAID");
		expect(loaded!.txHash).toBe(`0x${"ee".repeat(32)}`);
	});

	test("transition fails when state mismatches", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		const ok = await store.transition(record.challengeId, "PAID", "EXPIRED");
		expect(ok).toBe(false);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.state).toBe("PENDING"); // unchanged
	});

	test("transition passes accessGrant", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		const record = makeChallengeRecord({ state: "PAID" });
		await store.create(record);

		const grant = makeGrant();
		const ok = await store.transition(record.challengeId, "PAID", "PAID", {
			accessGrant: grant,
		});
		expect(ok).toBe(true);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.accessGrant).toEqual(grant);
	});

	test("uses custom tablePrefix", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({
			sql: sql as never,
			tablePrefix: "myapp",
		});

		const record = makeChallengeRecord();
		await store.create(record);

		// Verify it's in the custom table
		expect((sql as { _tables: Map<string, Row[]> })._tables.has("myapp_challenges")).toBe(true);
	});

	test("findPendingForRefund returns eligible records", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		// Create a PAID record
		const paidAt = new Date("2025-01-01T11:00:00.000Z");
		const record = makeChallengeRecord({
			state: "PAID",
			paidAt,
			fromAddress: `0x${"cc".repeat(20)}` as `0x${string}`,
		});
		await store.create(record);

		// Find records older than 5 minutes (300,000 ms)
		const results = await store.findPendingForRefund(300_000);
		expect(results.length).toBe(1);
		expect(results[0]!.challengeId).toBe(record.challengeId);
	});

	test("cleanup soft-deletes old records", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({
			sql: sql as never,
			recordTTLSeconds: 604_800, // 7 days
			deliveredTTLSeconds: 43_200, // 12 hours
		});

		// Create old records that should be cleaned up
		const oldCreatedAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 8); // 8 days ago
		const oldDeliveredAt = new Date(Date.now() - 1000 * 60 * 60 * 13); // 13 hours ago

		const oldRecord = makeChallengeRecord({
			state: "PAID",
			createdAt: oldCreatedAt,
		});
		await store.create(oldRecord);

		const oldDeliveredRecord = makeChallengeRecord({
			state: "DELIVERED",
			deliveredAt: oldDeliveredAt,
			createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
		});
		await store.create(oldDeliveredRecord);

		// Create a recent record that should NOT be cleaned up
		const recentRecord = makeChallengeRecord({
			state: "PENDING",
			createdAt: new Date(), // Now
		});
		await store.create(recentRecord);

		// Run cleanup
		const deletedCount = await store.cleanup();
		expect(deletedCount).toBe(2); // Should delete 2 old records

		// Verify old records are soft-deleted (get returns null)
		expect(await store.get(oldRecord.challengeId)).toBeNull();
		expect(await store.get(oldDeliveredRecord.challengeId)).toBeNull();

		// Verify recent record is still accessible
		expect(await store.get(recentRecord.challengeId)).not.toBeNull();
	});

	test("purgeDeleted permanently deletes soft-deleted records", async () => {
		const sql = createMockSql();
		const store = new PostgresChallengeStore({ sql: sql as never });

		// Create and soft-delete a record
		const record = makeChallengeRecord();
		await store.create(record);

		// Manually soft-delete by setting deleted_at (simulating cleanup)
		const tables = (sql as unknown as { _tables: Map<string, Row[]> })._tables;
		const rows = tables.get("key2a_challenges") || [];
		const row = rows.find((r) => r["challenge_id"] === record.challengeId);
		if (row) {
			row["deleted_at"] = new Date(Date.now() - 1000 * 60 * 60 * 24); // 1 day ago
		}

		// Purge records deleted more than 12 hours ago
		const purgeDate = new Date(Date.now() - 1000 * 60 * 60 * 12);
		const purgedCount = await store.purgeDeleted(purgeDate);
		expect(purgedCount).toBe(1);

		// Verify record is permanently deleted
		const remainingRows = tables.get("key2a_challenges") || [];
		expect(remainingRows.find((r) => r["challenge_id"] === record.challengeId)).toBeUndefined();
	});
});

// ─── PostgresSeenTxStore tests ───────────────────────────────────────

describe("PostgresSeenTxStore", () => {
	const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;

	test("get returns null for unseen txHash", async () => {
		const sql = createMockSql();
		const store = new PostgresSeenTxStore({ sql: sql as never });

		const result = await store.get(TX_HASH);
		expect(result).toBeNull();
	});

	test("markUsed returns true on first call", async () => {
		const sql = createMockSql();
		const store = new PostgresSeenTxStore({ sql: sql as never });

		const result = await store.markUsed(TX_HASH, "challenge-1");
		expect(result).toBe(true);
	});

	test("markUsed returns false on duplicate", async () => {
		const sql = createMockSql();
		const store = new PostgresSeenTxStore({ sql: sql as never });

		await store.markUsed(TX_HASH, "challenge-1");
		const result = await store.markUsed(TX_HASH, "challenge-2");
		expect(result).toBe(false);
	});

	test("get returns challengeId after markUsed", async () => {
		const sql = createMockSql();
		const store = new PostgresSeenTxStore({ sql: sql as never });

		await store.markUsed(TX_HASH, "challenge-1");
		const result = await store.get(TX_HASH);
		expect(result).toBe("challenge-1");
	});

	test("uses custom tablePrefix", async () => {
		const sql = createMockSql();
		const store = new PostgresSeenTxStore({
			sql: sql as never,
			tablePrefix: "custom",
		});

		await store.markUsed(TX_HASH, "challenge-1");
		expect((sql as { _tables: Map<string, Row[]> })._tables.has("custom_seen_txs")).toBe(true);
	});
});
