/**
 * Happy Path State Verification — verifies storage state at each step of the payment lifecycle.
 *
 * Extends the basic happy-path test by asserting the challenge record state
 * after each phase: PENDING → PAID → DELIVERED, plus verifying stored fields
 * and the audit trail.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_ID } from "../fixtures/constants.ts";
import { key0WalletAddress, makeClientE2eClient } from "../fixtures/wallets.ts";
import { readAuditHistory, readChallengeRecord, readChallengeState } from "../helpers/storage-client.ts";

describe("Happy Path with State Verification", () => {
	test("challenge record transitions PENDING → DELIVERED with correct fields", async () => {
		const client = makeClientE2eClient();
		const requestId = crypto.randomUUID();

		// Step 1: Request access → PENDING
		const { challengeId, paymentRequired } = await client.requestAccess({
			tierId: DEFAULT_TIER_ID,
			requestId,
		});

		// Verify PENDING state in Redis
		const pendingState = await readChallengeState(challengeId);
		expect(pendingState).toBe("PENDING");

		const pendingRecord = await readChallengeRecord(challengeId);
		expect(pendingRecord).not.toBeNull();
		expect(pendingRecord!["requestId"]).toBe(requestId);
		expect(pendingRecord!["tierId"]).toBe(DEFAULT_TIER_ID);
		expect(pendingRecord!["destination"]).toBe(key0WalletAddress());
		expect(pendingRecord!["asset"]).toBe("USDC");
		expect(pendingRecord!["chainId"]).toBe("84532");

		// Step 2: Sign and submit payment → DELIVERED
		const requirements = paymentRequired.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		const result = await client.submitPayment({
			tierId: DEFAULT_TIER_ID,
			requestId,
			auth,
			paymentRequired,
		});

		expect(result.status).toBe(200);
		expect(result.grant).toBeDefined();

		// Verify DELIVERED state in Redis
		const deliveredState = await readChallengeState(challengeId);
		expect(deliveredState).toBe("DELIVERED");

		const deliveredRecord = await readChallengeRecord(challengeId);
		expect(deliveredRecord).not.toBeNull();
		expect(deliveredRecord!["txHash"]).toMatch(/^0x/);
		expect(deliveredRecord!["paidAt"]).toBeDefined();

		// Verify the grant fields
		const grant = result.grant!;
		expect(grant.type).toBe("AccessGrant");
		expect(grant.challengeId).toBe(challengeId);
		expect(grant.requestId).toBe(requestId);

		// resourceEndpoint should be present and non-empty
		expect(grant.resourceEndpoint).toBeDefined();
		expect(typeof grant.resourceEndpoint).toBe("string");
		expect(grant.resourceEndpoint.length).toBeGreaterThan(0);

		// explorerUrl should point to Base Sepolia and include the txHash
		expect(grant.explorerUrl).toBeDefined();
		expect(grant.explorerUrl).toContain("sepolia");
		expect(grant.explorerUrl).toContain(grant.txHash);

		// ── Audit trail verification ──────────────────────────────────────
		const auditEntries = await readAuditHistory(challengeId);

		// Expect at least 3 transitions: creation (null→PENDING), PENDING→PAID, PAID→DELIVERED
		expect(auditEntries.length).toBeGreaterThanOrEqual(3);

		// First entry: initial creation
		expect(auditEntries[0]!.challengeId).toBe(challengeId);
		expect(auditEntries[0]!.fromState).toBeNull();
		expect(auditEntries[0]!.toState).toBe("PENDING");

		// Last entry: final delivery
		const last = auditEntries[auditEntries.length - 1]!;
		expect(last.toState).toBe("DELIVERED");

		// Every entry should have a createdAt timestamp
		for (const entry of auditEntries) {
			expect(entry.createdAt).toBeDefined();
		}
	}, 120_000);
});
