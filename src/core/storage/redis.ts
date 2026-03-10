import type Redis from "ioredis";
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

// ─── Serialization helpers ───────────────────────────────────────────

/** Flat string map for Redis HSET/HGETALL. */
type FlatHash = { [key: string]: string };

function serializeChallengeRecord(record: ChallengeRecord): FlatHash {
	const flat: FlatHash = {
		challengeId: record.challengeId,
		requestId: record.requestId,
		clientAgentId: record.clientAgentId,
		resourceId: record.resourceId,
		tierId: record.tierId,
		amount: record.amount,
		amountRaw: record.amountRaw.toString(),
		asset: record.asset,
		chainId: String(record.chainId),
		destination: record.destination,
		state: record.state,
		expiresAt: record.expiresAt.toISOString(),
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};

	if (record.paidAt) {
		flat["paidAt"] = record.paidAt.toISOString();
	}
	if (record.txHash) {
		flat["txHash"] = record.txHash;
	}
	if (record.accessGrant) {
		flat["accessGrant"] = JSON.stringify(record.accessGrant);
	}
	if (record.fromAddress) {
		flat["fromAddress"] = record.fromAddress;
	}
	if (record.deliveredAt) {
		flat["deliveredAt"] = record.deliveredAt.toISOString();
	}
	if (record.refundTxHash) {
		flat["refundTxHash"] = record.refundTxHash;
	}
	if (record.refundedAt) {
		flat["refundedAt"] = record.refundedAt.toISOString();
	}
	if (record.refundError) {
		flat["refundError"] = record.refundError;
	}

	return flat;
}

function deserializeChallengeRecord(flat: FlatHash): ChallengeRecord | null {
	const challengeId = flat["challengeId"];
	if (!challengeId) return null;

	const paidAt = flat["paidAt"];
	const txHash = flat["txHash"];
	const accessGrantJson = flat["accessGrant"];

	const fromAddress = flat["fromAddress"];
	const deliveredAt = flat["deliveredAt"];
	const refundTxHash = flat["refundTxHash"];
	const refundedAt = flat["refundedAt"];
	const refundError = flat["refundError"];
	const updatedAt = flat["updatedAt"];

	const record: ChallengeRecord = {
		challengeId,
		requestId: flat["requestId"]!,
		clientAgentId: flat["clientAgentId"]!,
		resourceId: flat["resourceId"]!,
		tierId: flat["tierId"]!,
		amount: flat["amount"]!,
		amountRaw: BigInt(flat["amountRaw"]!),
		asset: flat["asset"] as "USDC",
		chainId: Number(flat["chainId"]),
		destination: flat["destination"] as `0x${string}`,
		state: flat["state"] as ChallengeState,
		expiresAt: new Date(flat["expiresAt"]!),
		createdAt: new Date(flat["createdAt"]!),
		updatedAt: new Date(updatedAt ?? flat["createdAt"]!), // fallback for pre-existing records
		...(paidAt ? { paidAt: new Date(paidAt) } : {}),
		...(txHash ? { txHash: txHash as `0x${string}` } : {}),
		...(accessGrantJson ? { accessGrant: JSON.parse(accessGrantJson) as AccessGrant } : {}),
		...(fromAddress ? { fromAddress: fromAddress as `0x${string}` } : {}),
		...(deliveredAt ? { deliveredAt: new Date(deliveredAt) } : {}),
		...(refundTxHash ? { refundTxHash: refundTxHash as `0x${string}` } : {}),
		...(refundedAt ? { refundedAt: new Date(refundedAt) } : {}),
		...(refundError ? { refundError } : {}),
	};

	return record;
}

// ─── Lua script for atomic state transition ──────────────────────────
//
// KEYS[1] = challenge hash key
// KEYS[2] = paid sorted set key
// KEYS[3] = audit list key (append-only)
// ARGV[1] = fromState
// ARGV[2] = toState
// ARGV[3] = challengeId (used for zadd/zrem)
// ARGV[4] = paidAt epoch ms as string, or "" if not a PAID transition
// ARGV[5] = now ISO string (for updatedAt + audit timestamp)
// ARGV[6] = actor (e.g. "engine", "cron", "admin", "system")
// ARGV[7] = reason (or "" for none)
// ARGV[8..] = alternating field/value pairs to write alongside state

const TRANSITION_LUA = `
local current = redis.call('HGET', KEYS[1], 'state')
if current ~= ARGV[1] then
  return 0
end
local fromState = ARGV[1]
local toState = ARGV[2]
local challengeId = ARGV[3]
local score = ARGV[4]
local now = ARGV[5]
local actor = ARGV[6]
local reason = ARGV[7]
redis.call('HSET', KEYS[1], 'state', toState, 'updatedAt', now)
-- Collect field/value updates
local updates = {}
local hasUpdates = false
for i = 8, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
  updates[ARGV[i]] = ARGV[i+1]
  hasUpdates = true
end
-- Read requestId and clientAgentId from the challenge hash
local requestId = redis.call('HGET', KEYS[1], 'requestId') or ''
local clientAgentId = redis.call('HGET', KEYS[1], 'clientAgentId')
-- Audit: append transition to the audit list (write-only)
local entry = {
  challengeId = challengeId,
  requestId = requestId,
  fromState = fromState,
  toState = toState,
  actor = actor,
  createdAt = now
}
if clientAgentId then
  entry.clientAgentId = clientAgentId
end
if reason ~= '' then
  entry.reason = reason
end
if hasUpdates then
  entry.updates = updates
end
redis.call('RPUSH', KEYS[3], cjson.encode(entry))
if toState == 'PAID' and score ~= '' then
  redis.call('ZADD', KEYS[2], score, challengeId)
elseif fromState == 'PAID' then
  redis.call('ZREM', KEYS[2], challengeId)
end
return 1
`;

// ─── Config ──────────────────────────────────────────────────────────

export type RedisStoreConfig = {
	readonly redis: Redis;
	readonly keyPrefix?: string | undefined; // default: "key2a"
	readonly challengeTTLSeconds?: number | undefined; // default: 900 — request index key TTL
	readonly recordTTLSeconds?: number | undefined; // default: 604_800 (7 days) — challenge hash key TTL
	readonly deliveredTTLSeconds?: number | undefined; // default: 43_200 (12 hours) — TTL reset on DELIVERED
};

// ─── RedisChallengeStore ─────────────────────────────────────────────

export class RedisChallengeStore implements IChallengeStore {
	private readonly redis: Redis;
	private readonly prefix: string;
	private readonly requestTTL: number; // seconds — request index key lifetime
	private readonly recordTTL: number; // seconds — challenge hash key lifetime (full lifecycle)
	private readonly deliveredTTL: number; // seconds — TTL reset when record reaches DELIVERED

	constructor(config: RedisStoreConfig) {
		this.redis = config.redis;
		this.prefix = config.keyPrefix ?? "key2a";
		this.requestTTL = config.challengeTTLSeconds ?? 900;
		this.recordTTL = config.recordTTLSeconds ?? 604_800; // 7 days
		this.deliveredTTL = config.deliveredTTLSeconds ?? 43_200; // 12 hours
	}

	/** Verify Redis is reachable. Call at startup to fail fast on misconfiguration. */
	async healthCheck(): Promise<void> {
		const result = await this.redis.ping();
		if (result !== "PONG") {
			throw new Error(`Redis health check failed: expected PONG, got ${result}`);
		}
	}

	private challengeKey(challengeId: string): string {
		return `${this.prefix}:challenge:${challengeId}`;
	}

	private requestKey(requestId: string): string {
		return `${this.prefix}:request:${requestId}`;
	}

	private paidSetKey(): string {
		return `${this.prefix}:paid`;
	}

	private auditKey(challengeId: string): string {
		return `${this.prefix}:audit:${challengeId}`;
	}

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		const flat = await this.redis.hgetall(this.challengeKey(challengeId));
		return deserializeChallengeRecord(flat);
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		const challengeId = await this.redis.get(this.requestKey(requestId));
		if (!challengeId) return null;
		return this.get(challengeId);
	}

	async create(record: ChallengeRecord, meta?: TransitionMeta): Promise<void> {
		const key = this.challengeKey(record.challengeId);

		// Reject if already exists
		const exists = await this.redis.exists(key);
		if (exists) {
			throw new Error(`Challenge ${record.challengeId} already exists`);
		}

		const flat = serializeChallengeRecord(record);

		// Use pipeline for atomicity
		const pipeline = this.redis.pipeline();
		pipeline.hset(key, flat);
		pipeline.expire(key, this.recordTTL);

		// Request index key only needs to live as long as the challenge itself
		const reqKey = this.requestKey(record.requestId);
		pipeline.set(reqKey, record.challengeId, "EX", this.requestTTL);

		// Audit: log creation (append-only list)
		const auditEntry: Record<string, unknown> = {
			challengeId: record.challengeId,
			requestId: record.requestId,
			clientAgentId: record.clientAgentId,
			fromState: null,
			toState: record.state,
			actor: meta?.actor ?? "engine",
			reason: meta?.reason ?? "challenge_created",
			updates: null,
			createdAt: record.createdAt.toISOString(),
		};
		pipeline.rpush(this.auditKey(record.challengeId), JSON.stringify(auditEntry));

		const results = await pipeline.exec();
		if (results) {
			for (const [err] of results) {
				if (err) throw new Error(`Redis pipeline command failed: ${err.message}`);
			}
		}
	}

	async transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
		meta?: TransitionMeta,
	): Promise<boolean> {
		const key = this.challengeKey(challengeId);
		const paidSetKey = this.paidSetKey();
		const auditListKey = this.auditKey(challengeId);

		// ARGV layout: [fromState, toState, challengeId, paidAtScore, now, actor, reason, ...field/value pairs]
		// paidAtScore is the paidAt epoch ms (for ZADD on PAID transitions), or "" otherwise.
		const score = toState === "PAID" && updates?.paidAt ? updates.paidAt.getTime().toString() : "";
		const now = new Date().toISOString();
		const argv: string[] = [fromState, toState, challengeId, score, now, meta?.actor ?? "system", meta?.reason ?? ""];

		if (updates) {
			if (updates.txHash) {
				argv.push("txHash", updates.txHash);
			}
			if (updates.paidAt) {
				argv.push("paidAt", updates.paidAt.toISOString());
			}
			if (updates.accessGrant) {
				argv.push("accessGrant", JSON.stringify(updates.accessGrant));
			}
			if (updates.fromAddress) {
				argv.push("fromAddress", updates.fromAddress);
			}
			if (updates.deliveredAt) {
				argv.push("deliveredAt", updates.deliveredAt.toISOString());
			}
			if (updates.refundTxHash) {
				argv.push("refundTxHash", updates.refundTxHash);
			}
			if (updates.refundedAt) {
				argv.push("refundedAt", updates.refundedAt.toISOString());
			}
			if (updates.refundError) {
				argv.push("refundError", updates.refundError);
			}
		}

		// KEYS[1] = challenge hash, KEYS[2] = paid sorted set, KEYS[3] = audit list
		// Sorted set maintenance (ZADD/ZREM) and audit logging are inside the Lua script — fully atomic.
		let result: unknown;
		try {
			result = await this.redis.eval(TRANSITION_LUA, 3, key, paidSetKey, auditListKey, ...argv);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Redis connection error during state transition: ${msg}`);
		}
		if (result !== 1) return false;

		// DELIVERED records no longer need the full 7-day window — shorten TTL to 12 hours.
		// This EXPIRE is intentionally outside Lua (TTL adjustment, not a correctness invariant).
		if (toState === "DELIVERED") {
			await this.redis.expire(key, this.deliveredTTL);
		}

		return true;
	}

	async findPendingForRefund(minAgeMs: number): Promise<ChallengeRecord[]> {
		const cutoff = Date.now() - minAgeMs;
		// Members with score (paidAt epoch ms) <= cutoff are old enough to refund
		const challengeIds = await this.redis.zrangebyscore(this.paidSetKey(), 0, cutoff);
		if (challengeIds.length === 0) return [];

		const records: ChallengeRecord[] = [];
		for (const challengeId of challengeIds) {
			const record = await this.get(challengeId);
			if (!record) {
				// Ghost entry — challenge hash expired but sorted set entry remains
				await this.redis.zrem(this.paidSetKey(), challengeId);
				continue;
			}
			if (record.state === "PAID" && record.fromAddress && !record.accessGrant) {
				records.push(record);
			} else if (record.state === "PAID" && !record.fromAddress) {
				console.warn(
					`[Key2a] PAID record ${challengeId} has no fromAddress — cannot auto-refund. Manual intervention required.`,
				);
			}
		}
		return records;
	}
}

// ─── RedisAuditStore ─────────────────────────────────────────────────

export class RedisAuditStore implements IAuditStore {
	private readonly redis: Redis;
	private readonly prefix: string;

	constructor(config: Pick<RedisStoreConfig, "redis" | "keyPrefix">) {
		this.redis = config.redis;
		this.prefix = config.keyPrefix ?? "key2a";
	}

	private auditKey(challengeId: string): string {
		return `${this.prefix}:audit:${challengeId}`;
	}

	async append(entry: Omit<AuditEntry, "id">): Promise<void> {
		const serialized = JSON.stringify({
			challengeId: entry.challengeId,
			requestId: entry.requestId,
			clientAgentId: entry.clientAgentId,
			fromState: entry.fromState,
			toState: entry.toState,
			actor: entry.actor,
			reason: entry.reason,
			updates: entry.updates,
			createdAt: entry.createdAt.toISOString(),
		});
		await this.redis.rpush(this.auditKey(entry.challengeId), serialized);
	}

	async getHistory(challengeId: string): Promise<AuditEntry[]> {
		const entries = await this.redis.lrange(this.auditKey(challengeId), 0, -1);
		return entries.map((raw, idx) => {
			const parsed = JSON.parse(raw);
			return {
				id: idx,
				challengeId: parsed.challengeId as string,
				requestId: parsed.requestId as string,
				...(parsed.clientAgentId ? { clientAgentId: parsed.clientAgentId as string } : {}),
				fromState: (parsed.fromState ?? null) as ChallengeState | null,
				toState: parsed.toState as ChallengeState,
				actor: (parsed.actor ?? "system") as AuditEntry["actor"],
				...(parsed.reason ? { reason: parsed.reason as string } : {}),
				updates: (parsed.updates ?? null) as Record<string, unknown> | null,
				createdAt: new Date(parsed.createdAt as string),
			};
		});
	}
}

// ─── RedisSeenTxStore ────────────────────────────────────────────────

const SEEN_TX_TTL = 604800; // 7 days in seconds

export class RedisSeenTxStore implements ISeenTxStore {
	private readonly redis: Redis;
	private readonly prefix: string;

	constructor(config: Pick<RedisStoreConfig, "redis" | "keyPrefix">) {
		this.redis = config.redis;
		this.prefix = config.keyPrefix ?? "key2a";
	}

	private seenKey(txHash: `0x${string}`): string {
		return `${this.prefix}:seentx:${txHash}`;
	}

	async get(txHash: `0x${string}`): Promise<string | null> {
		return this.redis.get(this.seenKey(txHash));
	}

	async markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean> {
		const result = await this.redis.set(this.seenKey(txHash), challengeId, "EX", SEEN_TX_TTL, "NX");
		return result === "OK";
	}
}
