import type { ChallengeRecord, ChallengeState } from "./challenge.js";

/** Who or what triggered a state transition. */
export type AuditActor = "engine" | "cron" | "admin" | "system";

/** Metadata passed alongside create/transition to enrich audit entries. */
export type TransitionMeta = {
	readonly actor: AuditActor;
	readonly reason?: string;
};

/** A single audit log entry for a challenge state transition (write-only). */
export type AuditEntry = {
	readonly id?: string | number; // store-assigned (BIGSERIAL for PG, index for Redis)
	readonly challengeId: string;
	readonly requestId: string; // survives challenge cleanup
	readonly clientAgentId?: string; // who initiated the flow
	readonly fromState: ChallengeState | null; // null for initial creation
	readonly toState: ChallengeState;
	readonly actor: AuditActor; // who/what triggered the transition
	readonly reason?: string; // human-readable reason
	readonly updates: Record<string, unknown> | null; // snapshot of fields changed
	readonly createdAt: Date; // when the transition occurred
};

/** Fields that may be written alongside a state transition. */
export type ChallengeTransitionUpdates = Partial<
	Pick<
		ChallengeRecord,
		| "txHash"
		| "paidAt"
		| "accessGrant"
		| "fromAddress"
		| "deliveredAt"
		| "refundTxHash"
		| "refundedAt"
		| "refundError"
	>
>;

export interface IChallengeStore {
	/**
	 * Get a challenge by its challengeId.
	 * Returns null if not found.
	 */
	get(challengeId: string): Promise<ChallengeRecord | null>;

	/**
	 * Find an active (non-expired, state=PENDING) challenge by requestId.
	 * Used for idempotency — same requestId returns the same challenge.
	 * Returns null if no active challenge exists for that requestId.
	 */
	findActiveByRequestId(requestId: string): Promise<ChallengeRecord | null>;

	/**
	 * Store a new challenge record.
	 * Must reject if challengeId already exists (no overwrites).
	 */
	create(record: ChallengeRecord, meta?: TransitionMeta): Promise<void>;

	/**
	 * Atomically update a challenge's state and optional fields.
	 * Must reject if the current state does not match `fromState` (optimistic concurrency).
	 * Returns true if updated, false if state mismatch (someone else transitioned it).
	 */
	transition(
		challengeId: string,
		fromState: ChallengeState,
		toState: ChallengeState,
		updates?: ChallengeTransitionUpdates,
		meta?: TransitionMeta,
	): Promise<boolean>;

	/**
	 * Return PAID records where paidAt + minAgeMs <= now, fromAddress is set,
	 * and no accessGrant has been persisted yet.
	 * Used by the refund cron to find undelivered payments eligible for refund.
	 */
	findPendingForRefund(minAgeMs: number): Promise<ChallengeRecord[]>;
}

export interface ISeenTxStore {
	/**
	 * Check if a txHash has already been used for any challenge.
	 * Returns the challengeId it was used for, or null.
	 */
	get(txHash: `0x${string}`): Promise<string | null>;

	/**
	 * Mark a txHash as used for a given challengeId.
	 * Must reject if txHash already exists (double-spend guard).
	 * Returns true if stored, false if already existed.
	 */
	markUsed(txHash: `0x${string}`, challengeId: string): Promise<boolean>;
}

/**
 * Write-only audit store for challenge state transitions.
 * Implementations MUST NOT expose update or delete operations.
 * All transitions (create + state changes) are logged immutably.
 */
export interface IAuditStore {
	/** Append an audit entry. This is the only write operation. */
	append(entry: Omit<AuditEntry, "id">): Promise<void>;

	/** Read the full transition history for a challenge (ordered chronologically). */
	getHistory(challengeId: string): Promise<AuditEntry[]>;
}
