import { sendUsdc } from "../adapter/send-usdc.js";
import type { IChallengeStore, IRedisLockClient, NetworkName } from "../types/index.js";
import { CHAIN_CONFIGS } from "../types/index.js";
import { gasWalletLockKey, withGasWalletLock } from "../utils/gas-wallet-lock.js";

export type RefundConfig = {
	readonly store: IChallengeStore;
	/** Wallet private key — owns the USDC to be refunded. */
	readonly walletPrivateKey: `0x${string}`;
	/**
	 * Optional gas wallet private key. When provided, uses EIP-3009
	 * transferWithAuthorization so the gas wallet pays gas instead of the
	 * USDC-holding wallet (which may have no ETH).
	 */
	readonly gasWalletPrivateKey?: `0x${string}`;
	readonly network: NetworkName;
	/**
	 * Optional RPC URL override. When provided, overrides the default public RPC
	 * for on-chain refund transactions. Use to pass a private/Alchemy RPC for
	 * better reliability (e.g. avoid stale nonces from public RPCs).
	 */
	readonly rpcUrl?: string;
	/** Grace period before a PAID record is eligible for refund. Default: 300_000 (5 mins). */
	readonly minAgeMs?: number;
	/** Max records to process per cron run. Default: 50. */
	readonly batchSize?: number;
	/**
	 * Optional Redis client for distributed gas wallet locking.
	 * When provided alongside gasWalletPrivateKey, refund transactions are
	 * serialised with settlement transactions via a shared distributed lock,
	 * preventing nonce conflicts.
	 * When absent, falls back to an in-process serial queue (single-instance only).
	 */
	readonly redis?: IRedisLockClient;
};

export type RefundResult = {
	readonly challengeId: string;
	readonly originalTxHash: `0x${string}`;
	readonly refundTxHash?: `0x${string}`;
	readonly amount: string;
	readonly toAddress: `0x${string}`;
	readonly success: boolean;
	readonly error?: string;
};

/**
 * Process refunds for all payments that are still PAID after the grace period
 * and were never marked as delivered. Designed to be called from a cron job
 * (e.g. Bull).
 *
 * Each eligible record is atomically transitioned to REFUND_PENDING before
 * broadcasting — concurrent cron runs will not double-refund.
 */
export async function processRefunds(config: RefundConfig): Promise<RefundResult[]> {
	const {
		store,
		walletPrivateKey,
		gasWalletPrivateKey,
		network,
		rpcUrl,
		minAgeMs = 300_000,
		batchSize = 50,
		redis,
	} = config;
	const networkConfig = rpcUrl ? { ...CHAIN_CONFIGS[network], rpcUrl } : CHAIN_CONFIGS[network];
	const results: RefundResult[] = [];

	// Compute the lock key once — shared with settlePayment so refunds and
	// settlements from the same gas wallet are properly serialised.
	const lockKey = gasWalletPrivateKey
		? gasWalletLockKey(
				// Derive the gas wallet address from the private key.
				// We import privateKeyToAccount lazily to avoid pulling viem
				// into callers that don't need it.
				(await import("viem/accounts")).privateKeyToAccount(gasWalletPrivateKey).address,
			)
		: undefined;

	let pending: Awaited<ReturnType<IChallengeStore["findPendingForRefund"]>>;
	try {
		pending = await store.findPendingForRefund(minAgeMs);
	} catch (err) {
		console.error("[Refund] Failed to fetch pending refunds:", err);
		return results;
	}

	// Limit batch size to avoid long-running cron runs
	const batch = pending.slice(0, batchSize);

	for (const record of batch) {
		// Destructure before the try/catch so TypeScript's narrowing is unambiguous
		const fromAddress = record.fromAddress;
		const txHash = record.txHash;
		// txHash and fromAddress are always set on PAID records (written during PENDING→PAID
		// transition), but ChallengeRecord types them as optional to cover all states.
		if (!fromAddress || !txHash) continue;

		// 1. Atomically claim this record for refunding — prevents double-refund
		const claimed = await store.transition(
			record.challengeId,
			"PAID",
			"REFUND_PENDING",
			undefined,
			{ actor: "cron", reason: "undelivered_payment" },
		);
		if (!claimed) {
			// Another cron worker already claimed it
			continue;
		}

		// 2. Broadcast refund tx (serialised via gas wallet lock when applicable)
		try {
			const sendUsdcCall = () =>
				sendUsdc({
					to: fromAddress,
					amountRaw: record.amountRaw,
					privateKey: walletPrivateKey,
					...(gasWalletPrivateKey ? { gasWalletPrivateKey } : {}),
					networkConfig,
				});

			const refundTxHash =
				gasWalletPrivateKey && lockKey
					? await withGasWalletLock(sendUsdcCall, redis, lockKey)
					: await sendUsdcCall();

			// 3. Mark as refunded
			await store.transition(
				record.challengeId,
				"REFUND_PENDING",
				"REFUNDED",
				{
					refundTxHash,
					refundedAt: new Date(),
				},
				{ actor: "cron", reason: "refund_tx_confirmed" },
			);

			results.push({
				challengeId: record.challengeId,
				originalTxHash: txHash,
				refundTxHash,
				amount: record.amount,
				toAddress: fromAddress,
				success: true,
			});
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);

			// 4. Mark as failed — cron will NOT retry automatically
			try {
				await store.transition(
					record.challengeId,
					"REFUND_PENDING",
					"REFUND_FAILED",
					{
						refundError: error,
					},
					{ actor: "cron", reason: error },
				);
			} catch (transitionErr) {
				console.error(
					`[Refund] Failed to mark REFUND_FAILED for ${record.challengeId}:`,
					transitionErr,
				);
				// Record stays REFUND_PENDING — needs manual operator intervention
			}

			results.push({
				challengeId: record.challengeId,
				originalTxHash: txHash,
				amount: record.amount,
				toAddress: fromAddress,
				success: false,
				error,
			});
		}
	}

	return results;
}

/**
 * Re-queue REFUND_FAILED records for retry by transitioning them back to PAID.
 * The next `processRefunds` cron run will pick them up via the sorted set.
 *
 * Intended for operator use (admin API, manual intervention script).
 * Returns the list of challengeIds that were successfully re-queued.
 */
export async function retryFailedRefunds(
	store: IChallengeStore,
	challengeIds: string[],
): Promise<string[]> {
	const requeued: string[] = [];
	for (const id of challengeIds) {
		const record = await store.get(id);
		if (!record || record.state !== "REFUND_FAILED") continue;
		const ok = await store.transition(
			id,
			"REFUND_FAILED",
			"PAID",
			{
				paidAt: record.paidAt ? new Date(record.paidAt) : new Date(),
			},
			{ actor: "admin", reason: "requeued_for_retry" },
		);
		if (ok) requeued.push(id);
	}
	return requeued;
}
