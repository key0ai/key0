/**
 * Shared distributed lock helpers for serialising all gas wallet transactions.
 *
 * Used by both:
 *   • settlePayment  (payment settlement via EIP-3009)
 *   • processRefunds (refund cron via sendUsdc)
 *
 * When a Redis client is provided, a distributed lock (SET NX + Lua release)
 * ensures only one gas wallet transaction is in-flight across all processes.
 *
 * When no Redis is available, an in-process promise queue serialises calls
 * within the current Node process (single-instance only).
 */

import type { IRedisLockClient } from "../types/config.js";
import { Key0Error } from "../types/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 120_000; // 120 s — must exceed settleViaGasWallet timeout (90 s) to prevent nonce conflicts
const LOCK_POLL_MS = 200; // retry interval while waiting for lock

// Lua script: delete the key only if its value matches our token (atomic)
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// ---------------------------------------------------------------------------
// Redis distributed lock
// ---------------------------------------------------------------------------

async function acquireRedisLock(
	redis: IRedisLockClient,
	key: string,
	token: string,
	maxWaitMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const ok = await redis.set(key, token, "NX", "PX", LOCK_TTL_MS);
		if (ok === "OK") return;
		await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
	}
	throw new Key0Error("INTERNAL_ERROR", "Failed to acquire gas wallet lock", 503);
}

async function releaseRedisLock(
	redis: IRedisLockClient,
	key: string,
	token: string,
): Promise<void> {
	await redis.eval(RELEASE_LUA, 1, key, token);
}

// ---------------------------------------------------------------------------
// In-process fallback queue (single-instance only)
// ---------------------------------------------------------------------------

/**
 * Per-lock-key promise chains that serialise gas wallet operations within one
 * Node process. Each lock key (gas wallet address) has its own queue, allowing
 * different wallets to operate in parallel while serialising operations for
 * the same wallet. Does NOT protect across multiple instances — set `redis`
 * for multi-instance deployments.
 */
const gasWalletQueues = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a lock key for a given gas wallet address.
 * All callers that share the same gas wallet (settlement, refund, etc.)
 * MUST use the same lock key so they are properly serialised.
 */
export function gasWalletLockKey(gasWalletAddress: string): string {
	return `key0:gas-wallet-lock:${gasWalletAddress.toLowerCase()}`;
}

/**
 * Execute `fn` while holding the gas wallet lock.
 *
 * @param fn           The async function to execute (e.g. settleViaGasWallet, sendUsdc).
 * @param redis        Optional Redis client for distributed locking.
 * @param lockKey      The lock key (use {@link gasWalletLockKey}).
 *
 * When `redis` is provided, uses a distributed SET NX lock so concurrent calls
 * across multiple processes/instances are serialised.
 *
 * When `redis` is absent, falls back to an in-process promise queue (safe for
 * single-instance deployments only).
 */
export async function withGasWalletLock<T>(
	fn: () => Promise<T>,
	redis: IRedisLockClient | undefined,
	lockKey: string,
): Promise<T> {
	if (redis) {
		const lockToken = crypto.randomUUID();
		await acquireRedisLock(redis, lockKey, lockToken);
		try {
			return await fn();
		} finally {
			try {
				await releaseRedisLock(redis, lockKey, lockToken);
			} catch (releaseErr) {
				console.warn(
					`[Key0] Failed to release gas wallet lock ${lockKey} — will expire via TTL:`,
					releaseErr,
				);
			}
		}
	}

	// In-process fallback — single instance only
	// Use per-key queue to allow parallel operations for different gas wallets
	const queue = gasWalletQueues.get(lockKey) ?? Promise.resolve();
	const result = queue.then(() => fn());
	const queuedPromise = result.catch(() => {});
	gasWalletQueues.set(lockKey, queuedPromise);
	// Clean up completed queues to prevent memory leak
	queuedPromise.finally(() => {
		if (gasWalletQueues.get(lockKey) === queuedPromise) {
			gasWalletQueues.delete(lockKey);
		}
	});
	return result;
}
