import {
	type AccessGrant,
	type AccessRequest,
	AgentGateError,
	type ChallengeRecord,
	type IChallengeStore,
	type IPaymentAdapter,
	type ISeenTxStore,
	type NetworkConfig,
	type NetworkName,
	type PaymentProof,
	type ProductTier,
	type SellerConfig,
	type X402Challenge,
	type X402PaymentRequiredResponse,
	type X402SettleResponse,
	CHAIN_ID_TO_NETWORK,
} from "../types/index.js";

import { parseDollarToUsdcMicro } from "../adapter/index.js";
import { CHAIN_CONFIGS } from "../types/index.js";
import { validateSellerConfig } from "./config-validation.js";
import {
	validateNonEmpty,
	validateTxHash,
	validateUUID,
} from "./validation.js";

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

	private findTier(tierId: string): ProductTier | undefined {
		return this.config.products.find((t: ProductTier) => t.tierId === tierId);
	}

	private challengeToResponse(record: ChallengeRecord): X402Challenge {
		return {
			type: "X402Challenge",
			challengeId: record.challengeId,
			requestId: record.requestId,
			tierId: record.tierId,
			amount: record.amount,
			asset: "USDC",
			chainId: record.chainId,
			destination: record.destination,
			expiresAt: record.expiresAt.toISOString(),
			description: `Send ${record.amount} USDC to ${record.destination} on chain ${record.chainId}. Then call the "submit-proof" skill with a PaymentProof containing the txHash, challengeId "${record.challengeId}", requestId "${record.requestId}", chainId ${record.chainId}, amount "${record.amount}", asset "USDC", and your fromAgentId.`,
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
					maxTimeoutSeconds: 300, // 5 minutes
					extra: {
						challengeId: record.challengeId,
						requestId: record.requestId,
						tierId: record.tierId,
						amount: record.amount,
						chainId: record.chainId,
						expiresAt: record.expiresAt.toISOString(),
						description: `${record.tierId} tier access — ${record.amount} USDC`,
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
		// 1. Validate input - only requestId and tierId are mandatory
		validateUUID(req.requestId, "requestId");
		
		// Provide defaults for optional fields
		const resourceId = req.resourceId || "default";
		const clientAgentId = req.clientAgentId || "anonymous";

		// 2. Validate tier
		const tier = this.findTier(req.tierId);
		if (!tier) {
			throw new AgentGateError(
				"TIER_NOT_FOUND",
				`Tier "${req.tierId}" not found in product catalog`,
				400,
			);
		}

		// 3. Pre-flight resource check (with 5s timeout)
		const timeoutMs = this.config.resourceVerifyTimeoutMs ?? 5000;
		const exists = await Promise.race([
			this.config.onVerifyResource(resourceId, req.tierId),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new AgentGateError("RESOURCE_VERIFY_TIMEOUT", "Resource verification timed out", 504),
						),
					timeoutMs,
				),
			),
		]);
		if (!exists) {
			throw new AgentGateError(
				"RESOURCE_NOT_FOUND",
				`Resource "${resourceId}" not found or not available for tier "${req.tierId}"`,
				404,
			);
		}

		// 4. Idempotency check
		const existing = await this.store.findActiveByRequestId(req.requestId);
		if (existing) {
			if (existing.state === "PENDING" && existing.expiresAt > new Date(this.now())) {
				return this.challengeToResponse(existing);
			}
			if (existing.state === "PAID" && existing.accessGrant) {
				throw new AgentGateError(
					"PROOF_ALREADY_REDEEMED",
					"This request has already been paid. Returning existing access grant.",
					200,
					{ grant: existing.accessGrant },
				);
			}
			// EXPIRED or CANCELLED → fall through to issue new challenge
		}

		// 5. Issue challenge via adapter
		const expiresAt = new Date(this.now() + this.challengeTTL);

		const payload = await this.adapter.issueChallenge({
			requestId: req.requestId,
			resourceId: resourceId,
			tierId: req.tierId,
			amount: tier.amount,
			destination: this.config.walletAddress,
			expiresAt,
			metadata: { clientAgentId: clientAgentId },
		});

		// 6. Create challenge record
		const record: ChallengeRecord = {
			challengeId: payload.challengeId,
			requestId: req.requestId,
			clientAgentId: clientAgentId,
			resourceId: resourceId,
			tierId: req.tierId,
			amount: tier.amount,
			amountRaw: parseDollarToUsdcMicro(tier.amount),
			asset: "USDC",
			chainId: this.networkConfig.chainId,
			destination: this.config.walletAddress,
			state: "PENDING",
			expiresAt,
			createdAt: new Date(this.now()),
		};

		await this.store.create(record);

		// 7. Return challenge response
		return this.challengeToResponse(record);
	}

	async submitProof(proof: PaymentProof): Promise<AccessGrant> {
		// 1. Validate input
		validateNonEmpty(proof.challengeId, "challengeId");
		validateTxHash(proof.txHash);

		// 2. Look up challenge
		const challenge = await this.store.get(proof.challengeId);
		if (!challenge) {
			throw new AgentGateError(
				"CHALLENGE_NOT_FOUND",
				`Challenge "${proof.challengeId}" not found`,
				404,
			);
		}

		// 3. Check state
		if (challenge.state === "PAID" && challenge.accessGrant) {
			throw new AgentGateError(
				"PROOF_ALREADY_REDEEMED",
				"This challenge has already been paid. Returning existing access grant.",
				200,
				{ grant: challenge.accessGrant },
			);
		}
		if (challenge.state !== "PENDING") {
			throw new AgentGateError(
				"CHALLENGE_EXPIRED",
				"Challenge is no longer active. Re-request access to get a new challenge.",
				410,
			);
		}

		// 4. Check expiry
		if (challenge.expiresAt <= new Date(this.now())) {
			await this.store.transition(challenge.challengeId, "PENDING", "EXPIRED");
			if (this.config.onChallengeExpired) {
				this.config.onChallengeExpired(challenge.challengeId).catch((err: unknown) => {
					console.error("[AgentGate] onChallengeExpired hook error:", err);
				});
			}
			throw new AgentGateError(
				"CHALLENGE_EXPIRED",
				"Challenge expired. Re-request access to get a new challenge.",
				410,
			);
		}

		// 5. Chain mismatch guard
		if (proof.chainId !== challenge.chainId) {
			throw new AgentGateError(
				"CHAIN_MISMATCH",
				`Expected chainId ${challenge.chainId}, got ${proof.chainId}`,
				400,
			);
		}

		// 6. Amount guard (compare dollar strings)
		if (proof.amount !== challenge.amount) {
			throw new AgentGateError(
				"AMOUNT_MISMATCH",
				`Expected amount ${challenge.amount}, got ${proof.amount}`,
				400,
			);
		}

		// 7. Double-spend guard
		const alreadyUsed = await this.seenTxStore.get(proof.txHash);
		if (alreadyUsed) {
			throw new AgentGateError(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed",
				409,
				{
					existingChallengeId: alreadyUsed,
				},
			);
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
			throw new AgentGateError(
				result.errorCode === "TX_NOT_FOUND" ? "TX_UNCONFIRMED" : "INVALID_PROOF",
				result.error ?? "On-chain verification failed",
				result.errorCode === "TX_NOT_FOUND" ? 202 : 400,
				{ verificationError: result.errorCode },
			);
		}

		// 9. Transition state — atomic, prevents concurrent double-redemption
		const transitioned = await this.store.transition(challenge.challengeId, "PENDING", "PAID", {
			txHash: proof.txHash,
			paidAt: new Date(this.now()),
		});
		if (!transitioned) {
			// Another concurrent request already transitioned — reload and return
			const updated = await this.store.get(challenge.challengeId);
			if (updated?.accessGrant) {
				throw new AgentGateError(
					"PROOF_ALREADY_REDEEMED",
					"This challenge has already been paid. Returning existing access grant.",
					200,
					{ grant: updated.accessGrant },
				);
			}
			throw new AgentGateError("INTERNAL_ERROR", "Concurrent state transition", 500);
		}

		// 10. Mark txHash as used
		const marked = await this.seenTxStore.markUsed(proof.txHash, challenge.challengeId);
		if (!marked) {
			// Extremely unlikely race — another challenge claimed it between check and mark
			await this.store.transition(challenge.challengeId, "PAID", "PENDING");
			throw new AgentGateError(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed (race condition)",
				409,
			);
		}

		// 11. Issue access token — always delegated to user
		const resourceEndpoint = this.buildResourceEndpoint(challenge.resourceId);
		const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${proof.txHash}`;

		const tokenResult = await this.config.onIssueToken({
			requestId: challenge.requestId,
			challengeId: challenge.challengeId,
			resourceId: challenge.resourceId,
			tierId: challenge.tierId,
			txHash: proof.txHash,
		});

		const accessToken = tokenResult.token;
		const expiresAt = tokenResult.expiresAt;
		const tokenType = tokenResult.tokenType || "Bearer";

		const grant: AccessGrant = {
			type: "AccessGrant",
			challengeId: challenge.challengeId,
			requestId: challenge.requestId,
			accessToken,
			tokenType: tokenType as "Bearer",
			expiresAt: expiresAt.toISOString(),
			resourceEndpoint,
			resourceId: challenge.resourceId,
			tierId: challenge.tierId,
			txHash: proof.txHash,
			explorerUrl,
		};

		// 12. Store grant on challenge record
		await this.store.transition(challenge.challengeId, "PAID", "PAID", {
			accessGrant: grant,
		});

		// 13. Fire hook
		if (this.config.onPaymentReceived) {
			this.config.onPaymentReceived(grant).catch((err: unknown) => {
				console.error("[AgentGate] onPaymentReceived hook error:", err);
			});
		}

		return grant;
	}

	async cancelChallenge(challengeId: string): Promise<void> {
		const challenge = await this.store.get(challengeId);
		if (!challenge) {
			throw new AgentGateError("CHALLENGE_NOT_FOUND", `Challenge "${challengeId}" not found`, 404);
		}

		if (challenge.state !== "PENDING") {
			throw new AgentGateError(
				"INVALID_REQUEST",
				`Cannot cancel challenge in state "${challenge.state}"`,
				400,
			);
		}

		const transitioned = await this.store.transition(challengeId, "PENDING", "CANCELLED");
		if (!transitioned) {
			throw new AgentGateError(
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
	 * Process an HTTP x402 payment (stateless flow - no challenge lifecycle).
	 * Used by the x402 HTTP middleware when a client sends X-Payment header with
	 * an EIP-3009 signed authorization that has been settled via the facilitator.
	 * 
	 * Unlike the standard A2A flow, this:
	 * - Does NOT use IChallengeStore (no pending challenge)
	 * - Does NOT call adapter.verifyProof() (facilitator already verified)
	 * - Auto-generates requestId
	 * - Issues token immediately
	 */
	async processHttpPayment(
		tierId: string,
		resourceId: string,
		txHash: `0x${string}`,
	): Promise<AccessGrant> {
		// 1. Validate tier
		const tier = this.findTier(tierId);
		if (!tier) {
			throw new AgentGateError(
				"TIER_NOT_FOUND",
				`Tier "${tierId}" not found in product catalog`,
				400,
			);
		}

		// 2. Verify resource exists
		const timeoutMs = this.config.resourceVerifyTimeoutMs ?? 5000;
		const exists = await Promise.race([
			this.config.onVerifyResource(resourceId, tierId),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new AgentGateError("RESOURCE_VERIFY_TIMEOUT", "Resource verification timed out", 504),
						),
					timeoutMs,
				),
			),
		]);
		if (!exists) {
			throw new AgentGateError(
				"RESOURCE_NOT_FOUND",
				`Resource "${resourceId}" not found or not available for tier "${tierId}"`,
				404,
			);
		}

		// 3. Double-spend guard
		const alreadyUsed = await this.seenTxStore.get(txHash);
		if (alreadyUsed) {
			throw new AgentGateError(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed",
				409,
				{ existingChallengeId: alreadyUsed },
			);
		}

		// 4. Generate IDs for tracking
		const requestId = `http-${crypto.randomUUID()}`;
		const challengeId = `http-${crypto.randomUUID()}`;

		// 5. Mark txHash as used
		const marked = await this.seenTxStore.markUsed(txHash, challengeId);
		if (!marked) {
			throw new AgentGateError(
				"TX_ALREADY_REDEEMED",
				"This txHash has already been redeemed (race condition)",
				409,
			);
		}

		// 6. Issue access token
		const resourceEndpoint = this.buildResourceEndpoint(resourceId);
		const explorerUrl = `${this.networkConfig.explorerBaseUrl}/tx/${txHash}`;

		const tokenResult = await this.config.onIssueToken({
			requestId,
			challengeId,
			resourceId,
			tierId,
			txHash,
		});

		const accessToken = tokenResult.token;
		const expiresAt = tokenResult.expiresAt;
		const tokenType = tokenResult.tokenType || "Bearer";

		// 7. Build and return access grant
		const grant: AccessGrant = {
			type: "AccessGrant",
			challengeId,
			requestId,
			accessToken,
			tokenType: tokenType as "Bearer",
			expiresAt: expiresAt.toISOString(),
			resourceEndpoint,
			resourceId,
			tierId,
			txHash,
			explorerUrl,
		};

		// 8. Fire hook if configured
		if (this.config.onPaymentReceived) {
			this.config.onPaymentReceived(grant).catch((err: unknown) => {
				console.error("[AgentGate] onPaymentReceived hook error:", err);
			});
		}

		return grant;
	}
}
