/**
 * Storage-agnostic test helpers that work with both Redis and Postgres.
 * Uses the store interface instead of direct Redis access.
 */

import type { IChallengeStore } from "@riklr/agentgate";
import { AGENTGATE_URL } from "../fixtures/constants.ts";
import {
	connectRedis,
	readChallengeRecord as redisReadRecord,
	readChallengeState as redisReadState,
	writePaidChallengeRecord as redisWritePaidRecord,
} from "./redis-client.ts";

let _store: IChallengeStore | null = null;
let storageBackend: "redis" | "postgres" = "redis";
let baseUrl: string = AGENTGATE_URL;
let redisUrl: string | null = null;

/**
 * Configure which storage backend is active for tests.
 * Call this in global-setup after detecting E2E_STORAGE_BACKEND.
 */
export function setStorageBackend(
	backend: "redis" | "postgres",
	challengeStore?: IChallengeStore,
	agentgateUrl?: string,
	customRedisUrl?: string | null,
) {
	storageBackend = backend;
	if (backend === "postgres" && challengeStore) {
		_store = challengeStore;
	}
	// If agentgateUrl is explicitly provided (even as empty string), reset baseUrl
	if (agentgateUrl !== undefined) {
		baseUrl = agentgateUrl || AGENTGATE_URL;
	}
	// If customRedisUrl is explicitly provided (including null), reset redisUrl
	if (customRedisUrl !== undefined) {
		redisUrl = customRedisUrl ?? null;
	}
}

/** Read challenge state - works with both Redis and Postgres */
export async function readChallengeState(challengeId: string): Promise<string | null> {
	if (storageBackend === "postgres") {
		const res = await fetch(`${baseUrl}/test/challenge/${challengeId}`);
		if (res.status === 404) return null;
		if (!res.ok) {
			throw new Error(`Failed to read challenge: ${res.status} ${await res.text()}`);
		}
		const record = (await res.json()) as { state?: string };
		return record.state ?? null;
	}
	// Redis path
	if (redisUrl) {
		const Redis = (await import("ioredis")).default;
		const redis = new Redis(redisUrl);
		return redis.hget(`agentgate:challenge:${challengeId}`, "state");
	}
	return redisReadState(challengeId);
}

/** Read full challenge record - works with both backends */
export async function readChallengeRecord(
	challengeId: string,
): Promise<Record<string, string> | null> {
	if (storageBackend === "postgres") {
		const res = await fetch(`${baseUrl}/test/challenge/${challengeId}`);
		if (res.status === 404) return null;
		if (!res.ok) {
			throw new Error(`Failed to read challenge: ${res.status} ${await res.text()}`);
		}
		const record = (await res.json()) as any;

		// Flatten to string map for compatibility with existing tests
		return {
			challengeId: record.challengeId,
			requestId: record.requestId,
			clientAgentId: record.clientAgentId,
			resourceId: record.resourceId,
			tierId: record.tierId,
			amount: record.amount,
			amountRaw: String(record.amountRaw),
			asset: record.asset,
			chainId: String(record.chainId),
			destination: record.destination,
			state: record.state,
			expiresAt: new Date(record.expiresAt).toISOString(),
			createdAt: new Date(record.createdAt).toISOString(),
			...(record.paidAt ? { paidAt: new Date(record.paidAt).toISOString() } : {}),
			...(record.txHash ? { txHash: record.txHash } : {}),
			...(record.fromAddress ? { fromAddress: record.fromAddress } : {}),
			...(record.deliveredAt ? { deliveredAt: new Date(record.deliveredAt).toISOString() } : {}),
			...(record.accessGrant ? { accessGrant: JSON.stringify(record.accessGrant) } : {}),
			...(record.refundTxHash ? { refundTxHash: record.refundTxHash } : {}),
			...(record.refundedAt ? { refundedAt: new Date(record.refundedAt).toISOString() } : {}),
			...(record.refundError ? { refundError: record.refundError } : {}),
		};
	}

	// Redis path
	if (redisUrl) {
		const Redis = (await import("ioredis")).default;
		const redis = new Redis(redisUrl);
		const flat = await redis.hgetall(`agentgate:challenge:${challengeId}`);
		if (!flat["challengeId"]) return null;
		return flat;
	}
	return redisReadRecord(challengeId);
}

/** Write PAID record - works with both backends */
export async function writePaidChallengeRecord(record: {
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
}): Promise<void> {
	if (storageBackend === "postgres") {
		const res = await fetch(`${baseUrl}/test/write-paid-challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...record,
				amountRaw: record.amountRaw.toString(),
				paidAt: record.paidAt.toISOString(),
			}),
		});
		if (!res.ok) {
			throw new Error(`Failed to write PAID challenge: ${res.status} ${await res.text()}`);
		}
		return;
	}

	// Redis path
	if (redisUrl) {
		const Redis = (await import("ioredis")).default;
		const redis = new Redis(redisUrl);
		return redisWritePaidRecord(record, redis);
	}
	const redis = connectRedis();
	return redisWritePaidRecord(record, redis);
}

/**
 * Transition a challenge from one state to another.
 * Works with both Redis and Postgres backends.
 */
export async function transitionChallengeState(
	challengeId: string,
	fromState: string,
	toState: string,
): Promise<boolean> {
	if (storageBackend === "postgres") {
		// Use HTTP endpoint for Postgres
		const res = await fetch(`${baseUrl}/test/transition-challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId, fromState, toState }),
		});
		if (res.ok) {
			return true;
		}
		if (res.status === 409) {
			return false; // State mismatch
		}
		throw new Error(`Failed to transition challenge: ${res.status} ${await res.text()}`);
	}

	// For Redis, use direct Redis operations
	const redis = connectRedis();
	const challengeKey = `agentgate:challenge:${challengeId}`;

	// Atomic transition using Lua script (similar to store.transition)
	const script = `
		if redis.call('hget', KEYS[1], 'state') == ARGV[1] then
			redis.call('hset', KEYS[1], 'state', ARGV[2])
			return 1
		end
		return 0
	`;
	const result = await redis.eval(script, 1, challengeKey, fromState, toState);
	return result === 1;
}

/**
 * Simulate TTL expiry by expiring a requestId index.
 * For Postgres: transitions the challenge to EXPIRED (so findActiveByRequestId returns null).
 * For Redis: deletes the requestId index key.
 */
export async function expireRequestIdIndex(requestId: string): Promise<boolean> {
	if (storageBackend === "postgres") {
		// Use HTTP endpoint for Postgres
		const res = await fetch(`${baseUrl}/test/expire-request-id`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId }),
		});
		if (res.ok) {
			return true;
		}
		if (res.status === 404) {
			return false; // No active challenge found
		}
		throw new Error(`Failed to expire requestId: ${res.status} ${await res.text()}`);
	}

	// For Redis, delete the requestId index key
	const redis = connectRedis();
	const deleted = await redis.del(`agentgate:request:${requestId}`);
	return deleted === 1;
}

/**
 * Get the current storage backend.
 */
export function getStorageBackend(): "redis" | "postgres" {
	return storageBackend;
}
