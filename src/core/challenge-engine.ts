import { parseDollarToUsdcMicro } from "../adapter/index.js";
import type {
	AccessGrant,
	AccessRequest,
	ChallengeRecord,
	IChallengeStore,
	IPaymentAdapter,
	ISeenTxStore,
	NetworkConfig,
	PaymentProof,
	Plan,
	SellerConfig,
	X402Challenge,
	X402PaymentRequiredResponse,
	X402SettleResponse,
} from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, Key0Error } from "../types/index.js";

import { validateSellerConfig } from "./config-validation.js";
import { validateNonEmpty, validateTxHash, validateUUID } from "./validation.js";

export type ChallengeEngineConfig = {
	readonly config: SellerConfig;
	readonly store: IChallengeStore;
	readonly seenTxStore: ISeenTxStore;
	readonly adapter: IPaymentAdapter;
	readonly clock?: (() => number) | undefined; // injectable, defaults to Date.now
};

export class ChallengeEngine {
	private readonly config: SellerConfig;
	private readonly store: IChallengeStore;
	private readonly seenTxStore: ISeenTxStore;
	private readonly adapter: IPaymentAdapter;
	private readonly clock: () => number;
	private readonly networkConfig: NetworkConfig;
	private readonly challengeTTL: number;

	constructor(opts: ChallengeEngineConfig) {
		validateSellerConfig(opts.config);
		this.config = opts.config;
		this.store = opts.store;
		this.seenTxStore = opts.seenTxStore;
		this.adapter = opts.adapter;
		this.clock = opts.clock ?? Date.now;
		this.networkConfig = CHAIN_CONFIGS[this.config.network];
		this.challengeTTL = (this.config.challengeTTLSeconds ?? 900) * 1000;
	}

	private now(): number {
		return this.clock();
	}

	/**
	 * Call fetchResourceCredentials with a timeout and configurable retries with exponential backoff.
	 * On timeout, throws TOKEN_ISSUE_TIMEOUT. On final failure, re-throws the original error.
	 */
	private async issueTokenWithRetry(
		params: import("../types/config.js").IssueTokenParams,
	): Promise<import("../types/config.js").TokenIssuanceResult> {
		if (!this.config.fetchResourceCredentials) {
			throw new Key0Error(
				"INTERNAL_ERROR",
				"fetchResourceCredentials is required for subscription plans but was not provided",
				500,
			);
		}

		const fetchResourceCredentials = this.config.fetchResourceCredentials;
		const timeoutMs = this.config.tokenIssueTimeoutMs ?? 15_000;
		const maxRetries = this.config.tokenIssueRetries ?? 2;

		const callWithTimeout = () => {
			let timer: ReturnType<typeof setTimeout>;
			return Promise.race([
				fetchResourceCredentials(params).finally(() => clearTimeout(timer)),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Key0Error("TOKEN_ISSUE_TIMEOUT", "Token issuance timed out", 504)),
						timeoutMs,
					);
				}),
			]);
		};

		let lastError: unknown;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await callWithTimeout();
			} catch (err) {
				lastError = err;
				// Timeout means the original call may still be in-flight — retrying
				// would risk duplicate token issuance. Break immediately.
				if (err instanceof Key0Error && err.code === "TOKEN_ISSUE_TIMEOUT") {
					throw err;
				}
				if (attempt < maxRetries) {
					const delay = 500 * 2 ** attempt; // 500ms, 1s, 2s...
					await new Promise((r) => setTimeout(r, delay));
				}
			}
		}
		throw lastError;
	}

	private findPlan(planId: string): Plan | undefined {
		return this.config.plans.find((t: Plan) => t.planId === planId);
	}

	private challengeToResponse(record: ChallengeRecord): X402Challenge {
		return {
			type: "X402Challenge",
			challengeId: record.challengeId,
			requestId: record.requestId,
			planId: record.planId,
			amount: record.amount,
			asset: "USDC",
			chainId: record.chainId,
			destination: record.destination,
			expiresAt: record.expiresAt.toISOString(),
			description: `Send ${record.amount} USDC to ${record.destination} on chain ${record.chainId}. Then replay the same POST /x402/access request with the PAYMENT-SIGNATURE header containing the signed EIP-3009 authorization for challengeId "${record.challengeId}", requestId "${record.requestId}", chainId ${record.chainId}, amount "${record.amount}", asset "USDC".`,
			resourceVerified: true,
		};
	}

	/**
	 * Build the x402 spec-compliant PaymentRequiredResponse for a challenge record.
	 * Used by the executor to populate task.status.message.metadata["x402.payment.required"].
	 * @see https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/spec.md
	 */
	buildX402PaymentRequired(record: ChallengeRecord): X402PaymentRequiredResponse {
		// x402 v2: Use CAIP-2 format for network
		const network = `eip155:${record.chainId}`;
		const resourceUrl = this.buildResourceEndpoint(record.resourceId);

		return {
			x402Version: 2,
			resource: {
				url: resourceUrl,
				method: "POST",
				description: `Access to ${record.resourceId}`,
				mimeType: "application/json",
			},
			accepts: [
				{
					scheme: "exact",
					network: network,
					asset: this.networkConfig.usdcAddress,
					amount: record.amountRaw.toString(),
					payTo: record.destination,
					maxTimeoutSeconds: this.config.challengeTTLSeconds ?? 900,
					extra: {
						challengeId: record.challengeId,
						requestId: record.requestId,
						planId: record.planId,
						amount: record.amount,
						chainId: record.chainId,
						expiresAt: record.expiresAt.toISOString(),
						description: `${record.planId} plan access — ${record.amount} USDC`,
					},
				},
			],
		};
	}

	/**
	 * Build a payment receipt for a completed challenge.
	 * Used by the executor to populate task.status.message.metadata["x402.payment.receipts"].
	 */
	buildX402Receipt(record: ChallengeRecord, grant: AccessGrant): X402SettleResponse {
		const networkName = CHAIN_ID_TO_NETWORK[record.chainId] ?? `chain-${record.chainId}`;
		return {
			success: true,
			transaction: grant.txHash,
			network: networkName,
		};
	}

	/**
	 * Expose getChallenge for the executor to build x402 metadata after requestAccess.
	 */
	async getChallengeRecord(challengeId: string): Promise<ChallengeRecord | null> {
		return this.store.get(challengeId);
	}

	private buildResourceEndpoint(resourceId: string): string {
		if (this.config.resourceEndpointTemplate) {
			return this.config.resourceEndpointTemplate.replace("{resourceId}", resourceId);
		}
		return `${this.config.agentUrl}${this.config.basePath ?? "/agent"}/resources/${resourceId}`;
	}

	async requestAccess(req: AccessRequest): Promise<X402Challenge> {
		// 1. Validate input - only requestId and planId are mandatory
		validateUUID(req.requestId, "requestId");

		// Provide defaults for optional fields
		const resourceId = req.resourceId || "default";
		const clientAgentId = req.clientAgentId || "anonymous";

		// 2. Validate plan
		const tier = this.findPlan(req.planId);
		if (!tier) {
			throw new Key0Error("TIER_NOT_FOUND", `Plan "${req.planId}" not found in plan catalog`, 400);
		}

		// 3. Idempotency check
		const existing = await this.store.findActiveByRequestId(req.requestId);
		if (existing) {
			if (existing.state === "PENDING" && existing.expiresAt > new Date(this.now())) {
				return this.challengeToResponse(existing);
			}
			if (existing.state === "DELIVERED" && existing.accessGrant) {
				throw new Key0Error(
					"PROOF_ALREADY_REDEEMED",
					"This request has already been paid. Returning existing access grant.",
					200,
					{ grant: existing.accessGrant },
				);
			}
			// EXPIRED or CANCELLED → fall through to issue new challenge
		}

		// 4. Issue challenge via adapter
		const expiresAt = new Date(this.now() + this.challengeTTL);

		const payload = await this.adapter.issueChallenge({
			requestId: req.requestId,
			resourceId: resourceId,
			planId: req.planId,
			amount: tier.unitAmount!,
			destination: this.config.walletAddress,
			expiresAt,
			metadata: { clientAgentId: clientAgentId },
		});

		// 5. Create challenge record
		const now = new Date(this.now());
		const record: ChallengeRecord = {
			challengeId: payload.challengeId,
			requestId: req.requestId,
			clientAgentId: clientAgentId,
			resourceId: resourceId,
			planId: req.planId,
			amount: tier.unitAmount!,
			amountRaw: parseDollarToUsdcMicro(tier.unitAmount!),
			asset: "USDC",
			chainId: this.networkConfig.chainId,
			destination: this.config.walletAddress,
			state: "PENDING",
			expiresAt,
			createdAt: now,
			updatedAt: now,
		};

		await this.store.create(record, { actor: "engine", reason: "challenge_created" });

		// 6. Return challenge response
		return this.challengeToResponse(record);
	}

	async submitProof(proof: PaymentProof): Promise<AccessGrant> {
		// 1. Validate input
		validateNonEmpty(proof.challengeId, "challengeId");
		validateTxHash(proof.txHash);

		// 2. Look up challenge
		const challenge = await this.store.get(proof.challengeId);
		if (!challenge) {
			throw new Key0Error("CHALLENGE_NOT_FOUND", `Challenge "${proof.challengeId}" not found`, 404);
		}

		// 3. Check state
		if (challenge.state === "DELIVERED" && challenge.accessGrant) {
			throw new Key0Error(
				"PROOF_ALREADY_REDEEMED",
				"This challenge has already been paid. Returning existing access grant.",
				200,
				{ grant: challenge.accessGrant },
			);
		}
		if (challenge.state !== "PENDING") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge is no longer active. Re-request access to get a new challenge.",
				410,
			);
		}

		// 4. Check expiry
		if (challenge.expiresAt <= new Date(this.now())) {
			await this.store.transition(challenge.challengeId, "PENDING", "EXPIRED", undefined, {
				actor: "engine",
				reason: "ttl_expired",
			});
			if (this.config.onChallengeExpired) {
				this.config.onChallengeExpired(challenge.challengeId).catch((err: unknown) => {
					console.error("[Key0] onChallengeExpired hook error:", err);
				});
			}
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge expired. Re-request access to get a new challenge.",
				410,
			);
		}

		// 5. Chain mismatch guard
		if (proof.chainId !== challenge.chainId) {
			throw new Key0Error(
				"CHAIN_MISMATCH",
				`Expected chainId ${challenge.chainId}, got ${proof.chainId}`,
				400,
			);
		}

		// 6. Amount guard (compare dollar strings)
		if (proof.amount !== challenge.amount) {
			throw new Key0Error(
				"AMOUNT_MISMATCH",
				`Expected amount ${challenge.amount}, got ${proof.amount}`,
				400,
			);
		}

		// 7. Double-spend guard
		const alreadyUsed = await this.seenTxStore.get(proof.txHash);
		if (alreadyUsed) {
			throw new Key0Error("TX_ALREADY_REDEEMED", "This txHash has already been redeemed", 409, {
				existingChallengeId: alreadyUsed,
			});
		}

		// 8. On-chain verification
		const result = await this.adapter.verifyProof({
			challengeId: challenge.challengeId,
			proof: {
				txHash: proof.txHash,
				chainId: proof.chainId,
				amount: proof.amount,
				asset: proof.asset,
			},
			expected: {
				destination: challenge.destination,
				amountRaw: challenge.amountRaw,
				chainId: challenge.chainId,
				expiresAt: challenge.expiresAt,
			},
		});

		if (!result.verified) {
			throw new Key0Error(
				result.errorCode === "TX_NOT_FOUND" ? "TX_UNCONFIRMED" : "INVALID_PROOF",
				result.error ?? "On-chain verification failed",
				result.errorCode === "TX_NOT_FOUND" ? 202 : 400,
				{ verificationError: result.errorCode },
			);
		}

		// 9. Transition state — atomic, prevents concurrent double-redemption
		const transitioned = await this.store.transition(
			challenge.challengeId,
			"PENDING",
			"PAID",
			{
				txHash: proof.txHash,
				paidAt: new Date(this.now()),
				...(result.fromAddress ? { fromAddress: result.fromAddress } : {}),
			},
			{ actor: "engine", reason: "payment_verified" },
		);
		if (!transitioned) {
			// Another concurrent request already transitioned — reload and return
			const updated = await this.store.get(challenge.challengeId);
			if (updated?.state === "DELIVERED" && updated?.accessGrant) {
				throw new Key0Error(
					"PROOF_ALREADY_REDEEMED",
					"This challenge has already been paid. Returning existing access grant.",
					200,
					{ grant: updated.accessGrant },
				);
			}
			throw new Key0Error("INTERNAL_ERROR", "Concurrent state transition", 500);
		}

		// 10. Mark txHash as used
		const marked = await this.seenTxStore.markUsed(proof.txHash, challenge.challengeId);
		if (!marked) {
			// Extremely unlikely race — another challenge claimed it between check and mark
			await this.store.transition(challenge.challengeId, "PAID", "PENDING", undefined, {
				actor: "engine",
				reason: "tx_already_redeemed_race",
			});
			throw new Key0Error(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed (race condition)",
				409,
			);
		}

		// 11. Issue access token — always delegated to user
		const resourceEndpoint = this.buildResourceEndpoint(challenge.resourceId);
		const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${proof.txHash}`;

		const tokenResult = await this.issueTokenWithRetry({
			requestId: challenge.requestId,
			challengeId: challenge.challengeId,
			resourceId: challenge.resourceId,
			planId: challenge.planId,
			txHash: proof.txHash,
		});

		const accessToken = tokenResult.token;
		const tokenType = tokenResult.tokenType || "Bearer";

		const grant: AccessGrant = {
			type: "AccessGrant",
			challengeId: challenge.challengeId,
			requestId: challenge.requestId,
			accessToken,
			tokenType: tokenType as "Bearer",
			resourceEndpoint,
			resourceId: challenge.resourceId,
			planId: challenge.planId,
			txHash: proof.txHash,
			explorerUrl,
		};

		// 12. Persist grant durably BEFORE returning to client (outbox pattern).
		//     Write accessGrant while still PAID so refund cron skips this record
		//     even if the DELIVERED transition fails.
		await this.store.transition(
			challenge.challengeId,
			"PAID",
			"PAID",
			{
				accessGrant: grant,
			},
			{ actor: "engine", reason: "token_issued" },
		);

		// 13. Mark as DELIVERED — best-effort status update, not the critical write.
		try {
			await this.store.transition(
				challenge.challengeId,
				"PAID",
				"DELIVERED",
				{
					deliveredAt: new Date(this.now()),
				},
				{ actor: "engine", reason: "delivery_confirmed" },
			);
		} catch (err) {
			console.error(
				`[Key0] Failed to mark DELIVERED for ${challenge.challengeId} — record stays PAID with accessGrant set:`,
				err,
			);
		}

		// 14. Fire hook
		if (this.config.onPaymentReceived) {
			this.config.onPaymentReceived(grant).catch((err: unknown) => {
				console.error(
					`[Key0] onPaymentReceived hook error for challenge ${challenge.challengeId}:`,
					err,
				);
			});
		}

		return grant;
	}

	async cancelChallenge(challengeId: string): Promise<void> {
		const challenge = await this.store.get(challengeId);
		if (!challenge) {
			throw new Key0Error("CHALLENGE_NOT_FOUND", `Challenge "${challengeId}" not found`, 404);
		}

		if (challenge.state !== "PENDING") {
			throw new Key0Error(
				"INVALID_REQUEST",
				`Cannot cancel challenge in state "${challenge.state}"`,
				400,
			);
		}

		const transitioned = await this.store.transition(
			challengeId,
			"PENDING",
			"CANCELLED",
			undefined,
			{ actor: "engine", reason: "client_cancelled" },
		);
		if (!transitioned) {
			throw new Key0Error(
				"INTERNAL_ERROR",
				"Failed to cancel challenge — state may have changed concurrently",
				500,
			);
		}
	}

	async getChallenge(challengeId: string): Promise<ChallengeRecord | null> {
		return this.store.get(challengeId);
	}

	/**
	 * Pre-settlement check for the HTTP x402 flow.
	 * Called by the middleware BEFORE settling on-chain to avoid burning USDC
	 * when the challenge is already delivered, expired, or cancelled.
	 *
	 * Returns the existing AccessGrant if already DELIVERED (caller should return it).
	 * Throws if the challenge is EXPIRED or CANCELLED (caller should not settle).
	 * Returns null if safe to proceed with on-chain settlement.
	 */
	async preSettlementCheck(requestId: string): Promise<AccessGrant | null> {
		const existing = await this.store.findActiveByRequestId(requestId);
		if (!existing) return null;

		if (existing.state === "DELIVERED" && existing.accessGrant) {
			return existing.accessGrant;
		}

		if (existing.state === "EXPIRED") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge expired. Re-request access to get a new challenge.",
				410,
			);
		}

		if (existing.state === "CANCELLED") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge was cancelled. Re-request access to get a new challenge.",
				410,
			);
		}

		// PENDING or PAID — safe to proceed
		return null;
	}

	/**
	 * Create a PENDING challenge record for the HTTP x402 flow (step 1: 402 response).
	 * Analogous to requestAccess() but skips adapter.issueChallenge() since x402
	 * payment requirements are built separately by the middleware.
	 */
	async requestHttpAccess(
		requestId: string,
		planId: string,
		resourceId: string,
	): Promise<{ challengeId: string }> {
		// 1. Validate plan
		const tier = this.findPlan(planId);
		if (!tier) {
			throw new Key0Error("TIER_NOT_FOUND", `Plan "${planId}" not found in plan catalog`, 400);
		}

		// 2. Idempotency — same logic as requestAccess
		const existing = await this.store.findActiveByRequestId(requestId);
		if (existing) {
			if (existing.state === "PENDING" && existing.expiresAt > new Date(this.now())) {
				return { challengeId: existing.challengeId };
			}
			if (existing.state === "DELIVERED" && existing.accessGrant) {
				throw new Key0Error(
					"PROOF_ALREADY_REDEEMED",
					"This request has already been paid. Returning existing access grant.",
					200,
					{ grant: existing.accessGrant },
				);
			}
			// EXPIRED or CANCELLED → fall through to create new record
		}

		// 3. Create PENDING record
		const challengeId = `http-${crypto.randomUUID()}`;
		const expiresAt = new Date(this.now() + this.challengeTTL);
		const now402 = new Date(this.now());

		const record: ChallengeRecord = {
			challengeId,
			requestId,
			clientAgentId: "x402-http",
			resourceId,
			planId,
			amount: tier.unitAmount!,
			amountRaw: parseDollarToUsdcMicro(tier.unitAmount!),
			asset: "USDC",
			chainId: this.networkConfig.chainId,
			destination: this.config.walletAddress,
			state: "PENDING",
			expiresAt,
			createdAt: now402,
			updatedAt: now402,
		};

		await this.store.create(record, { actor: "engine", reason: "challenge_created" });
		return { challengeId };
	}

	/**
	 * Process an HTTP x402 payment with full lifecycle tracking.
	 * Used by the x402 HTTP middleware when a client sends PAYMENT-SIGNATURE header
	 * with an EIP-3009 signed authorization that has been settled via the gas wallet
	 * or facilitator.
	 *
	 * Lifecycle: looks up PENDING record (or auto-creates one if step 1 was skipped),
	 * transitions PENDING → PAID → DELIVERED. If fetchResourceCredentials throws, record stays
	 * PAID and the refund cron can pick it up.
	 */
	async processHttpPayment(
		requestId: string,
		planId: string,
		resourceId: string,
		txHash: `0x${string}`,
		fromAddress?: `0x${string}`,
	): Promise<AccessGrant> {
		// 1. Validate tier
		const tier = this.findPlan(planId);
		if (!tier) {
			throw new Key0Error("TIER_NOT_FOUND", `Plan "${planId}" not found in plan catalog`, 400);
		}

		// 3. Double-spend guard
		const alreadyUsed = await this.seenTxStore.get(txHash);
		if (alreadyUsed) {
			throw new Key0Error("TX_ALREADY_REDEEMED", "This txHash has already been redeemed", 409, {
				existingChallengeId: alreadyUsed,
			});
		}

		// 4. Look up PENDING record created by requestHttpAccess (step 1).
		//    If client skipped step 1, auto-create one.
		//    If record is EXPIRED or CANCELLED, reject (don't auto-create).
		let challenge = await this.store.findActiveByRequestId(requestId);
		if (challenge?.state === "DELIVERED" && challenge.accessGrant) {
			throw new Key0Error(
				"PROOF_ALREADY_REDEEMED",
				"This request has already been paid. Returning existing access grant.",
				200,
				{ grant: challenge.accessGrant },
			);
		}
		if (challenge?.state === "EXPIRED") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge expired. Re-request access to get a new challenge.",
				410,
			);
		}
		if (challenge?.state === "CANCELLED") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge was cancelled. Re-request access to get a new challenge.",
				410,
			);
		}
		if (!challenge || challenge.state !== "PENDING") {
			const challengeId = `http-${crypto.randomUUID()}`;
			const expiresAt = new Date(this.now() + this.challengeTTL);
			const nowSettle = new Date(this.now());
			const record: ChallengeRecord = {
				challengeId,
				requestId,
				clientAgentId: "x402-http",
				resourceId,
				planId,
				amount: tier.unitAmount!,
				amountRaw: parseDollarToUsdcMicro(tier.unitAmount!),
				asset: "USDC",
				chainId: this.networkConfig.chainId,
				destination: this.config.walletAddress,
				state: "PENDING",
				expiresAt,
				createdAt: nowSettle,
				updatedAt: nowSettle,
			};
			await this.store.create(record, { actor: "engine", reason: "challenge_auto_created" });
			challenge = record;
		}

		// 5. Transition PENDING → PAID
		const transitioned = await this.store.transition(
			challenge.challengeId,
			"PENDING",
			"PAID",
			{
				txHash,
				paidAt: new Date(this.now()),
				...(fromAddress ? { fromAddress } : {}),
			},
			{ actor: "engine", reason: "payment_verified" },
		);
		if (!transitioned) {
			const updated = await this.store.get(challenge.challengeId);
			if (updated?.state === "DELIVERED" && updated?.accessGrant) {
				throw new Key0Error(
					"PROOF_ALREADY_REDEEMED",
					"This request has already been paid. Returning existing access grant.",
					200,
					{ grant: updated.accessGrant },
				);
			}
			throw new Key0Error("INTERNAL_ERROR", "Concurrent state transition", 500);
		}

		// 6. Mark txHash as used
		const marked = await this.seenTxStore.markUsed(txHash, challenge.challengeId);
		if (!marked) {
			await this.store.transition(challenge.challengeId, "PAID", "PENDING", undefined, {
				actor: "engine",
				reason: "tx_already_redeemed_race",
			});
			throw new Key0Error(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed (race condition)",
				409,
			);
		}

		// 7. Issue access token
		const resourceEndpoint = this.buildResourceEndpoint(resourceId);
		const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${txHash}`;

		const tokenResult = await this.issueTokenWithRetry({
			requestId: challenge.requestId,
			challengeId: challenge.challengeId,
			resourceId,
			planId,
			txHash,
		});

		const accessToken = tokenResult.token;
		const tokenType = tokenResult.tokenType || "Bearer";

		// 8. Build access grant
		const grant: AccessGrant = {
			type: "AccessGrant",
			challengeId: challenge.challengeId,
			requestId: challenge.requestId,
			accessToken,
			tokenType: tokenType as "Bearer",
			resourceEndpoint,
			resourceId,
			planId,
			txHash,
			explorerUrl,
		};

		// 9. Persist grant durably BEFORE returning to client (outbox pattern).
		await this.store.transition(
			challenge.challengeId,
			"PAID",
			"PAID",
			{
				accessGrant: grant,
			},
			{ actor: "engine", reason: "token_issued" },
		);

		// 10. Mark as DELIVERED — best-effort status update, not the critical write.
		try {
			await this.store.transition(
				challenge.challengeId,
				"PAID",
				"DELIVERED",
				{
					deliveredAt: new Date(this.now()),
				},
				{ actor: "engine", reason: "delivery_confirmed" },
			);
		} catch (err) {
			console.error(
				`[Key0] Failed to mark DELIVERED for ${challenge.challengeId} — record stays PAID with accessGrant set:`,
				err,
			);
		}

		// 11. Fire hook if configured
		if (this.config.onPaymentReceived) {
			this.config.onPaymentReceived(grant).catch((err: unknown) => {
				console.error(
					`[Key0] onPaymentReceived hook error for challenge ${challenge.challengeId}:`,
					err,
				);
			});
		}

		return grant;
	}

	/**
	 * Records a per-request payment: validates the plan, guards against double-spend,
	 * creates/finds the PENDING challenge record, transitions to PAID, and marks the txHash used.
	 *
	 * Unlike `processHttpPayment`, this does NOT call `fetchResourceCredentials` and does NOT
	 * transition to DELIVERED. The caller is responsible for proxying to the backend and calling
	 * `markDelivered` if the backend returns a success response.
	 *
	 * Used by the HTTP, A2A, and MCP handlers when plan.mode === "per-request" in standalone mode.
	 */
	async recordPerRequestPayment(
		requestId: string,
		planId: string,
		resourcePath: string,
		txHash: `0x${string}`,
		fromAddress?: `0x${string}`,
	): Promise<{ challengeId: string; requestId: string; explorerUrl: string }> {
		// 1. Validate plan
		const tier = this.findPlan(planId);
		if (!tier) {
			throw new Key0Error("TIER_NOT_FOUND", `Plan "${planId}" not found in plan catalog`, 400);
		}

		// 2. Double-spend guard
		const alreadyUsed = await this.seenTxStore.get(txHash);
		if (alreadyUsed) {
			throw new Key0Error("TX_ALREADY_REDEEMED", "This txHash has already been redeemed", 409, {
				existingChallengeId: alreadyUsed,
			});
		}

		// 3. Find existing PENDING record or auto-create one
		let challenge = await this.store.findActiveByRequestId(requestId);
		if (challenge?.state === "DELIVERED") {
			throw new Key0Error(
				"PROOF_ALREADY_REDEEMED",
				"This request has already been paid and delivered.",
				200,
				{ challengeId: challenge.challengeId },
			);
		}
		if (challenge?.state === "EXPIRED" || challenge?.state === "CANCELLED") {
			throw new Key0Error(
				"CHALLENGE_EXPIRED",
				"Challenge expired or cancelled. Re-request access to get a new challenge.",
				410,
			);
		}
		if (!challenge || challenge.state !== "PENDING") {
			const challengeId = `ppr-${crypto.randomUUID()}`;
			const expiresAt = new Date(this.now() + this.challengeTTL);
			const nowSettle = new Date(this.now());
			const record: ChallengeRecord = {
				challengeId,
				requestId,
				clientAgentId: "x402-ppr",
				resourceId: resourcePath,
				planId,
				amount: tier.unitAmount!,
				amountRaw: parseDollarToUsdcMicro(tier.unitAmount!),
				asset: "USDC",
				chainId: this.networkConfig.chainId,
				destination: this.config.walletAddress,
				state: "PENDING",
				expiresAt,
				createdAt: nowSettle,
				updatedAt: nowSettle,
			};
			await this.store.create(record, { actor: "engine", reason: "ppr_auto_created" });
			challenge = record;
		}

		// 4. Transition PENDING → PAID
		const transitioned = await this.store.transition(
			challenge.challengeId,
			"PENDING",
			"PAID",
			{
				txHash,
				paidAt: new Date(this.now()),
				...(fromAddress ? { fromAddress } : {}),
			},
			{ actor: "engine", reason: "ppr_payment_verified" },
		);
		if (!transitioned) {
			const updated = await this.store.get(challenge.challengeId);
			if (updated?.state === "DELIVERED") {
				throw new Key0Error(
					"PROOF_ALREADY_REDEEMED",
					"This request has already been paid and delivered.",
					200,
					{ challengeId: challenge.challengeId },
				);
			}
			throw new Key0Error("INTERNAL_ERROR", "Concurrent state transition", 500);
		}

		// 5. Mark txHash as used (double-spend prevention)
		const marked = await this.seenTxStore.markUsed(txHash, challenge.challengeId);
		if (!marked) {
			await this.store.transition(challenge.challengeId, "PAID", "PENDING", undefined, {
				actor: "engine",
				reason: "tx_already_redeemed_race",
			});
			throw new Key0Error(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed (race condition)",
				409,
			);
		}

		const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${txHash}`;
		return { challengeId: challenge.challengeId, requestId: challenge.requestId, explorerUrl };
	}

	/**
	 * Transitions a challenge from PAID to DELIVERED.
	 * Called by the per-request proxy path after the backend returns a 2xx response.
	 * Best-effort — failure is logged but not re-thrown (the payment was already settled).
	 */
	async markDelivered(challengeId: string): Promise<void> {
		try {
			await this.store.transition(
				challengeId,
				"PAID",
				"DELIVERED",
				{ deliveredAt: new Date(this.now()) },
				{ actor: "engine", reason: "ppr_delivery_confirmed" },
			);
		} catch (err) {
			console.error(
				`[Key0] Failed to mark DELIVERED for ${challengeId} — record stays PAID (refund cron eligible):`,
				err,
			);
		}
	}
}
