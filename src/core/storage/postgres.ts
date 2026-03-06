import type {
	AccessGrant,
	ChallengeRecord,
	ChallengeState,
	ChallengeTransitionUpdates,
	IChallengeStore,
	ISeenTxStore,
} from "../../types";

// Type for postgres.js Sql instance
// We avoid importing the actual package since it's an optional peer dependency
type Sql = {
	// biome-ignore lint/suspicious/noExplicitAny: postgres.js query signature
	<T = any>(
		strings: TemplateStringsArray,
		...values: any[]
	): Promise<T[]> & {
		count: number;
	};
	// Helper to safely insert identifiers (table/column names)
	// biome-ignore lint/suspicious/noExplicitAny: postgres.js helper signature
	(value: string): any;
	// Helper for unsafe raw SQL fragments
	// biome-ignore lint/suspicious/noExplicitAny: postgres.js helper signature
	unsafe(value: string): any;
	// Helper for JSON values
	// biome-ignore lint/suspicious/noExplicitAny: postgres.js helper signature
	json(value: unknown): any;
};

// ─── Config ──────────────────────────────────────────────────────────

export type PostgresStoreConfig = {
	readonly sql: Sql;
	readonly tablePrefix?: string | undefined; // default: "agentgate"
	readonly autoMigrate?: boolean | undefined; // default: true — set false to manage migrations externally
};

// ─── Row types ───────────────────────────────────────────────────────

type ChallengeRow = {
	challenge_id: string;
	request_id: string;
	client_agent_id: string;
	resource_id: string;
	tier_id: string;
	amount: string;
	amount_raw: string; // NUMERIC comes back as string
	asset: string;
	chain_id: number;
	destination: string;
	state: string;
	expires_at: Date;
	created_at: Date;
	paid_at?: Date;
	tx_hash?: string;
	access_grant?: object; // JSONB
	from_address?: string;
	delivered_at?: Date;
	refund_tx_hash?: string;
	refunded_at?: Date;
	refund_error?: string;
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
		tierId: row.tier_id,
		amount: row.amount,
		amountRaw: BigInt(row.amount_raw),
		asset: row.asset as "USDC",
		chainId: row.chain_id,
		destination: row.destination as `0x${string}`,
		state: row.state as ChallengeState,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
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
	private readonly ready: Promise<void>;

	constructor(config: PostgresStoreConfig) {
		this.sql = config.sql;
		this.tablePrefix = config.tablePrefix ?? "agentgate";
		this.tableName = `${this.tablePrefix}_challenges`;
		this.ready = config.autoMigrate !== false ? this.createSchema() : Promise.resolve();
	}

	/**
	 * Helper to create the challenges table and indexes.
	 * Call this once during setup/migration.
	 */
	async createSchema(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS ${this.sql(this.tableName)} (
				challenge_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL,
				client_agent_id TEXT NOT NULL,
				resource_id TEXT NOT NULL,
				tier_id TEXT NOT NULL,
				amount TEXT NOT NULL,
				amount_raw NUMERIC NOT NULL,
				asset TEXT NOT NULL,
				chain_id INTEGER NOT NULL,
				destination TEXT NOT NULL,
				state TEXT NOT NULL,
				expires_at TIMESTAMPTZ NOT NULL,
				created_at TIMESTAMPTZ NOT NULL,
				paid_at TIMESTAMPTZ,
				tx_hash TEXT,
				access_grant JSONB,
				from_address TEXT,
				delivered_at TIMESTAMPTZ,
				refund_tx_hash TEXT,
				refunded_at TIMESTAMPTZ,
				refund_error TEXT
			)
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_request_id_idx`)}
			ON ${this.sql(this.tableName)} (request_id)
		`;

		await this.sql`
			CREATE INDEX IF NOT EXISTS ${this.sql(`${this.tableName}_state_idx`)}
			ON ${this.sql(this.tableName)} (state)
		`;
	}

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		await this.ready;
		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE challenge_id = ${challengeId}
		`;

		if (rows.length === 0) return null;
		return rowToChallengeRecord(rows[0]!);
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		await this.ready;
		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE request_id = ${requestId}
			ORDER BY created_at DESC
			LIMIT 1
		`;

		if (rows.length === 0) return null;
		return rowToChallengeRecord(rows[0]!);
	}

	async create(record: ChallengeRecord): Promise<void> {
		await this.ready;
		// Check if already exists
		const existing = await this.sql<{ count: string }>`
			SELECT COUNT(*) as count FROM ${this.sql(this.tableName)}
			WHERE challenge_id = ${record.challengeId}
		`;

		if (Number(existing[0]!.count) > 0) {
			throw new Error(`Challenge ${record.challengeId} already exists`);
		}

		await this.sql`
			INSERT INTO ${this.sql(this.tableName)} (
				challenge_id,
				request_id,
				client_agent_id,
				resource_id,
				tier_id,
				amount,
				amount_raw,
				asset,
				chain_id,
				destination,
				state,
				expires_at,
				created_at,
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
				${record.tierId},
				${record.amount},
				${record.amountRaw.toString()},
				${record.asset},
				${record.chainId},
				${record.destination},
				${record.state},
				${record.expiresAt},
				${record.createdAt},
				${record.paidAt ?? null},
				${record.txHash ?? null},
				${record.accessGrant ? this.sql.json(record.accessGrant) : null},
				${record.fromAddress ?? null},
				${record.deliveredAt ?? null},
				${record.refundTxHash ?? null},
				${record.refundedAt ?? null},
				${record.refundError ?? null}
			)
		`;
	}

	async transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
	): Promise<boolean> {
		await this.ready;
		// Build SET clause parts
		const setParts: string[] = [`state = '${toState}'`];

		if (updates?.txHash) {
			setParts.push(`tx_hash = '${updates.txHash}'`);
		}
		if (updates?.paidAt) {
			setParts.push(`paid_at = '${updates.paidAt.toISOString()}'`);
		}
		if (updates?.accessGrant) {
			setParts.push(`access_grant = '${JSON.stringify(updates.accessGrant)}'::jsonb`);
		}
		if (updates?.fromAddress) {
			setParts.push(`from_address = '${updates.fromAddress}'`);
		}
		if (updates?.deliveredAt) {
			setParts.push(`delivered_at = '${updates.deliveredAt.toISOString()}'`);
		}
		if (updates?.refundTxHash) {
			setParts.push(`refund_tx_hash = '${updates.refundTxHash}'`);
		}
		if (updates?.refundedAt) {
			setParts.push(`refunded_at = '${updates.refundedAt.toISOString()}'`);
		}
		if (updates?.refundError) {
			// Escape single quotes in error message
			const escapedError = updates.refundError.replace(/'/g, "''");
			setParts.push(`refund_error = '${escapedError}'`);
		}

		const result = await this.sql`
			UPDATE ${this.sql(this.tableName)}
			SET ${this.sql.unsafe(setParts.join(", "))}
			WHERE challenge_id = ${challengeId} AND state = ${fromState}
		`;

		// postgres.js result has .count property for affected rows
		return (result as unknown as { count: number }).count > 0;
	}

	async findPendingForRefund(minAgeMs: number): Promise<ChallengeRecord[]> {
		await this.ready;
		const minAgeSec = Math.floor(minAgeMs / 1000);

		const rows = await this.sql<ChallengeRow>`
			SELECT * FROM ${this.sql(this.tableName)}
			WHERE state = 'PAID'
			  AND paid_at <= NOW() - INTERVAL '${this.sql.unsafe(`${minAgeSec} seconds`)}'
			  AND from_address IS NOT NULL
			ORDER BY paid_at ASC
		`;

		return rows.map(rowToChallengeRecord);
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
		this.tablePrefix = config.tablePrefix ?? "agentgate";
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
