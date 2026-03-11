import type {
	AccessGrant,
	AuditEntry,
	ChallengeRecord,
	ChallengeState,
	ChallengeTransitionUpdates,
	IAuditStore,
	IChallengeStore,
	ISeenTxStore,
	TransitionMeta,
} from "../../types";

// Type for postgres.js Sql instance
// We avoid importing the actual package since it's an optional peer dependency
type Sql = {
	<T = any>(
		strings: TemplateStringsArray,
		...values: any[]
	): Promise<T[]> & {
		count: number;
	};
	// Helper to safely insert identifiers (table/column names)
	(value: string): any;
	// Helper to build SET clauses from an object map, e.g. sql({ col: 1 }, "col")
	(values: Record<string, unknown>, ...columns: string[]): any;
	// Helper for unsafe raw SQL fragments
	unsafe(value: string): any;
	// Helper for JSON values
	json(value: unknown): any;
	// Transaction helper: begin a transaction and execute callback with transaction-scoped sql
	begin<T>(callback: (sql: Sql) => Promise<T>): Promise<T>;
};

// ─── Config ──────────────────────────────────────────────────────────

export type PostgresStoreConfig = {
	readonly sql: Sql;
	readonly tablePrefix?: string | undefined; // default: "key0"
	readonly autoMigrate?: boolean | undefined; // default: true — set false to manage migrations externally
	readonly challengeTTLSeconds?: number | undefined; // default: 900 (15 min) — request index TTL for findActiveByRequestId
	readonly recordTTLSeconds?: number | undefined; // default: 604_800 (7 days) — general record lifecycle TTL
	readonly deliveredTTLSeconds?: number | undefined; // default: 43_200 (12 hours) — TTL for DELIVERED records
};

// ─── Row types ───────────────────────────────────────────────────────

type ChallengeRow = {
	challenge_id: string;
	request_id: string;
	client_agent_id: string;
	resource_id: string;
	plan_id: string;
	amount: string;
	amount_raw: string; // NUMERIC comes back as string
	asset: string;
	chain_id: number;
	destination: string;
	state: string;
	expires_at: Date;
	created_at: Date;
	updated_at: Date;
	paid_at?: Date;
	tx_hash?: string;
	access_grant?: object; // JSONB
	from_address?: string;
	delivered_at?: Date;
	refund_tx_hash?: string;
	refunded_at?: Date;
	refund_error?: string;
	deleted_at?: Date;
};

type AuditRow = {
	id: string; // BIGSERIAL comes back as string
	challenge_id: string;
	request_id: string;
	client_agent_id: string | null;
	from_state: string | null;
	to_state: string;
	actor: string;
	reason: string | null;
	updates: object | null; // JSONB
	created_at: Date;
};

type SeenTxRow = {
	tx_hash: string;
	challenge_id: string;
	seen_at: Date;
};

// ─── Serialization helpers ───────────────────────────────────────────

function rowToChallengeRecord(row: ChallengeRow): ChallengeRecord {
	return {
		challengeId: row.challenge_id,
		requestId: row.request_id,
		clientAgentId: row.client_agent_id,
		resourceId: row.resource_id,
		planId: row.plan_id,
		amount: row.amount,
		amountRaw: BigInt(row.amount_raw),
		asset: row.asset as "USDC",
		chainId: row.chain_id,
		destination: row.destination as `0x${string}`,
		state: row.state as ChallengeState,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.paid_at ? { paidAt: row.paid_at } : {}),
		...(row.tx_hash ? { txHash: row.tx_hash as `0x${string}` } : {}),
		...(row.access_grant ? { accessGrant: row.access_grant as AccessGrant } : {}),
		...(row.from_address ? { fromAddress: row.from_address as `0x${string}` } : {}),
		...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
		...(row.refund_tx_hash ? { refundTxHash: row.refund_tx_hash as `0x${string}` } : {}),
		...(row.refunded_at ? { refundedAt: row.refunded_at } : {}),
		...(row.refund_error ? { refundError: row.refund_error } : {}),
	};
}

// ─── PostgresChallengeStore ──────────────────────────────────────────

export class PostgresChallengeStore implements IChallengeStore {
	private readonly sql: Sql;
	private readonly tablePrefix: string;
	private readonly tableName: string;
	private readonly auditTableName: string;
	private readonly stateEnumName: string;
	private readonly ready: Promise<void>;
	private readonly recordTTL: number; // seconds — general record lifecycle TTL
	private readonly deliveredTTL: number; // seconds — TTL for DELIVERED records

	constructor(config: PostgresStoreConfig) {
		this.sql = config.sql;
		this.tablePrefix = config.tablePrefix ?? "key0";
		this.tableName = `${this.tablePrefix}_challenges`;
		this.auditTableName = `${this.tablePrefix}_challenge_audit`;
		this.stateEnumName = `${this.tablePrefix}_challenge_state`;
		this.recordTTL = config.recordTTLSeconds ?? 604_800; // 7 days
		this.deliveredTTL = config.deliveredTTLSeconds ?? 43_200; // 12 hours
		this.ready = config.autoMigrate !== false ? this.createSchema() : Promise.resolve();
	}

	/**
	 * Helper to create the challenges table, audit table, and indexes.
	 * Call this once during setup/migration.
	 */
	async createSchema(): Promise<void> {
		// 1. Create the challenge_state enum type (idempotent)
		await this.sql.unsafe(`
			DO $$ BEGIN
				CREATE TYPE ${this.stateEnumName} AS ENUM (
					'PENDING', 'PAID', 'DELIVERED',
					'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED',
					'EXPIRED', 'CANCELLED'
				);
			EXCEPTION
				WHEN duplicate_object THEN NULL;
			END $$
		`);

		// 2. Create challenges table with enum state and updated_at
		await this.sql.unsafe(`
			CREATE TABLE IF NOT EXISTS ${this.tableName} (
				challenge_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL,
				client_agent_id TEXT NOT NULL,
				resource_id TEXT NOT NULL,
				plan_id TEXT NOT NULL,
				amount TEXT NOT NULL,
				amount_raw NUMERIC NOT NULL,
				asset TEXT NOT NULL,
				chain_id INTEGER NOT NULL,
				destination TEXT NOT NULL,
				state ${this.stateEnumName} NOT NULL,
				expires_at TIMESTAMPTZ NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				paid_at TIMESTAMPTZ,
				tx_hash TEXT,
				access_grant JSONB,
				from_address TEXT,
				delivered_at TIMESTAMPTZ,
				refund_tx_hash TEXT,
				refunded_at TIMESTAMPTZ,
				refund_error TEXT,
				deleted_at TIMESTAMPTZ
			)
		`);

		// 3. Auto-update trigger for updated_at
		await this.sql.unsafe(`
			CREATE OR REPLACE FUNCTION ${this.tableName}_set_updated_at()
			RETURNS TRIGGER AS $$
			BEGIN
				NEW.updated_at = NOW();
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql
		`);

		await this.sql.unsafe(`
			DO $$ BEGIN
				CREATE TRIGGER trg_${this.tableName}_updated_at
				BEFORE UPDATE ON ${this.tableName}
				FOR EACH ROW
				EXECUTE FUNCTION ${this.tableName}_set_updated_at();
			EXCEPTION
				WHEN duplicate_object THEN NULL;
			END $$
		`);

		// 4. Audit table — append-only, no updates or deletes
		await this.sql.unsafe(`
			CREATE TABLE IF NOT EXISTS ${this.auditTableName} (
				id BIGSERIAL PRIMARY KEY,
				challenge_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				client_agent_id TEXT,
				from_state ${this.stateEnumName},
				to_state ${this.stateEnumName} NOT NULL,
				actor TEXT NOT NULL DEFAULT 'system',
				reason TEXT,
				updates JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.auditTableName}_challenge_id_idx`)}
			ON ${this.sql(this.auditTableName)} (challenge_id)
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.auditTableName}_request_id_idx`)}
			ON ${this.sql(this.auditTableName)} (request_id)
		`;

		// 5. Revoke UPDATE and DELETE on the audit table to enforce write-only
		await this.sql.unsafe(`REVOKE UPDATE, DELETE ON ${this.auditTableName} FROM PUBLIC`);

		// 6. Indexes on challenges table
		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_request_id_idx`)}
			ON ${this.sql(this.tableName)} (request_id)
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_state_idx`)}
			ON ${this.sql(this.tableName)} (state)
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_deleted_at_idx`)}
			ON ${this.sql(this.tableName)} (deleted_at)
			WHERE deleted_at IS NOT NULL
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_created_at_idx`)}
			ON ${this.sql(this.tableName)} (created_at)
		`;
	}

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		await this.ready;
		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE challenge_id = ${challengeId}
			  AND deleted_at IS NULL
		`;

		if (rows.length === 0) return null;
		return rowToChallengeRecord(rows[0]!);
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		await this.ready;
		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE request_id = ${requestId}
			  AND deleted_at IS NULL
			ORDER BY created_at DESC
			LIMIT 1
		`;

		if (rows.length === 0) return null;
		return rowToChallengeRecord(rows[0]!);
	}

	async create(record: ChallengeRecord, meta?: TransitionMeta): Promise<void> {
		await this.ready;

		try {
			await this.sql.begin(async (sql) => {
				await sql`
					INSERT INTO ${sql(this.tableName)} (
						challenge_id,
						request_id,
						client_agent_id,
						resource_id,
						plan_id,
						amount,
						amount_raw,
						asset,
						chain_id,
						destination,
						state,
						expires_at,
						created_at,
						updated_at,
						paid_at,
						tx_hash,
						access_grant,
						from_address,
						delivered_at,
						refund_tx_hash,
						refunded_at,
						refund_error
					) VALUES (
						${record.challengeId},
						${record.requestId},
						${record.clientAgentId},
						${record.resourceId},
						${record.planId},
						${record.amount},
						${record.amountRaw.toString()},
						${record.asset},
						${record.chainId},
						${record.destination},
						${record.state},
						${record.expiresAt},
						${record.createdAt},
						${record.updatedAt},
						${record.paidAt ?? null},
						${record.txHash ?? null},
						${record.accessGrant ? sql.json(record.accessGrant) : null},
						${record.fromAddress ?? null},
						${record.deliveredAt ?? null},
						${record.refundTxHash ?? null},
						${record.refundedAt ?? null},
						${record.refundError ?? null}
					)
				`;

				// Audit: log the creation
				await sql`
					INSERT INTO ${sql(this.auditTableName)}
						(challenge_id, request_id, client_agent_id, from_state, to_state, actor, reason, updates)
					VALUES (
						${record.challengeId},
						${record.requestId},
						${record.clientAgentId},
						${null},
						${record.state},
						${meta?.actor ?? "engine"},
						${meta?.reason ?? "challenge_created"},
						${null}
					)
				`;
			});
		} catch (err: unknown) {
			const pgError = err as { code?: string };
			if (pgError?.code === "23505") {
				throw new Error(`Challenge ${record.challengeId} already exists`);
			}
			throw err;
		}
	}

	async transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
		meta?: TransitionMeta,
	): Promise<boolean> {
		await this.ready;
		// Build a parameterized SET clause using an update object so postgres.js
		// can safely escape all values.
		// Note: updated_at is auto-set by the BEFORE UPDATE trigger.
		const updateObj: Record<string, unknown> = { state: toState };

		if (updates?.txHash) {
			updateObj["tx_hash"] = updates.txHash;
		}
		if (updates?.paidAt) {
			updateObj["paid_at"] = updates.paidAt;
		}
		if (updates?.accessGrant) {
			updateObj["access_grant"] = updates.accessGrant;
		}
		if (updates?.fromAddress) {
			updateObj["from_address"] = updates.fromAddress;
		}
		if (updates?.deliveredAt) {
			updateObj["delivered_at"] = updates.deliveredAt;
		}
		if (updates?.refundTxHash) {
			updateObj["refund_tx_hash"] = updates.refundTxHash;
		}
		if (updates?.refundedAt) {
			updateObj["refunded_at"] = updates.refundedAt;
		}
		if (updates?.refundError) {
			updateObj["refund_error"] = updates.refundError;
		}

		let affected = false;
		await this.sql.begin(async (sql) => {
			const result = await sql`
				UPDATE ${sql(this.tableName)}
				SET ${sql(updateObj, ...Object.keys(updateObj))}
				WHERE challenge_id = ${challengeId} 
				  AND state = ${fromState}
				  AND deleted_at IS NULL
			`;

			// postgres.js result has .count property for affected rows
			affected = (result as unknown as { count: number }).count > 0;

			// Audit: log the transition (only if it actually happened)
			// Uses a CTE to pull request_id and client_agent_id from the challenge row.
			if (affected) {
				await sql`
					WITH ctx AS (
						SELECT request_id, client_agent_id
						FROM ${sql(this.tableName)}
						WHERE challenge_id = ${challengeId}
					)
					INSERT INTO ${sql(this.auditTableName)}
						(challenge_id, request_id, client_agent_id, from_state, to_state, actor, reason, updates)
					SELECT
						${challengeId},
						ctx.request_id,
						ctx.client_agent_id,
						${fromState},
						${toState},
						${meta?.actor ?? "system"},
						${meta?.reason ?? null},
						${updates ? sql.json(updates) : null}
					FROM ctx
				`;
			}
		});

		return affected;
	}

	async findPendingForRefund(minAgeMs: number): Promise<ChallengeRecord[]> {
		await this.ready;
		const minAgeSec = Math.floor(minAgeMs / 1000);

		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE state = 'PAID'
			  AND paid_at <= NOW() - make_interval(secs => ${minAgeSec})
			  AND from_address IS NOT NULL
			  AND deleted_at IS NULL
			ORDER BY paid_at ASC
		`;

		return rows.map(rowToChallengeRecord);
	}

	/**
	 * Clean up old records that have exceeded their TTL.
	 * This method soft-deletes records by setting deleted_at.
	 *
	 * @param olderThan Optional timestamp. If provided, only deletes records older than this.
	 *                  If not provided, uses TTL-based logic (recordTTL for general records,
	 *                  deliveredTTL for DELIVERED records).
	 * @returns Number of records cleaned up
	 */
	async cleanup(olderThan?: Date): Promise<number> {
		await this.ready;

		if (olderThan) {
			// Hard delete records older than the specified timestamp
			const result = await this.sql`
				DELETE FROM ${this.sql(this.tableName)}
				WHERE deleted_at IS NOT NULL
				  AND deleted_at < ${olderThan}
			`;
			return (result as unknown as { count: number }).count;
		}

		// Soft-delete records that have exceeded their TTL
		const result = await this.sql`
			UPDATE ${this.sql(this.tableName)}
			SET deleted_at = NOW()
			WHERE deleted_at IS NULL
			  AND (
				-- DELIVERED records: check delivered_at + deliveredTTL
				(state = 'DELIVERED' AND delivered_at IS NOT NULL AND delivered_at <= NOW() - make_interval(secs => ${this.deliveredTTL}))
				OR
				-- Other records: check created_at + recordTTL
				(state != 'DELIVERED' OR delivered_at IS NULL) AND created_at <= NOW() - make_interval(secs => ${this.recordTTL})
			  )
		`;

		return (result as unknown as { count: number }).count;
	}

	/**
	 * Permanently delete soft-deleted records older than the specified timestamp.
	 * Use this for periodic hard cleanup after soft-delete.
	 *
	 * @param olderThan Only delete records with deleted_at older than this timestamp
	 * @returns Number of records permanently deleted
	 */
	async purgeDeleted(olderThan: Date): Promise<number> {
		await this.ready;
		const result = await this.sql`
			DELETE FROM ${this.sql(this.tableName)}
			WHERE deleted_at IS NOT NULL
			  AND deleted_at < ${olderThan}
		`;
		return (result as unknown as { count: number }).count;
	}
}

// ─── PostgresAuditStore ──────────────────────────────────────────────

export class PostgresAuditStore implements IAuditStore {
	private readonly sql: Sql;
	private readonly tableName: string;

	constructor(config: Pick<PostgresStoreConfig, "sql" | "tablePrefix">) {
		this.sql = config.sql;
		const prefix = config.tablePrefix ?? "key0";
		this.tableName = `${prefix}_challenge_audit`;
	}

	async append(entry: Omit<AuditEntry, "id">): Promise<void> {
		await this.sql`
			INSERT INTO ${this.sql(this.tableName)}
				(challenge_id, request_id, client_agent_id, from_state, to_state, actor, reason, updates, created_at)
			VALUES (
				${entry.challengeId},
				${entry.requestId},
				${entry.clientAgentId ?? null},
				${entry.fromState},
				${entry.toState},
				${entry.actor},
				${entry.reason ?? null},
				${entry.updates ? this.sql.json(entry.updates) : null},
				${entry.createdAt}
			)
		`;
	}

	async getHistory(challengeId: string): Promise<AuditEntry[]> {
		const rows = await this.sql<AuditRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE challenge_id = ${challengeId}
			ORDER BY created_at ASC, id ASC
		`;
		return rows.map((row) => ({
			id: row.id,
			challengeId: row.challenge_id,
			requestId: row.request_id,
			...(row.client_agent_id != null ? { clientAgentId: row.client_agent_id } : {}),
			fromState: row.from_state as ChallengeState | null,
			toState: row.to_state as ChallengeState,
			actor: row.actor as AuditEntry["actor"],
			...(row.reason != null ? { reason: row.reason } : {}),
			updates: row.updates as Record<string, unknown> | null,
			createdAt: row.created_at,
		}));
	}
}

// ─── PostgresSeenTxStore ─────────────────────────────────────────────

export class PostgresSeenTxStore implements ISeenTxStore {
	private readonly sql: Sql;
	private readonly tablePrefix: string;
	private readonly tableName: string;
	private readonly ready: Promise<void>;

	constructor(config: Pick<PostgresStoreConfig, "sql" | "tablePrefix" | "autoMigrate">) {
		this.sql = config.sql;
		this.tablePrefix = config.tablePrefix ?? "key0";
		this.tableName = `${this.tablePrefix}_seen_txs`;
		this.ready = config.autoMigrate !== false ? this.createSchema() : Promise.resolve();
	}

	/**
	 * Helper to create the seen_txs table.
	 * Call this once during setup/migration.
	 */
	async createSchema(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS ${this.sql(this.tableName)} (
				tx_hash TEXT PRIMARY KEY,
				challenge_id TEXT NOT NULL,
				seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`;
	}

	async get(txHash: `0x${string}`): Promise<string | null> {
		await this.ready;
		const rows = await this.sql<SeenTxRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE tx_hash = ${txHash}
		`;

		if (rows.length === 0) return null;
		return rows[0]!.challenge_id;
	}

	async markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean> {
		await this.ready;
		try {
			const result = await this.sql`
				INSERT INTO ${this.sql(this.tableName)} (tx_hash, challenge_id)
				VALUES (${txHash}, ${challengeId})
				ON CONFLICT (tx_hash) DO NOTHING
			`;

			// If a row was inserted, count > 0
			return (result as unknown as { count: number }).count > 0;
		} catch {
			// If there's a constraint violation, return false
			return false;
		}
	}
}
