/**
 * Wrong Amount — verifies underpayment is rejected.
 *
 * Signs EIP-3009 with value=1 (1 micro-USDC) instead of the required $0.10.
 * ExactEvmScheme.verify() detects the mismatch → PAYMENT_FAILED.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

describe("Wrong Amount", () => {
	test("underpayment (1 micro-USDC) is rejected by the settlement layer", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		const { paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		const requirements = paymentRequired.accepts[0]!;
		const destination = requirements.payTo as `0x${string}`;

		// Sign with 1 micro-USDC instead of the required amount
		const auth = await client.signEIP3009({
			destination,
			amountRaw: 1n, // deliberately wrong
		});

		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		expect(result.status).not.toBe(200);
		expect(result.error).toBeDefined();
	}, 120_000);
});
