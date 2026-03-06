/**
 * Wrong Recipient — verifies transfers to the wrong address are rejected.
 *
 * Signs EIP-3009 to a random address (not the seller wallet).
 * ExactEvmScheme.verify() compares `to` vs paymentRequirements.payTo → mismatch → PAYMENT_FAILED.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

const RANDOM_ADDRESS = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

describe("Wrong Recipient", () => {
	test("payment to wrong address is rejected by the settlement layer", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		const { paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		const requirements = paymentRequired.accepts[0]!;
		const correctAmount = BigInt(requirements.amount);

		// Sign to the WRONG address (not the seller's payTo)
		const auth = await client.signEIP3009({
			destination: RANDOM_ADDRESS, // deliberately wrong recipient
			amountRaw: correctAmount,
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
