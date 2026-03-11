import type {
	ChallengeRecord,
	ChallengeState,
	ChallengeTransitionUpdates,
	IChallengeStore,
	ISeenTxStore,
	TransitionMeta,
} from "../types/index.js";

/**
 * Minimal in-process store for use in tests only.
 * No cleanup timer, no size guard, no retention config.
 */
export class TestChallengeStore implements IChallengeStore {
	private readonly challenges = new Map<string, ChallengeRecord>();
	private readonly requestIndex = new Map<string, string>(); // requestId → challengeId

	async get(challengeId: string): Promise<ChallengeRecord | null> {
		return this.challenges.get(challengeId) ?? null;
	}

	async findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null> {
		const challengeId = this.requestIndex.get(requestId);
		if (!challengeId) return null;
		return this.challenges.get(challengeId) ?? null;
	}

	async create(record: ChallengeRecord, _meta?: TransitionMeta): Promise<void> {
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
		_meta?: TransitionMeta,
	): Promise<boolean> {
		const record = this.challenges.get(challengeId);
		if (!record || record.state !== fromState) return false;
		// Single-threaded JS — inherently atomic
		this.challenges.set(challengeId, { ...record, state: toState, updatedAt: new Date(), ...updates });
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
}

/**
 * Minimal in-process seen-tx store for use in tests only.
 */
export class TestSeenTxStore implements ISeenTxStore {
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
