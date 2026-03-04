import { sendUsdc } from "../adapter/send-usdc.js";
import { CHAIN_CONFIGS } from "../types/index.js";
import type { IChallengeStore, NetworkName } from "../types/index.js";

export type RefundConfig = {
	readonly store: IChallengeStore;
	/** Wallet private key — used to send USDC back to payers. */
	readonly walletPrivateKey: `0x${string}`;
	readonly network: NetworkName;
	/** Grace period before a PAID record is eligible for refund. Default: 300_000 (5 mins). */
	readonly minAgeMs?: number;
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
	const { store, walletPrivateKey, network, minAgeMs = 300_000 } = config;
	const networkConfig = CHAIN_CONFIGS[network];
	const results: RefundResult[] = [];

	const pending = await store.findPendingForRefund(minAgeMs);

	for (const record of pending) {
		// Destructure before the try/catch so TypeScript's narrowing is unambiguous
		const fromAddress = record.fromAddress;
		const txHash = record.txHash;
		// txHash and fromAddress are always set on PAID records (written during PENDING→PAID
		// transition), but ChallengeRecord types them as optional to cover all states.
		if (!fromAddress || !txHash) continue;

		// 1. Atomically claim this record for refunding — prevents double-refund
		const claimed = await store.transition(record.challengeId, "PAID", "REFUND_PENDING");
		if (!claimed) {
			// Another cron worker already claimed it
			continue;
		}

		// 2. Broadcast refund tx
		try {
			const refundTxHash = await sendUsdc({
				to: fromAddress,
				amountRaw: record.amountRaw,
				privateKey: walletPrivateKey,
				networkConfig,
			});

			// 3. Mark as refunded
			await store.transition(record.challengeId, "REFUND_PENDING", "REFUNDED", {
				refundTxHash,
				refundedAt: new Date(),
			});

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
			await store.transition(record.challengeId, "REFUND_PENDING", "REFUND_FAILED", {
				refundError: error,
			});

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
