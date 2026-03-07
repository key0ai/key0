/**
 * Expired Authorization — verifies that an EIP-3009 authorization with a validBefore
 * timestamp in the past is rejected by the settlement layer.
 *
 * ExactEvmScheme.verify() checks the authorization window:
 *   - validAfter  <= block.timestamp <= validBefore
 * If validBefore < now, the authorization is already expired → PAYMENT_FAILED.
 * No on-chain gas is spent for the settlement call since verify() fails first.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

describe("Expired Authorization", () => {
	test("EIP-3009 authorization with validBefore in the past is rejected", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		const { paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		const requirements = paymentRequired.accepts[0]!;
		const destination = requirements.payTo as `0x${string}`;
		const amountRaw = BigInt(requirements.amount);

		// Sign with validBefore = 1 (Unix epoch + 1 second = long in the past)
		const auth = await client.signEIP3009({
			destination,
			amountRaw,
			validBeforeOverride: 1n,
		});

		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		// Must be rejected — expired authorization window
		expect(result.status).not.toBe(200);
		expect(result.error).toBeDefined();
	}, 60_000);
});
