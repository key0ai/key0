import type {
	ChallengeRecord,
	ChallengeState,
	ChallengeTransitionUpdates,
	IChallengeStore,
	ISeenTxStore,
} from "../../types";

export type InMemoryStoreConfig = {
	readonly cleanupIntervalMs?: number | undefined; // default: 300_000 (5 min)
	readonly maxEntries?: number | undefined; // default: 100_000
	readonly expiredRetentionMs?: number | undefined; // default: 3_600_000 (1 hour)
	readonly paidRetentionMs?: number | undefined; // default: 604_800_000 (7 days) — PAID/REFUNDED/REFUND_FAILED
	readonly deliveredRetentionMs?: number | undefined; // default: 43_200_000 (12 hours) — measured from deliveredAt
};

export class InMemoryChallengeStore implements IChallengeStore {
	private readonly challenges = new Map<string, ChallengeRecord>();
	private readonly requestIndex = new Map<string, string>(); // requestId → challengeId
	private readonly maxEntries: number;
	private readonly expiredRetentionMs: number;
	private readonly paidRetentionMs: number;
	private readonly deliveredRetentionMs: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config?: InMemoryStoreConfig) {
		this.maxEntries = config?.maxEntries ?? 100_000;
		this.expiredRetentionMs = config?.expiredRetentionMs ?? 3_600_000;
		this.paidRetentionMs = config?.paidRetentionMs ?? 604_800_000; // 7 days
		this.deliveredRetentionMs = config?.deliveredRetentionMs ?? 43_200_000; // 12 hours

		const cleanupIntervalMs = config?.cleanupIntervalMs ?? 300_000;
		if (cleanupIntervalMs > 0) {
			this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
			// Unref so the timer doesn't prevent process exit
			if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
				this.cleanupTimer.unref();
			}
		}
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	get size(): number {
		return this.challenges.size;
	}

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		return this.challenges.get(challengeId) ?? null;
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		const challengeId = this.requestIndex.get(requestId);
		if (!challengeId) return null;
		const record = this.challenges.get(challengeId);
		if (!record) return null;
		// Return regardless of state — engine decides what to do
		return record;
	}

	async create(record: ChallengeRecord): Promise<void> {
		if (this.challenges.size >= this.maxEntries) {
			throw new Error(`Store capacity exceeded (${this.maxEntries} entries). Try again later.`);
		}
		if (this.challenges.has(record.challengeId)) {
			throw new Error(`Challenge ${record.challengeId} already exists`);
		}
		this.challenges.set(record.challengeId, record);
		this.requestIndex.set(record.requestId, record.challengeId);
	}

	async transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
	): Promise<boolean> {
		const record = this.challenges.get(challengeId);
		if (!record || record.state !== fromState) return false;

		// In-memory is single-threaded in JS — this is inherently atomic
		this.challenges.set(challengeId, {
			...record,
			state: toState,
			...updates,
		});
		return true;
	}

	async findPendingForRefund(minAgeMs: number): Promise<ChallengeRecord[]> {
		const cutoff = Date.now() - minAgeMs;
		const results: ChallengeRecord[] = [];
		for (const record of this.challenges.values()) {
			if (
				record.state === "PAID" &&
				record.fromAddress &&
				record.paidAt &&
				record.paidAt.getTime() <= cutoff
			) {
				results.push(record);
			}
		}
		return results;
	}

	/** Remove stale challenge records based on retention policy. */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [id, record] of this.challenges) {
			const age = now - record.createdAt.getTime();

			if (
				(record.state === "EXPIRED" || record.state === "CANCELLED") &&
				age > this.expiredRetentionMs
			) {
				this.challenges.delete(id);
				this.requestIndex.delete(record.requestId);
				removed++;
			} else if (record.state === "DELIVERED") {
				// Measure from deliveredAt so the 12-hour window starts when delivery was confirmed
				const deliveredAge = record.deliveredAt ? now - record.deliveredAt.getTime() : age;
				if (deliveredAge > this.deliveredRetentionMs) {
					this.challenges.delete(id);
					this.requestIndex.delete(record.requestId);
					removed++;
				}
			} else if (
				(record.state === "PAID" ||
					record.state === "REFUND_PENDING" ||
					record.state === "REFUNDED" ||
					record.state === "REFUND_FAILED") &&
				age > this.paidRetentionMs
			) {
				this.challenges.delete(id);
				this.requestIndex.delete(record.requestId);
				removed++;
			}
		}

		return removed;
	}
}

export class InMemorySeenTxStore implements ISeenTxStore {
	private readonly seen = new Map<`0x${string}`, string>(); // txHash → challengeId

	async get(txHash: `0x${string}`): Promise<string | null> {
		return this.seen.get(txHash) ?? null;
	}

	async markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean> {
		if (this.seen.has(txHash)) return false;
		this.seen.set(txHash, challengeId);
		return true;
	}
}
