import { describe, expect, test } from "bun:test";
import { MockPaymentAdapter } from "../../test-utils";
import { TestChallengeStore, TestSeenTxStore } from "../../test-utils/stores.js";
import { type AccessRequest, Key0Error, type PaymentProof, type SellerConfig } from "../../types";
import { ChallengeEngine, type ChallengeEngineConfig } from "../challenge-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test",
		agentUrl: "https://agent.example.com",
		providerName: "Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		plans: [{ planId: "single", unitAmount: "$0.10" }],
		challengeTTLSeconds: 900,
		fetchResourceCredentials: async (params) => ({
			token: `tok_${params.challengeId}`,
			tokenType: "Bearer",
		}),
		...overrides,
	};
}

function makeEngine(opts?: {
	config?: Partial<SellerConfig>;
	adapter?: MockPaymentAdapter;
	clock?: () => number;
	store?: TestChallengeStore;
	seenTxStore?: TestSeenTxStore;
}) {
	const adapter = opts?.adapter ?? new MockPaymentAdapter();
	const store = opts?.store ?? new TestChallengeStore();
	const seenTxStore = opts?.seenTxStore ?? new TestSeenTxStore();
	const config = makeConfig(opts?.config);

	const engineConfig: ChallengeEngineConfig = {
		config,
		store,
		seenTxStore,
		adapter,
		...(opts?.clock ? { clock: opts.clock } : {}),
	};

	return { engine: new ChallengeEngine(engineConfig), adapter, store, seenTxStore };
}

function makeRequest(overrides?: Partial<AccessRequest>): AccessRequest {
	return {
		requestId: crypto.randomUUID(),
		resourceId: "photo-42",
		planId: "single",
		clientAgentId: "agent://test-client",
		...overrides,
	};
}

function makeTxHash(): `0x${string}` {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChallengeEngine.requestAccess", () => {
	test("happy path: returns X402Challenge", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		expect(challenge.type).toBe("X402Challenge");
		expect(challenge.requestId).toBe(req.requestId);
		expect(challenge.planId).toBe("single");
		expect(challenge.amount).toBe("$0.10");
		expect(challenge.asset).toBe("USDC");
		expect(challenge.chainId).toBe(84532);
		expect(challenge.destination).toBe(WALLET);
		expect(challenge.resourceVerified).toBe(true);
	});

	test("idempotency: same requestId returns same challenge", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const c1 = await engine.requestAccess(req);
		const c2 = await engine.requestAccess(req);
		expect(c1.challengeId).toBe(c2.challengeId);
	});

	test("tier not found: throws TIER_NOT_FOUND", async () => {
		const { engine } = makeEngine();
		const req = makeRequest({ planId: "nonexistent" });
		try {
			await engine.requestAccess(req);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("TIER_NOT_FOUND");
		}
	});

	test("invalid requestId: throws INVALID_REQUEST", async () => {
		const { engine } = makeEngine();
		const req = makeRequest({ requestId: "not-a-uuid" });
		try {
			await engine.requestAccess(req);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("INVALID_REQUEST");
		}
	});

	test("expired challenge for same requestId → new challenge", async () => {
		let now = Date.now();
		const { engine } = makeEngine({ clock: () => now });
		const req = makeRequest();

		const c1 = await engine.requestAccess(req);

		// Advance time past challenge TTL (900s = 15 min)
		now += 901_000;

		const c2 = await engine.requestAccess(req);
		expect(c2.challengeId).not.toBe(c1.challengeId);
	});
});

describe("ChallengeEngine.submitProof", () => {
	test("happy path: returns AccessGrant", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);
		const txHash = makeTxHash();

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		const grant = await engine.submitProof(proof);
		expect(grant.type).toBe("AccessGrant");
		expect(grant.challengeId).toBe(challenge.challengeId);
		expect(grant.requestId).toBe(req.requestId);
		expect(grant.txHash).toBe(txHash);
		expect(grant.tokenType).toBe("Bearer");
		expect(grant.accessToken).toBeTypeOf("string");
		expect(grant.resourceEndpoint).toContain("photo-42");
	});

	test("expired challenge: throws CHALLENGE_EXPIRED", async () => {
		let now = Date.now();
		const { engine } = makeEngine({ clock: () => now });
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		// Advance past expiry
		now += 901_000;

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("CHALLENGE_EXPIRED");
		}
	});

	test("expired challenge fires onChallengeExpired hook", async () => {
		let now = Date.now();
		let expiredId = "";
		const { engine } = makeEngine({
			clock: () => now,
			config: {
				onChallengeExpired: async (challengeId: string) => {
					expiredId = challengeId;
				},
			},
		});
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		// Advance past expiry
		now += 901_000;

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("CHALLENGE_EXPIRED");
		}

		// Wait for fire-and-forget hook
		await new Promise((r) => setTimeout(r, 10));
		expect(expiredId).toBe(challenge.challengeId);
	});

	test("chain mismatch: throws CHAIN_MISMATCH", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 8453, // mainnet, but engine is testnet
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("CHAIN_MISMATCH");
		}
	});

	test("amount mismatch: throws AMOUNT_MISMATCH", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.05", // underpayment
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("AMOUNT_MISMATCH");
		}
	});

	test("double-spend: same txHash for two challenges throws TX_ALREADY_REDEEMED", async () => {
		const { engine } = makeEngine();
		const txHash = makeTxHash();

		// First challenge + proof
		const req1 = makeRequest();
		const c1 = await engine.requestAccess(req1);
		const proof1: PaymentProof = {
			type: "PaymentProof",
			challengeId: c1.challengeId,
			requestId: req1.requestId,
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};
		await engine.submitProof(proof1);

		// Second challenge with same txHash
		const req2 = makeRequest();
		const c2 = await engine.requestAccess(req2);
		const proof2: PaymentProof = {
			type: "PaymentProof",
			challengeId: c2.challengeId,
			requestId: req2.requestId,
			chainId: 84532,
			txHash, // reuse same txHash
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof2);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("TX_ALREADY_REDEEMED");
		}
	});

	test("PROOF_ALREADY_REDEEMED: submitProof on DELIVERED challenge returns grant info", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);
		const txHash = makeTxHash();

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		// First submission succeeds
		await engine.submitProof(proof);

		// Second submission with different txHash should throw PROOF_ALREADY_REDEEMED
		const proof2: PaymentProof = {
			...proof,
			txHash: makeTxHash(),
		};

		try {
			await engine.submitProof(proof2);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			const agErr = err as Key0Error;
			expect(agErr.code).toBe("PROOF_ALREADY_REDEEMED");
			expect(agErr.httpStatus).toBe(200);
			expect(agErr.details?.["grant"]).toBeDefined();
		}
	});

	test("challenge not found: throws CHALLENGE_NOT_FOUND", async () => {
		const { engine } = makeEngine();

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: "nonexistent-challenge-id",
			requestId: crypto.randomUUID(),
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("CHALLENGE_NOT_FOUND");
		}
	});

	test("adapter verification failure: throws INVALID_PROOF", async () => {
		const adapter = new MockPaymentAdapter();
		adapter.setVerifyResult({
			verified: false,
			error: "Wrong recipient",
			errorCode: "WRONG_RECIPIENT",
		});

		const { engine } = makeEngine({ adapter });
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("INVALID_PROOF");
		}
	});

	test("TX_NOT_FOUND from adapter: throws TX_UNCONFIRMED", async () => {
		const adapter = new MockPaymentAdapter();
		adapter.setVerifyResult({
			verified: false,
			error: "Transaction not found",
			errorCode: "TX_NOT_FOUND",
		});

		const { engine } = makeEngine({ adapter });
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		try {
			await engine.submitProof(proof);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			const agErr = err as Key0Error;
			expect(agErr.code).toBe("TX_UNCONFIRMED");
			expect(agErr.httpStatus).toBe(202);
		}
	});
});

describe("ChallengeEngine.cancelChallenge", () => {
	test("cancels a PENDING challenge", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		await engine.cancelChallenge(challenge.challengeId);

		const record = await engine.getChallenge(challenge.challengeId);
		expect(record!.state).toBe("CANCELLED");
	});

	test("cannot cancel non-existent challenge", async () => {
		const { engine } = makeEngine();
		try {
			await engine.cancelChallenge("nonexistent");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("CHALLENGE_NOT_FOUND");
		}
	});

	test("cannot cancel PAID challenge", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		// Pay it
		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash: makeTxHash(),
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};
		await engine.submitProof(proof);

		try {
			await engine.cancelChallenge(challenge.challengeId);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Key0Error);
			expect((err as Key0Error).code).toBe("INVALID_REQUEST");
		}
	});
});

describe("ChallengeEngine.getChallenge", () => {
	test("returns challenge record", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();
		const challenge = await engine.requestAccess(req);

		const record = await engine.getChallenge(challenge.challengeId);
		expect(record).not.toBeNull();
		expect(record!.challengeId).toBe(challenge.challengeId);
		expect(record!.state).toBe("PENDING");
	});

	test("returns null for non-existent", async () => {
		const { engine } = makeEngine();
		expect(await engine.getChallenge("nonexistent")).toBeNull();
	});
});

describe("ChallengeEngine lifecycle", () => {
	test("full happy path: request → challenge → proof → grant → verify token", async () => {
		const { engine } = makeEngine();
		const req = makeRequest();

		// 1. Request access
		const challenge = await engine.requestAccess(req);
		expect(challenge.type).toBe("X402Challenge");

		// 2. Submit proof
		const txHash = makeTxHash();
		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: challenge.challengeId,
			requestId: req.requestId,
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://test-client",
		};

		const grant = await engine.submitProof(proof);
		expect(grant.type).toBe("AccessGrant");
		expect(grant.accessToken).toBeTypeOf("string");

		// 3. Verify the token was issued by our callback
		expect(grant.accessToken).toBe(`tok_${challenge.challengeId}`);
		expect(grant.txHash).toBe(txHash);

		// 4. Check challenge record is DELIVERED with accessGrant stored
		const record = await engine.getChallenge(challenge.challengeId);
		expect(record!.state).toBe("DELIVERED");
		expect(record!.accessGrant).toBeDefined();
		expect(record!.deliveredAt).toBeDefined();
	});
});
