import { describe, expect, test } from "bun:test";
import type { AccessGrant, ChallengeRecord } from "../../types";
import { RedisChallengeStore, RedisSeenTxStore } from "../storage/redis.js";

// ─── Mock ioredis Redis instance ─────────────────────────────────────

function createMockRedis() {
	const store = new Map<string, string | Map<string, string>>();
	const ttls = new Map<string, number>();
	// Sorted sets: key → Map<member, score>
	const sortedSets = new Map<string, Map<string, number>>();
	// Lists: key → string[] (for audit logs)
	const lists = new Map<string, string[]>();

	type PipelineOp = () => void;

	const mock = {
		hgetall(key: string): Record<string, string> {
			const val = store.get(key);
			if (val instanceof Map) {
				return Object.fromEntries(val);
			}
			return {};
		},

		get(key: string): string | null {
			const val = store.get(key);
			if (typeof val === "string") return val;
			return null;
		},

		exists(key: string): number {
			return store.has(key) ? 1 : 0;
		},

		hset(key: string, fields: Record<string, string>): number {
			let m = store.get(key);
			if (!(m instanceof Map)) {
				m = new Map<string, string>();
				store.set(key, m);
			}
			for (const [k, v] of Object.entries(fields)) {
				m.set(k, v);
			}
			return Object.keys(fields).length;
		},

		expire(key: string, seconds: number): number {
			ttls.set(key, seconds);
			return 1;
		},

		set(...args: unknown[]): string | null {
			const key = args[0] as string;
			const value = args[1] as string;

			// Check for NX flag
			const hasNX = args.some((a) => a === "NX");
			if (hasNX && store.has(key)) {
				return null;
			}

			store.set(key, value);

			// Handle EX ttl
			const exIdx = args.indexOf("EX");
			if (exIdx !== -1) {
				ttls.set(key, args[exIdx + 1] as number);
			}

			return "OK";
		},

		rpush(key: string, value: string): number {
			const list = lists.get(key) || [];
			list.push(value);
			lists.set(key, list);
			return list.length;
		},

		lrange(key: string, start: number, stop: number): string[] {
			const list = lists.get(key) || [];
			if (stop === -1) return list.slice(start);
			return list.slice(start, stop + 1);
		},

		eval(_script: string, numKeys: number, ...args: string[]): number {
			// Simulate the Lua transition script.
			// KEYS[1]=challenge hash, KEYS[2]=paid sorted set, KEYS[3]=audit list
			// ARGV: [fromState, toState, challengeId, score, now, actor, reason, ...field/value pairs]
			const key = args[0] as string;
			const paidSetKey = args[1] as string;
			const auditKey = args[2] as string;
			const fromState = args[numKeys] as string;
			const toState = args[numKeys + 1] as string;
			const challengeId = args[numKeys + 2] as string;
			const score = args[numKeys + 3] as string;
			const now = args[numKeys + 4] as string;
			const actor = args[numKeys + 5] as string;
			const reason = args[numKeys + 6] as string;

			const hash = store.get(key);
			if (!(hash instanceof Map)) return 0;

			const current = hash.get("state");
			if (current !== fromState) return 0;

			hash.set("state", toState);
			hash.set("updatedAt", now);

			// Collect field/value updates
			const fieldUpdates: Record<string, string> = {};
			// Apply field/value pairs (start after the 7 fixed ARGV slots)
			for (let i = numKeys + 7; i < args.length; i += 2) {
				hash.set(args[i] as string, args[i + 1] as string);
				fieldUpdates[args[i] as string] = args[i + 1] as string;
			}

			// Read requestId and clientAgentId from the hash (mirrors Lua HGET)
			const requestId = hash.get("requestId") ?? "";
			const clientAgentId = hash.get("clientAgentId");

			// Audit: append to audit list (mirrors Lua RPUSH)
			const auditEntryObj: Record<string, unknown> = {
				challengeId,
				requestId,
				fromState,
				toState,
				actor,
				createdAt: now,
			};
			if (clientAgentId) auditEntryObj["clientAgentId"] = clientAgentId;
			if (reason !== "") auditEntryObj["reason"] = reason;
			if (Object.keys(fieldUpdates).length > 0) auditEntryObj["updates"] = fieldUpdates;

			mock.rpush(auditKey, JSON.stringify(auditEntryObj));

			// Simulate sorted set maintenance (mirrors the Lua ZADD/ZREM logic)
			if (toState === "PAID" && score !== "") {
				mock.zadd(paidSetKey, Number(score), challengeId);
			} else if (fromState === "PAID") {
				mock.zrem(paidSetKey, challengeId);
			}

			return 1;
		},

		pipeline() {
			const ops: PipelineOp[] = [];
			const pipe = {
				hset(key: string, fields: Record<string, string>) {
					ops.push(() => mock.hset(key, fields));
					return pipe;
				},
				expire(key: string, seconds: number) {
					ops.push(() => mock.expire(key, seconds));
					return pipe;
				},
				set(...setArgs: unknown[]) {
					ops.push(() => (mock.set as (...a: unknown[]) => unknown)(...setArgs));
					return pipe;
				},
				rpush(key: string, value: string) {
					ops.push(() => mock.rpush(key, value));
					return pipe;
				},
				async exec() {
					for (const op of ops) op();
					return ops.map(() => [null, "OK"]);
				},
			};
			return pipe;
		},

		zadd(key: string, score: number, member: string): number {
			let zset = sortedSets.get(key);
			if (!zset) {
				zset = new Map();
				sortedSets.set(key, zset);
			}
			const isNew = !zset.has(member);
			zset.set(member, score);
			return isNew ? 1 : 0;
		},

		zrem(key: string, member: string): number {
			const zset = sortedSets.get(key);
			if (!zset) return 0;
			return zset.delete(member) ? 1 : 0;
		},

		zrangebyscore(key: string, min: number, max: number): string[] {
			const zset = sortedSets.get(key);
			if (!zset) return [];
			const results: string[] = [];
			for (const [member, score] of zset) {
				if (score >= min && score <= max) {
					results.push(member);
				}
			}
			return results;
		},

		// Expose internals for test assertions
		_store: store,
		_ttls: ttls,
		_sortedSets: sortedSets,
		_lists: lists,
	};

	return mock;
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

// ─── RedisChallengeStore tests ───────────────────────────────────────

describe("RedisChallengeStore", () => {
	test("get returns null for missing challenge", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const result = await store.get("nonexistent");
		expect(result).toBeNull();
	});

	test("create + get round-trips all fields", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

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
		expect(loaded!.expiresAt.toISOString()).toBe(record.expiresAt.toISOString());
		expect(loaded!.createdAt.toISOString()).toBe(record.createdAt.toISOString());
	});

	test("create + get round-trips bigint amountRaw", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord({ amountRaw: 999999999n });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.amountRaw).toBe(999999999n);
		expect(typeof loaded!.amountRaw).toBe("bigint");
	});

	test("create + get round-trips AccessGrant", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const grant = makeGrant();
		const record = makeChallengeRecord({ accessGrant: grant, state: "PAID" });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.accessGrant).toEqual(grant);
	});

	test("create + get round-trips optional paidAt and txHash", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const paidAt = new Date("2025-01-01T11:50:00.000Z");
		const txHash = `0x${"dd".repeat(32)}` as `0x${string}`;
		const record = makeChallengeRecord({ paidAt, txHash, state: "PAID" });
		await store.create(record);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.paidAt!.toISOString()).toBe(paidAt.toISOString());
		expect(loaded!.txHash).toBe(txHash);
	});

	test("create rejects duplicate challengeId", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord();
		await store.create(record);

		await expect(store.create(record)).rejects.toThrow("already exists");
	});

	test("create sets TTL on challenge and request keys", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({
			redis: redis as never,
			challengeTTLSeconds: 900, // request index key TTL
		});

		const record = makeChallengeRecord();
		await store.create(record);

		const challengeKey = `key0:challenge:${record.challengeId}`;
		const requestKey = `key0:request:${record.requestId}`;

		// Challenge hash key uses the full 7-day lifecycle TTL
		expect(redis._ttls.get(challengeKey)).toBe(604_800);
		// Request index key uses challengeTTLSeconds (idempotency window only)
		expect(redis._ttls.get(requestKey)).toBe(900);
	});

	test("findActiveByRequestId returns record", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord();
		await store.create(record);

		const found = await store.findActiveByRequestId(record.requestId);
		expect(found).not.toBeNull();
		expect(found!.challengeId).toBe(record.challengeId);
	});

	test("findActiveByRequestId returns null for missing requestId", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const found = await store.findActiveByRequestId("no-such-request");
		expect(found).toBeNull();
	});

	test("transition succeeds when state matches", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

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
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord({ state: "PENDING" });
		await store.create(record);

		const ok = await store.transition(record.challengeId, "PAID", "EXPIRED");
		expect(ok).toBe(false);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.state).toBe("PENDING"); // unchanged
	});

	test("transition passes accessGrant to Lua", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord({ state: "PAID" });
		await store.create(record);

		// Simulate the PAID → PAID transition with accessGrant
		const grant = makeGrant();
		const ok = await store.transition(record.challengeId, "PAID", "PAID", {
			accessGrant: grant,
		});
		expect(ok).toBe(true);

		const loaded = await store.get(record.challengeId);
		expect(loaded!.accessGrant).toEqual(grant);
	});

	test("create uses 7-day recordTTL for the challenge hash key", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord();
		await store.create(record);

		const key = `key0:challenge:${record.challengeId}`;
		expect(redis._ttls.get(key)).toBe(604_800); // 7 days
	});

	test("create uses challengeTTLSeconds for the request index key", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({
			redis: redis as never,
			challengeTTLSeconds: 1800,
		});

		const record = makeChallengeRecord();
		await store.create(record);

		const reqKey = `key0:request:${record.requestId}`;
		expect(redis._ttls.get(reqKey)).toBe(1800);
	});

	test("transition to DELIVERED resets TTL to 12 hours", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord({ state: "PAID" });
		await store.create(record);

		const key = `key0:challenge:${record.challengeId}`;
		expect(redis._ttls.get(key)).toBe(604_800); // 7 days at creation

		await store.transition(record.challengeId, "PAID", "DELIVERED", {
			deliveredAt: new Date(),
		});

		expect(redis._ttls.get(key)).toBe(43_200); // reset to 12 hours
	});

	test("transition to REFUNDED does not change TTL", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({ redis: redis as never });

		const record = makeChallengeRecord({ state: "REFUND_PENDING" });
		await store.create(record);

		const key = `key0:challenge:${record.challengeId}`;
		const ttlBefore = redis._ttls.get(key);

		await store.transition(record.challengeId, "REFUND_PENDING", "REFUNDED", {
			refundTxHash: `0x${"aa".repeat(32)}` as `0x${string}`,
			refundedAt: new Date(),
		});

		expect(redis._ttls.get(key)).toBe(ttlBefore); // unchanged
	});

	test("uses custom keyPrefix", async () => {
		const redis = createMockRedis();
		const store = new RedisChallengeStore({
			redis: redis as never,
			keyPrefix: "myapp",
		});

		const record = makeChallengeRecord();
		await store.create(record);

		const key = `myapp:challenge:${record.challengeId}`;
		expect(redis._store.has(key)).toBe(true);
	});
});

// ─── RedisSeenTxStore tests ──────────────────────────────────────────

describe("RedisSeenTxStore", () => {
	const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;

	test("get returns null for unseen txHash", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({ redis: redis as never });

		const result = await store.get(TX_HASH);
		expect(result).toBeNull();
	});

	test("markUsed returns true on first call", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({ redis: redis as never });

		const result = await store.markUsed(TX_HASH, "challenge-1");
		expect(result).toBe(true);
	});

	test("markUsed returns false on duplicate", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({ redis: redis as never });

		await store.markUsed(TX_HASH, "challenge-1");
		const result = await store.markUsed(TX_HASH, "challenge-2");
		expect(result).toBe(false);
	});

	test("get returns challengeId after markUsed", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({ redis: redis as never });

		await store.markUsed(TX_HASH, "challenge-1");
		const result = await store.get(TX_HASH);
		expect(result).toBe("challenge-1");
	});

	test("markUsed sets 7-day TTL", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({ redis: redis as never });

		await store.markUsed(TX_HASH, "challenge-1");
		const key = `key0:seentx:${TX_HASH}`;
		expect(redis._ttls.get(key)).toBe(604800);
	});

	test("uses custom keyPrefix", async () => {
		const redis = createMockRedis();
		const store = new RedisSeenTxStore({
			redis: redis as never,
			keyPrefix: "custom",
		});

		await store.markUsed(TX_HASH, "challenge-1");
		const key = `custom:seentx:${TX_HASH}`;
		expect(redis._store.has(key)).toBe(true);
	});
});
