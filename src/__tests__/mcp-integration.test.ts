import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChallengeEngine } from "../core/challenge-engine.js";
import { buildHttpPaymentRequirements } from "../integrations/settlement.js";
import { MockPaymentAdapter } from "../test-utils/index.js";
import { TestChallengeStore, TestSeenTxStore } from "../test-utils/stores.js";
import { Key0Error } from "../types/errors.js";
import type { SellerConfig, X402PaymentPayload } from "../types/index.js";

// ---------------------------------------------------------------------------
// Module-level mock for settlePayment.
// buildHttpPaymentRequirements is imported before mocking so mcp.ts can use
// the real implementation (the mock only replaces settlePayment).
// ---------------------------------------------------------------------------

type SettlePaymentImpl = (payload: X402PaymentPayload) => Promise<{
	txHash: `0x${string}`;
	settleResponse: { success: boolean; transaction: string; network: string };
	payer?: string;
}>;

let settlePaymentImpl: SettlePaymentImpl = async () => ({
	txHash: `0x${"cc".repeat(32)}` as `0x${string}`,
	settleResponse: { success: true, transaction: `0x${"cc".repeat(32)}`, network: "eip155:84532" },
	payer: `0x${"aa".repeat(20)}`,
});

mock.module("../integrations/settlement.js", () => ({
	settlePayment: (payload: X402PaymentPayload) => settlePaymentImpl(payload),
	buildHttpPaymentRequirements,
}));

// Import createMcpServer AFTER the mock is registered so it picks up the mocked module.
const { createMcpServer } = await import("../integrations/mcp.js");

// ---------------------------------------------------------------------------
// Factory helpers (matching project conventions)
// ---------------------------------------------------------------------------

const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;
const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";

function makeConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test description",
		agentUrl: "https://agent.example.com",
		providerName: "Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		plans: [
			{ planId: "basic", unitAmount: "$0.99" },
			{ planId: "premium", unitAmount: "$4.99" },
		],
		challengeTTLSeconds: 900,
		fetchResourceCredentials: async (params) => {
			const { AccessTokenIssuer } = await import("../core/access-token.js");
			const issuer = new AccessTokenIssuer(SECRET);
			return issuer.sign(
				{
					sub: params.requestId,
					jti: params.challengeId,
					resourceId: params.resourceId,
					planId: params.planId,
					txHash: params.txHash,
				},
				3600,
			);
		},
		...overrides,
	};
}

function makeEngine(opts?: {
	config?: Partial<SellerConfig>;
	adapter?: MockPaymentAdapter;
	store?: TestChallengeStore;
	seenTxStore?: TestSeenTxStore;
}) {
	const adapter = opts?.adapter ?? new MockPaymentAdapter();
	const store = opts?.store ?? new TestChallengeStore();
	const seenTxStore = opts?.seenTxStore ?? new TestSeenTxStore();
	const config = makeConfig(opts?.config);
	const engine = new ChallengeEngine({ config, store, seenTxStore, adapter });
	return { engine, adapter, store, seenTxStore, config };
}

/** Minimal valid X402PaymentPayload for tests. */
function makePaymentPayload(overrides?: Partial<X402PaymentPayload>): X402PaymentPayload {
	return {
		x402Version: 2,
		network: "eip155:84532",
		payload: {
			signature: `0x${"dd".repeat(32)}`,
			authorization: {
				from: `0x${"aa".repeat(20)}`,
				to: WALLET,
				value: "990000",
				validAfter: "0",
				validBefore: "9999999999",
				nonce: `0x${"ee".repeat(32)}`,
			},
		},
		...overrides,
	};
}

/**
 * Call a registered tool on the McpServer by reaching into the internal tool registry.
 * The MCP SDK stores tools in _registeredTools as a plain object keyed by tool name,
 * each entry having a `.handler(args, extra)` method.
 * This avoids the full MCP transport stack while still exercising the handler logic.
 */
async function callTool(
	server: ReturnType<typeof createMcpServer>,
	toolName: string,
	args: Record<string, unknown>,
	meta?: Record<string, unknown>,
) {
	type ToolEntry = { handler: (args: unknown, extra: unknown) => Promise<unknown> };
	const tools = (server as unknown as { _registeredTools: Record<string, ToolEntry> })
		._registeredTools;
	const tool = tools[toolName];
	if (!tool) throw new Error(`Tool "${toolName}" not found`);
	return tool.handler(args, meta !== undefined ? { _meta: meta } : undefined);
}

// ---------------------------------------------------------------------------
// discover_plans tool
// ---------------------------------------------------------------------------

describe("createMcpServer — discover_plans tool", () => {
	test("returns product catalog with agent metadata", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "discover", {})) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");

		const catalog = JSON.parse(result.content[0]!.text);
		expect(catalog.agentName).toBe("Test Agent");
		expect(catalog.chainId).toBe(84532);
		expect(catalog.walletAddress).toBe(WALLET);
		expect(catalog.plans).toHaveLength(2);
		expect(catalog.plans[0].planId).toBe("basic");
		expect(catalog.plans[0].unitAmount).toBe("$0.99");
		expect(catalog.plans[1].planId).toBe("premium");
	});

	test("does not require payment — no isError flag", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "discover", {})) as Record<string, unknown>;
		expect(result["isError"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildPaymentRequiredResult — tested indirectly via request_access (no payment)
// ---------------------------------------------------------------------------

describe("createMcpServer — buildPaymentRequiredResult shape (x402 spec conformance)", () => {
	test("returns isError:true with structuredContent and content text when no payment provided", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "access", {
			planId: "basic",
			resourceId: "resource-1",
		})) as {
			isError: true;
			structuredContent: Record<string, unknown>;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeDefined();
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
	});

	test("structuredContent contains x402Version, accepts, resource, and error fields", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "access", {
			planId: "basic",
			resourceId: "resource-1",
		})) as {
			structuredContent: Record<string, unknown>;
		};

		const sc = result.structuredContent;
		expect(sc["x402Version"]).toBe(2);
		expect(sc["error"]).toBe("Payment required to access this resource");
		expect(sc["accepts"]).toBeDefined();
		expect(Array.isArray(sc["accepts"])).toBe(true);
		expect(sc["resource"]).toBeDefined();
		// resource.url must point to the x402 access endpoint
		const resource = sc["resource"] as { url: string; mimeType: string };
		expect(resource.url).toBe("https://agent.example.com/x402/access");
		expect(resource.mimeType).toBe("application/json");
	});

	test("accepts[0] contains scheme, network, asset, amount, and payTo", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "access", {
			planId: "basic",
			resourceId: "default",
		})) as {
			structuredContent: { accepts: Array<Record<string, unknown>> };
		};

		const accept = result.structuredContent.accepts[0]!;
		expect(accept["scheme"]).toBe("exact");
		expect(accept["network"]).toBe("eip155:84532");
		expect(typeof accept["asset"]).toBe("string");
		expect(typeof accept["amount"]).toBe("string");
		expect(accept["payTo"]).toBe(WALLET);
	});

	test("content[0].text is parseable JSON and includes x402PaymentUrl", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "access", {
			planId: "basic",
			resourceId: "default",
		})) as {
			content: Array<{ type: string; text: string }>;
		};

		const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
		expect(parsed["x402PaymentUrl"]).toBe("https://agent.example.com/x402/access");
		expect(typeof parsed["paymentInstructions"]).toBe("string");
	});

	test("returns TIER_NOT_FOUND error (not payment-required) for unknown planId", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(server, "access", {
			planId: "nonexistent",
			resourceId: "default",
		})) as {
			isError: true;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0]!.text) as { code: string };
		expect(body.code).toBe("TIER_NOT_FOUND");
	});
});

// ---------------------------------------------------------------------------
// extractPaymentFromMeta — tested indirectly via request_access
// ---------------------------------------------------------------------------

describe("createMcpServer — extractPaymentFromMeta (via request_access)", () => {
	test("no _meta → treated as no payment, returns PaymentRequired result", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			// no _meta passed — extra is undefined
		)) as { isError: boolean };

		expect(result.isError).toBe(true);
	});

	test("_meta without x402/payment key → treated as no payment", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ unrelated: "data" },
		)) as { isError: boolean };

		expect(result.isError).toBe(true);
	});

	test("_meta with x402/payment that is not an object → treated as no payment", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		// String value is not an object — extractPaymentFromMeta returns undefined
		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": "not-an-object" },
		)) as { isError: boolean };

		expect(result.isError).toBe(true);
	});

	test("_meta with malformed x402/payment object → propagates INVALID_REQUEST Key0Error", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		// Object present but fails Zod schema (x402Version must be a number, payload required)
		// extractPaymentFromMeta is called OUTSIDE the try/catch in the tool handler,
		// so Key0Error propagates directly as a thrown error.
		const err = await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{
				"x402/payment": {
					x402Version: "not-a-number",
				},
			},
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Key0Error);
		expect((err as Key0Error).code).toBe("INVALID_REQUEST");
		expect((err as Key0Error).httpStatus).toBe(400);
	});

	test("_meta with valid but missing optional fields is accepted", async () => {
		// A minimal valid payload (x402Version number, network string, payload object)
		// should parse successfully and proceed to settlement
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		settlePaymentImpl = async () => ({
			txHash: `0x${"cc".repeat(32)}` as `0x${string}`,
			settleResponse: {
				success: true,
				transaction: `0x${"cc".repeat(32)}`,
				network: "eip155:84532",
			},
			payer: `0x${"aa".repeat(20)}`,
		});

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{
				"x402/payment": {
					x402Version: 2,
					network: "eip155:84532",
					payload: { signature: `0x${"dd".repeat(32)}` },
				},
			},
		)) as Record<string, unknown>;

		// No isError → successful grant
		expect(result["isError"]).toBeUndefined();
		const body = JSON.parse((result["content"] as Array<{ text: string }>)[0]!.text) as {
			status: string;
		};
		expect(body.status).toBe("access_granted");
	});
});

// ---------------------------------------------------------------------------
// request_access — happy path (full PENDING → PAID → DELIVERED)
// ---------------------------------------------------------------------------

describe("createMcpServer — request_access happy path", () => {
	beforeEach(() => {
		settlePaymentImpl = async () => ({
			txHash: `0x${"cc".repeat(32)}` as `0x${string}`,
			settleResponse: {
				success: true,
				transaction: `0x${"cc".repeat(32)}`,
				network: "eip155:84532",
			},
			payer: `0x${"aa".repeat(20)}`,
		});
	});

	test("with valid payment in _meta → returns access_granted and _meta[x402/payment-response]", async () => {
		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			content: Array<{ type: string; text: string }>;
			_meta: Record<string, unknown>;
		};

		expect(result._meta?.["x402/payment-response"]).toBeDefined();

		const body = JSON.parse(result.content[0]!.text) as {
			status: string;
			accessToken: string;
			tokenType: string;
		};
		expect(body.status).toBe("access_granted");
		expect(typeof body.accessToken).toBe("string");
		expect(body.tokenType).toBe("Bearer");
	});

	test("challenge record reaches DELIVERED state after successful payment", async () => {
		const store = new TestChallengeStore();
		const { engine, config } = makeEngine({ store });
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			content: Array<{ type: string; text: string }>;
		};

		const body = JSON.parse(result.content[0]!.text) as { challengeId: string };
		const record = await store.get(body.challengeId);
		expect(record).toBeDefined();
		expect(record!.state).toBe("DELIVERED");
		expect(record!.txHash).toBeDefined();
		expect(record!.accessGrant).toBeDefined();
	});

	test("deriveRequestId produces the same requestId for the same payment signature (idempotency)", async () => {
		const store = new TestChallengeStore();
		const { engine, config } = makeEngine({ store });
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		// First call — creates and delivers with txHash A
		const txHashA = `0x${"11".repeat(32)}` as `0x${string}`;
		settlePaymentImpl = async () => ({
			txHash: txHashA,
			settleResponse: { success: true, transaction: txHashA, network: "eip155:84532" },
			payer: `0x${"aa".repeat(20)}`,
		});

		const r1 = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as { content: Array<{ text: string }> };

		const body1 = JSON.parse(r1.content[0]!.text) as { challengeId: string };

		// Second call with identical payment payload (same signature → same requestId),
		// but settle returns a different txHash so the seenTxStore double-spend guard
		// does not fire before processHttpPayment checks the existing DELIVERED record.
		const txHashB = `0x${"22".repeat(32)}` as `0x${string}`;
		settlePaymentImpl = async () => ({
			txHash: txHashB,
			settleResponse: { success: true, transaction: txHashB, network: "eip155:84532" },
			payer: `0x${"aa".repeat(20)}`,
		});

		const r2 = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as { content: Array<{ text: string }> };

		const body2 = JSON.parse(r2.content[0]!.text) as {
			status: string;
			note?: string;
			challengeId: string;
		};
		// Idempotent: same challenge, returns cached grant
		expect(body2.status).toBe("access_granted");
		expect(body2.challengeId).toBe(body1.challengeId);
	});

	test("fetchResourceCredentials return value becomes the accessToken in the grant", async () => {
		const { engine, config } = makeEngine({
			config: {
				fetchResourceCredentials: async (params) => ({
					token: `custom-tok-${params.challengeId}`,
					tokenType: "Bearer",
				}),
			},
		});
		const server = createMcpServer(engine, config);

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": makePaymentPayload() },
		)) as { content: Array<{ text: string }> };

		const body = JSON.parse(result.content[0]!.text) as {
			status: string;
			accessToken: string;
		};
		expect(body.status).toBe("access_granted");
		expect(body.accessToken).toMatch(/^custom-tok-/);
	});
});

// ---------------------------------------------------------------------------
// request_access — PROOF_ALREADY_REDEEMED returns cached grant
// ---------------------------------------------------------------------------

describe("createMcpServer — PROOF_ALREADY_REDEEMED handling", () => {
	beforeEach(() => {
		settlePaymentImpl = async () => ({
			txHash: `0x${"cc".repeat(32)}` as `0x${string}`,
			settleResponse: {
				success: true,
				transaction: `0x${"cc".repeat(32)}`,
				network: "eip155:84532",
			},
			payer: `0x${"aa".repeat(20)}`,
		});
	});

	test("second call with same requestId but different txHash returns cached grant without isError", async () => {
		// When the same EIP-3009 signature is resubmitted (same requestId from deriveRequestId),
		// but the facilitator already settled with a different txHash, the engine's
		// PROOF_ALREADY_REDEEMED guard fires and the handler returns the cached grant.
		const txHashA = `0x${"11".repeat(32)}` as `0x${string}`;
		settlePaymentImpl = async () => ({
			txHash: txHashA,
			settleResponse: { success: true, transaction: txHashA, network: "eip155:84532" },
			payer: `0x${"aa".repeat(20)}`,
		});

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		// First call succeeds with txHashA
		await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		);

		// Second call: same payment signature → same requestId (DELIVERED record found).
		// Use a different txHash so the seenTxStore guard doesn't fire first.
		const txHashB = `0x${"22".repeat(32)}` as `0x${string}`;
		settlePaymentImpl = async () => ({
			txHash: txHashB,
			settleResponse: { success: true, transaction: txHashB, network: "eip155:84532" },
			payer: `0x${"aa".repeat(20)}`,
		});

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};

		expect(result.isError).toBeUndefined();
		const body = JSON.parse(result.content[0]!.text) as {
			status: string;
			note: string;
		};
		expect(body.status).toBe("access_granted");
		expect(body.note).toContain("cached");
	});
});

// ---------------------------------------------------------------------------
// Payment-failed error handler re-wrapping logic (lines 263-285)
// ---------------------------------------------------------------------------

describe("createMcpServer — payment-failed error re-wrapping", () => {
	test("PAYMENT_FAILED error returns isError:true with structuredContent overriding error field", async () => {
		settlePaymentImpl = async () => {
			throw new Key0Error("PAYMENT_FAILED", "insufficient_funds", 402);
		};

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			isError: true;
			structuredContent: Record<string, unknown>;
			content: Array<{ text: string }>;
		};

		expect(result.isError).toBe(true);
		// structuredContent.error is overridden with the specific failure message
		expect(result.structuredContent["error"]).toBe("insufficient_funds");
		// x402 fields are still present
		expect(result.structuredContent["x402Version"]).toBe(2);
		expect(result.structuredContent["accepts"]).toBeDefined();

		// content[0].text mirrors structuredContent
		const body = JSON.parse(result.content[0]!.text) as { error: string; x402Version: number };
		expect(body.error).toBe("insufficient_funds");
		expect(body.x402Version).toBe(2);
	});

	test("402 httpStatus error (non-PAYMENT_FAILED code) is also re-wrapped as payment-required", async () => {
		settlePaymentImpl = async () => {
			throw new Key0Error("PAYMENT_FAILED", "nonce_consumed", 402);
		};

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			isError: true;
			structuredContent: { error: string; x402Version: number };
		};

		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe("nonce_consumed");
		expect(result.structuredContent.x402Version).toBe(2);
	});

	test("structuredContent is a plain object spread (not nested under error key)", async () => {
		settlePaymentImpl = async () => {
			throw new Key0Error("PAYMENT_FAILED", "signature_mismatch", 402);
		};

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": makePaymentPayload() },
		)) as {
			structuredContent: Record<string, unknown>;
		};

		// The top-level structuredContent must not be nested under an "error" sub-object
		expect(typeof result.structuredContent["error"]).toBe("string");
		expect(result.structuredContent["accepts"]).toBeDefined();
		expect((result.structuredContent as { error: Record<string, unknown> }).error).not.toBeTypeOf(
			"object",
		);
	});

	test("non-PAYMENT_FAILED Key0Error is returned as generic isError result with toJSON", async () => {
		settlePaymentImpl = async () => {
			throw new Key0Error("CHAIN_MISMATCH", "Chain mismatch on settlement", 400);
		};

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		)) as {
			isError: true;
			content: Array<{ text: string }>;
		};

		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0]!.text) as { code: string; message: string };
		expect(body.code).toBe("CHAIN_MISMATCH");
		expect(body.message).toBe("Chain mismatch on settlement");
	});

	test("non-Key0Error is re-thrown (not swallowed)", async () => {
		settlePaymentImpl = async () => {
			throw new TypeError("unexpected internal error");
		};

		const { engine, config } = makeEngine();
		const server = createMcpServer(engine, config);
		const payment = makePaymentPayload();

		const err = await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": payment },
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(TypeError);
		expect((err as TypeError).message).toBe("unexpected internal error");
	});
});

// ---------------------------------------------------------------------------
// double-spend guard via request_access
// ---------------------------------------------------------------------------

describe("createMcpServer — double-spend guard", () => {
	test("same txHash returned by settlePayment twice is rejected on second call (TX_ALREADY_REDEEMED)", async () => {
		const fixedTxHash = `0x${"aa".repeat(32)}` as `0x${string}`;
		settlePaymentImpl = async () => ({
			txHash: fixedTxHash,
			settleResponse: { success: true, transaction: fixedTxHash, network: "eip155:84532" },
			payer: `0x${"bb".repeat(20)}`,
		});

		// Share state (store + seenTxStore) between two calls
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const { engine, config } = makeEngine({ store, seenTxStore });
		const server = createMcpServer(engine, config);

		// First call — different signature, different requestId → new challenge
		const firstPayment = makePaymentPayload({ payload: { signature: `0x${"11".repeat(32)}` } });
		await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": firstPayment },
		);

		// Second call — different signature (different requestId), but same txHash from settle
		const secondPayment = makePaymentPayload({ payload: { signature: `0x${"22".repeat(32)}` } });
		const result = (await callTool(
			server,
			"access",
			{ planId: "basic", resourceId: "default" },
			{ "x402/payment": secondPayment },
		)) as {
			isError: true;
			content: Array<{ text: string }>;
		};

		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0]!.text) as { code: string };
		expect(body.code).toBe("TX_ALREADY_REDEEMED");
	});
});
