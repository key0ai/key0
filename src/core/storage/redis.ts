import type Redis from "ioredis";
import type {
	AccessGrant,
	ChallengeRecord,
	ChallengeState,
	ChallengeTransitionUpdates,
	IChallengeStore,
	ISeenTxStore,
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

const TRANSITION_LUA = `
local current = redis.call('HGET', KEYS[1], 'state')
if current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
end
return 1
`;

// ─── Config ──────────────────────────────────────────────────────────

export type RedisStoreConfig = {
	readonly redis: Redis;
	readonly keyPrefix?: string | undefined; // default: "agentgate"
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
		this.prefix = config.keyPrefix ?? "agentgate";
		this.requestTTL = config.challengeTTLSeconds ?? 900;
		this.recordTTL = config.recordTTLSeconds ?? 604_800; // 7 days
		this.deliveredTTL = config.deliveredTTLSeconds ?? 43_200; // 12 hours
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

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		const flat = await this.redis.hgetall(this.challengeKey(challengeId));
		return deserializeChallengeRecord(flat);
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		const challengeId = await this.redis.get(this.requestKey(requestId));
		if (!challengeId) return null;
		return this.get(challengeId);
	}

	async create(record: ChallengeRecord): Promise<void> {
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

		await pipeline.exec();
	}

	async transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
	): Promise<boolean> {
		const key = this.challengeKey(challengeId);

		// Build Lua ARGV: [fromState, toState, ...field/value pairs]
		const argv: string[] = [fromState, toState];

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

		const result = await this.redis.eval(TRANSITION_LUA, 1, key, ...argv);
		if (result !== 1) return false;

		// Maintain agentgate:paid sorted set for efficient refund cron queries
		if (toState === "PAID" && updates?.paidAt) {
			await this.redis.zadd(this.paidSetKey(), updates.paidAt.getTime(), challengeId);
		} else if (fromState === "PAID") {
			await this.redis.zrem(this.paidSetKey(), challengeId);
		}

		// DELIVERED records no longer need the full 7-day window — shorten TTL to 12 hours
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
			if (record && record.state === "PAID" && record.fromAddress) {
				records.push(record);
			}
		}
		return records;
	}
}

// ─── RedisSeenTxStore ────────────────────────────────────────────────

const SEEN_TX_TTL = 604800; // 7 days in seconds

export class RedisSeenTxStore implements ISeenTxStore {
	private readonly redis: Redis;
	private readonly prefix: string;

	constructor(config: Pick<RedisStoreConfig, "redis" | "keyPrefix">) {
		this.redis = config.redis;
		this.prefix = config.keyPrefix ?? "agentgate";
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
