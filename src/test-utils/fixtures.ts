import type { AccessRequest, ChallengeRecord, SellerConfig } from "../types/index.js";

const DEFAULT_WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;
const DEFAULT_SECRET = "a-very-long-secret-that-is-at-least-32-characters!";

/**
 * Create a test ChallengeRecord with sensible defaults.
 */
export function makeChallengeRecord(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
	return {
		challengeId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		clientAgentId: "agent://test",
		resourceId: "photo-42",
		tierId: "single",
		amount: "$0.10",
		amountRaw: 100000n,
		asset: "USDC",
		chainId: 84532,
		destination: DEFAULT_WALLET,
		state: "PENDING",
		expiresAt: new Date(Date.now() + 900_000),
		createdAt: new Date(),
		...overrides,
	};
}

/**
 * Create a test SellerConfig with sensible defaults.
 */
export function makeSellerConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test agent for unit tests",
		agentUrl: "https://agent.example.com",
		providerName: "Test Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: DEFAULT_WALLET,
		network: "testnet",
		products: [{ tierId: "single", label: "Single Photo", amount: "$0.10", resourceType: "photo" }],
		onIssueToken: async () => ({ token: "test-token", expiresAt: new Date() }),
		onVerifyResource: async () => true,
		...overrides,
	};
}

/**
 * Create a test AccessRequest with sensible defaults.
 */
export function makeAccessRequest(overrides?: Partial<AccessRequest>): AccessRequest {
	return {
		requestId: crypto.randomUUID(),
		resourceId: "photo-42",
		tierId: "single",
		clientAgentId: "agent://buyer",
		...overrides,
	};
}
