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
	const sql = (strings: TemplateStringsArray | string, ...values: any[]): any => {
		// Handle sql(identifier) — used for table/column names
		if (typeof strings === "string") {
			return strings;
		}

		const query = strings.join("?").toLowerCase();

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
		// SELECT COUNT
		else if (query.includes("select count(*)")) {
			const tableName = values[0];
			const challengeId = values[1];
			const rows = findRows(tableName, (r) => r.challenge_id === challengeId);
			result = [{ count: rows.length.toString() }];
			count = 0;
		}
		// SELECT * WHERE challenge_id
		else if (query.includes("select * from") && query.includes("where challenge_id")) {
			const tableName = values[0];
			const challengeId = values[1];
			result = findRows(tableName, (r) => r.challenge_id === challengeId);
			count = 0;
		}
		// SELECT * WHERE request_id
		else if (query.includes("select * from") && query.includes("where request_id")) {
			const tableName = values[0];
			const requestId = values[1];
			result = findRows(tableName, (r) => r.request_id === requestId);
			count = 0;
		}
		// SELECT * WHERE state = 'PAID'
		else if (query.includes("select * from") && query.includes("where state = 'paid'")) {
			const tableName = values[0];
			result = findRows(
				tableName,
				(r) => r.state === "PAID" && r.from_address !== null && r.from_address !== undefined,
			);
			count = 0;
		}
		// INSERT INTO challenges
		else if (query.includes("insert into") && !query.includes("on conflict")) {
			const tableName = values[0];
			const rows = tables.get(tableName) || [];
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
				paid_at: values[14],
				tx_hash: values[15],
				access_grant: values[16],
				from_address: values[17],
				delivered_at: values[18],
				refund_tx_hash: values[19],
				refunded_at: values[20],
				refund_error: values[21],
			};
			rows.push(newRow);
			tables.set(tableName, rows);
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
			const existing = rows.find((r) => r.tx_hash === txHash);
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
			result = findRows(tableName, (r) => r.tx_hash === txHash);
			count = 0;
		}
		// UPDATE
		else if (query.includes("update") && query.includes("where challenge_id")) {
			// Parse the unsafe SQL fragment to extract SET clause
			// This is a simplified mock - in real tests you'd parse more carefully
			const tableName = values[0];
			// values[1] is the SET clause (from sql.unsafe)
			const setClause = typeof values[1] === "string" ? values[1] : "";
			const challengeId = values[2];
			const fromState = values[3];

			const updates: Partial<Row> = {};

			// Simple parsing for common patterns
			if (setClause.includes("state = ")) {
				// Extract state value from values array or unsafe clause
				const stateMatch = setClause.match(/state = '([^']+)'/);
				if (stateMatch) updates.state = stateMatch[1];
			}
			if (setClause.includes("tx_hash = ")) {
				const txHashMatch = setClause.match(/tx_hash = '([^']+)'/);
				if (txHashMatch) updates.tx_hash = txHashMatch[1];
			}
			if (setClause.includes("paid_at = ")) {
				const paidAtMatch = setClause.match(/paid_at = '([^']+)'/);
				if (paidAtMatch) updates.paid_at = new Date(paidAtMatch[1]);
			}
			if (setClause.includes("access_grant = ")) {
				const grantMatch = setClause.match(/access_grant = '(\{.+\})'::jsonb/);
				if (grantMatch) updates.access_grant = JSON.parse(grantMatch[1]);
			}
			if (setClause.includes("from_address = ")) {
				const fromMatch = setClause.match(/from_address = '([^']+)'/);
				if (fromMatch) updates.from_address = fromMatch[1];
			}
			if (setClause.includes("delivered_at = ")) {
				const deliveredMatch = setClause.match(/delivered_at = '([^']+)'/);
				if (deliveredMatch) updates.delivered_at = new Date(deliveredMatch[1]);
			}
			if (setClause.includes("refund_tx_hash = ")) {
				const refundTxMatch = setClause.match(/refund_tx_hash = '([^']+)'/);
				if (refundTxMatch) updates.refund_tx_hash = refundTxMatch[1];
			}
			if (setClause.includes("refunded_at = ")) {
				const refundedMatch = setClause.match(/refunded_at = '([^']+)'/);
				if (refundedMatch) updates.refunded_at = new Date(refundedMatch[1]);
			}
			if (setClause.includes("refund_error = ")) {
				const errorMatch = setClause.match(/refund_error = '([^']+)'/);
				if (errorMatch) {
					// Unescape double single quotes
					updates.refund_error = errorMatch[1].replace(/''/g, "'");
				}
			}

			count = updateRows(
				tableName,
				(r) => r.challenge_id === challengeId && r.state === fromState,
				updates,
			);
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
	(sql as { _tables: Map<string, Row[]> })._tables = tables;

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
		expect(results[0].challengeId).toBe(record.challengeId);
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
