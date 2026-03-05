/**
 * Idempotent Challenge — same requestId returns the same challengeId.
 *
 * Verifies that repeated AccessRequests with the same requestId
 * are deduplicated by the challenge engine.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

describe("Idempotent Challenge", () => {
	test("same requestId returns same challengeId on repeated requests", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		const first = await client.requestAccess({ tierId: DEFAULT_TIER_ID, requestId });
		const second = await client.requestAccess({ tierId: DEFAULT_TIER_ID, requestId });
		const third = await client.requestAccess({ tierId: DEFAULT_TIER_ID, requestId });

		expect(first.challengeId).toBe(second.challengeId);
		expect(second.challengeId).toBe(third.challengeId);

		// Payment requirements must be identical
		expect(first.paymentRequired.accepts[0]?.amount).toBe(
			second.paymentRequired.accepts[0]?.amount,
		);
		expect(first.paymentRequired.accepts[0]?.payTo).toBe(
			second.paymentRequired.accepts[0]?.payTo,
		);
	});

	test("different requestIds create distinct challenges", async () => {
		const client = makeClientE2eClient();

		const first = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId: crypto.randomUUID(),
		});
		const second = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId: crypto.randomUUID(),
		});

		expect(first.challengeId).not.toBe(second.challengeId);
	});
});
