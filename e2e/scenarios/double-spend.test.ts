/**
 * Double Spend — verifies TX_ALREADY_REDEEMED protection.
 *
 * Submits the same EIP-3009 authorization nonce to two different challenges.
 * First purchase succeeds; second fails because:
 *   - The on-chain nonce is burned (transferWithAuthorization reverts), OR
 *   - The seenTxStore has the txHash (application-level guard).
 *
 * Either failure mode proves double-spend protection works.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

describe("Double Spend Protection", () => {
	test(
		"reused EIP-3009 nonce is rejected on the second challenge",
		async () => {
			const client = makeClientE2eClient();

			// ── Challenge 1 ─────────────────────────────────────────────
			const req1 = crypto.randomUUID();
			const { paymentRequired: pr1 } = await client.requestAccess({
				tierId: DEFAULT_TIER_ID,
				requestId: req1,
			});

			const requirements = pr1.accepts[0]!;
			const amountRaw = BigInt(requirements.amount);
			const destination = requirements.payTo as `0x${string}`;

			// Sign authorization (nonce is embedded in auth)
			const auth = await client.signEIP3009({ destination, amountRaw });

			// Submit to challenge 1 — should succeed
			const result1 = await client.submitPayment({
				tierId: DEFAULT_TIER_ID,
				requestId: req1,
				auth,
				paymentRequired: pr1,
			});
			expect(result1.status).toBe(200);
			expect(result1.grant).toBeDefined();

			// ── Challenge 2 ─────────────────────────────────────────────
			const req2 = crypto.randomUUID();
			const { paymentRequired: pr2 } = await client.requestAccess({
				tierId: DEFAULT_TIER_ID,
				requestId: req2,
			});

			// Reuse the SAME auth (same nonce — already burned on-chain).
			// Update accepted requirements to point to challenge 2's requirements.
			const result2 = await client.submitPayment({
				tierId: DEFAULT_TIER_ID,
				requestId: req2,
				auth, // same nonce → burned on-chain → transferWithAuthorization reverts
				paymentRequired: pr2,
			});

			// Must fail (on-chain revert from burned nonce, or seenTxStore guard)
			expect(result2.status).not.toBe(200);
			expect(result2.error).toBeDefined();
		},
		120_000,
	);
});
