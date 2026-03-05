/**
 * Redis client helpers for e2e test assertions.
 * Reads and writes challenge state directly for fast assertions.
 */

import Redis from "ioredis";

export const REDIS_URL = "redis://localhost:6380";
const KEY_PREFIX = "agentgate";

let client: Redis | null = null;

export function connectRedis(url = REDIS_URL): Redis {
	if (client) return client;
	client = new Redis(url, { lazyConnect: true });
	return client;
}

export async function disconnectRedis(): Promise<void> {
	if (client) {
		await client.quit();
		client = null;
	}
}

/** Read the state field of a challenge record from Redis. */
export async function readChallengeState(
	challengeId: string,
	redis = connectRedis(),
): Promise<string | null> {
	return redis.hget(`${KEY_PREFIX}:challenge:${challengeId}`, "state");
}

/** Read the full challenge record from Redis. */
export async function readChallengeRecord(
	challengeId: string,
	redis = connectRedis(),
): Promise<Record<string, string> | null> {
	const flat = await redis.hgetall(`${KEY_PREFIX}:challenge:${challengeId}`);
	if (!flat["challengeId"]) return null;
	return flat;
}

/**
 * Write a PAID challenge record directly to Redis.
 * Used by refund tests to set up test state without going through the full payment flow.
 */
export async function writePaidChallengeRecord(
	record: {
		challengeId: string;
		requestId: string;
		clientAgentId: string;
		resourceId: string;
		tierId: string;
		amount: string;
		amountRaw: bigint;
		destination: `0x${string}`;
		fromAddress: `0x${string}`;
		txHash: `0x${string}`;
		paidAt: Date;
	},
	redis = connectRedis(),
): Promise<void> {
	const key = `${KEY_PREFIX}:challenge:${record.challengeId}`;
	const paidSetKey = `${KEY_PREFIX}:paid`;

	const flat: Record<string, string> = {
		challengeId: record.challengeId,
		requestId: record.requestId,
		clientAgentId: record.clientAgentId,
		resourceId: record.resourceId,
		tierId: record.tierId,
		amount: record.amount,
		amountRaw: record.amountRaw.toString(),
		asset: "USDC",
		chainId: "84532",
		destination: record.destination,
		state: "PAID",
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		paidAt: record.paidAt.toISOString(),
		txHash: record.txHash,
		fromAddress: record.fromAddress,
	};

	const pipeline = redis.pipeline();
	pipeline.hset(key, flat);
	pipeline.expire(key, 604_800); // 7 days
	// Add to paid sorted set (score = paidAt epoch ms, for refund cron eligibility)
	pipeline.zadd(paidSetKey, record.paidAt.getTime(), record.challengeId);
	await pipeline.exec();
}
