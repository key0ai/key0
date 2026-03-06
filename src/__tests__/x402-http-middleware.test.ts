import { beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import { ChallengeEngine } from "../core/challenge-engine.js";
import {
	buildHttpPaymentRequirements,
	createX402HttpMiddleware,
	decodePaymentSignature,
	settleViaFacilitator,
} from "../integrations/x402-http-middleware.js";
import { MockPaymentAdapter } from "../test-utils/index.js";
import { TestChallengeStore, TestSeenTxStore } from "../test-utils/stores.js";
import { CHAIN_CONFIGS } from "../types/config-shared.js";
import type { SellerConfig } from "../types/index.js";

const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test",
		agentUrl: "https://agent.example.com",
		providerName: "Test Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		products: [
			{ tierId: "basic", label: "Basic Access", amount: "$0.99", resourceType: "api-call" },
			{ tierId: "premium", label: "Premium Access", amount: "$4.99", resourceType: "api-call" },
		],
		challengeTTLSeconds: 900,
		onVerifyResource: async (resourceId: string) => {
			return resourceId !== "nonexistent";
		},
		onIssueToken: async (params) => {
			const { AccessTokenIssuer } = await import("../core/access-token.js");
			const issuer = new AccessTokenIssuer(SECRET);
			return issuer.sign(
				{
					sub: params.requestId,
					jti: params.challengeId,
					resourceId: params.resourceId,
					tierId: params.tierId,
					txHash: params.txHash,
				},
				3600,
			);
		},
	};
}

function createMockRequest(body: any, headers: Record<string, string> = {}): Partial<Request> {
	return {
		body,
		headers: headers as any,
	};
}

function createMockResponse(): {
	res: Partial<Response>;
	statusCode: number;
	jsonData: any;
	nextCalled: boolean;
	headers: Record<string, string>;
} {
	let statusCode = 200;
	let jsonData: any = null;
	const nextCalled = false;
	const headers: Record<string, string> = {};

	const res = {
		status: function (code: number) {
			statusCode = code;
			return this;
		},
		json: function (data: any) {
			jsonData = data;
			return this;
		},
		send: function (_data: any) {
			return this;
		},
		setHeader: function (name: string, value: string) {
			headers[name] = value;
			return this;
		},
	};

	return {
		res: res as Partial<Response>,
		get statusCode() {
			return statusCode;
		},
		get jsonData() {
			return jsonData;
		},
		get headers() {
			return headers;
		},
		get nextCalled() {
			return nextCalled;
		},
	};
}

describe("x402-http-middleware", () => {
	describe("buildHttpPaymentRequirements", () => {
		test("should build correct payment requirements", () => {
			const config = makeConfig();
			const networkConfig = CHAIN_CONFIGS.testnet;

			const requirements = buildHttpPaymentRequirements("basic", "default", config, networkConfig);

			// v2 response structure
			expect(requirements.x402Version).toBe(2);
			expect(requirements.resource).toBeDefined();
			expect(requirements.resource.url).toBe("https://agent.example.com/a2a/jsonrpc");
			expect(requirements.resource.method).toBe("POST");

			// Payment requirements
			expect(requirements.accepts).toHaveLength(1);
			expect(requirements.accepts[0]?.scheme).toBe("exact");
			expect(requirements.accepts[0]?.network).toBe("eip155:84532"); // CAIP-2 format
			expect(requirements.accepts[0]?.asset).toBe(networkConfig.usdcAddress);
			expect(requirements.accepts[0]?.amount).toBe("990000"); // $0.99 USDC
			expect(requirements.accepts[0]?.payTo).toBe(WALLET);
			expect(requirements.accepts[0]?.maxTimeoutSeconds).toBe(300); // 5 minutes

			// EIP-712 domain parameters in extra field
			expect(requirements.accepts[0]?.extra).toBeDefined();
			expect(requirements.accepts[0]?.extra?.["name"]).toBe("USDC");
			expect(requirements.accepts[0]?.extra?.["version"]).toBe("2");
			expect(requirements.accepts[0]?.extra?.["description"]).toBe("Basic Access — $0.99 USDC");
		});

		test("should throw for invalid tier", () => {
			const config = makeConfig();
			const networkConfig = CHAIN_CONFIGS.testnet;

			expect(() =>
				buildHttpPaymentRequirements("invalid-tier", "default", config, networkConfig),
			).toThrow('Tier "invalid-tier" not found');
		});
	});

	describe("createX402HttpMiddleware", () => {
		let engine: ChallengeEngine;
		let config: SellerConfig;
		let middleware: ReturnType<typeof createX402HttpMiddleware>;

		beforeEach(() => {
			config = makeConfig();
			const store = new TestChallengeStore();
			const seenTxStore = new TestSeenTxStore();
			const adapter = new MockPaymentAdapter();

			engine = new ChallengeEngine({
				config,
				store,
				seenTxStore,
				adapter,
			});

			middleware = createX402HttpMiddleware(engine, config);
		});

		test("should pass through if X-A2A-Extensions header is present", async () => {
			const req = createMockRequest(
				{
					method: "message/send",
					params: {
						message: {
							parts: [
								{
									kind: "data",
									data: { type: "AccessRequest", requestId: "test", tierId: "basic" },
								},
							],
						},
					},
				},
				{
					"x-a2a-extensions":
						"https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2",
				},
			);

			let nextCalled = false;
			const next = (() => {
				nextCalled = true;
			}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(nextCalled).toBe(true);
		});

		test("should pass through if not message/send", async () => {
			const req = createMockRequest({
				method: "task/get",
				params: {},
			});

			let nextCalled = false;
			const next = (() => {
				nextCalled = true;
			}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(nextCalled).toBe(true);
		});

		test("should pass through if no AccessRequest in message parts", async () => {
			const req = createMockRequest({
				method: "message/send",
				params: {
					message: {
						parts: [{ kind: "data", data: { type: "SomethingElse" } }],
					},
				},
			});

			let nextCalled = false;
			const next = (() => {
				nextCalled = true;
			}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(nextCalled).toBe(true);
		});

		test("should return HTTP 402 for AccessRequest without X-Payment", async () => {
			const req = createMockRequest({
				method: "message/send",
				params: {
					message: {
						parts: [
							{
								kind: "data",
								data: {
									type: "AccessRequest",
									requestId: "req-123",
									tierId: "basic",
									resourceId: "default",
								},
							},
						],
					},
				},
			});

			const next = (() => {}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(mockRes.statusCode).toBe(402);
			expect(mockRes.jsonData.x402Version).toBe(2);
			expect(mockRes.jsonData.resource).toBeDefined();
			expect(mockRes.jsonData.accepts).toHaveLength(1);
			expect(mockRes.jsonData.accepts[0].amount).toBe("990000");

			// challengeId from PENDING record should be in the response
			expect(mockRes.jsonData.challengeId).toBeDefined();
			expect(mockRes.jsonData.challengeId).toMatch(/^http-/);

			// Check PAYMENT-REQUIRED header is set
			expect(mockRes.headers["payment-required"]).toBeDefined();
			const decodedHeader = JSON.parse(
				Buffer.from(mockRes.headers["payment-required"]!, "base64").toString(),
			);
			expect(decodedHeader.x402Version).toBe(2);
		});

		test("should return 404 for nonexistent resource", async () => {
			const req = createMockRequest({
				method: "message/send",
				params: {
					message: {
						parts: [
							{
								kind: "data",
								data: {
									type: "AccessRequest",
									requestId: "req-123",
									tierId: "basic",
									resourceId: "nonexistent",
								},
							},
						],
					},
				},
			});

			const next = (() => {}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(mockRes.statusCode).toBe(404);
			expect(mockRes.jsonData.code).toBe("RESOURCE_NOT_FOUND");
		});

		test("should return 400 for invalid tier", async () => {
			const req = createMockRequest({
				method: "message/send",
				params: {
					message: {
						parts: [
							{
								kind: "data",
								data: {
									type: "AccessRequest",
									requestId: "req-123",
									tierId: "invalid-tier",
									resourceId: "default",
								},
							},
						],
					},
				},
			});

			const next = (() => {}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(mockRes.statusCode).toBe(400);
			expect(mockRes.jsonData.code).toBe("TIER_NOT_FOUND");
		});

		test("should parse AccessRequest from text part", async () => {
			const req = createMockRequest({
				method: "message/send",
				params: {
					message: {
						parts: [
							{
								kind: "text",
								text: JSON.stringify({
									type: "AccessRequest",
									requestId: "req-123",
									tierId: "basic",
									resourceId: "default",
								}),
							},
						],
					},
				},
			});

			const next = (() => {}) as NextFunction;
			const mockRes = createMockResponse();

			await middleware(req as Request, mockRes.res as Response, next);

			expect(mockRes.statusCode).toBe(402);
			expect(mockRes.jsonData.x402Version).toBe(2);

			// Check PAYMENT-REQUIRED header is set
			expect(mockRes.headers["payment-required"]).toBeDefined();
		});
	});

	describe("settleViaFacilitator", () => {
		const mockPaymentPayload = {
			x402Version: 2,
			network: "eip155:84532",
			scheme: "exact",
			resource: {
				url: "https://agent.example.com/a2a/jsonrpc",
				method: "POST",
				description: "Access to default",
				mimeType: "application/json",
			},
			accepted: {
				scheme: "exact",
				network: "eip155:84532",
				asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				amount: "990000",
				payTo: WALLET,
				maxTimeoutSeconds: 300,
				extra: {
					name: "USD Coin",
					version: "2",
					description: "Basic Access — $0.99 USDC",
				},
			},
			payload: {
				authorization: {
					from: "0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602",
					to: WALLET,
					value: "990000",
					validAfter: "1772381880",
					validBefore: "1772382780",
					nonce: "0x9619f59ab4f70da600b4e77023d5620da5f5d6072fdd1e94fb8ea593d7f61532",
				},
				signature: "0x1234",
			},
		};

		test("should verify and settle payment successfully", async () => {
			const mockTxHash = `0x${"ab".repeat(32)}` as `0x${string}`;

			// Mock fetch for verify and settle
			const originalFetch = globalThis.fetch;
			const fetchCalls: Array<{ url: string; body: any }> = [];

			(globalThis as any).fetch = async (url: string | URL | Request, options?: any) => {
				const urlString =
					typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
				const body = options?.body ? JSON.parse(options.body) : null;
				fetchCalls.push({ url: urlString, body });

				if (urlString.endsWith("/verify")) {
					return new Response(
						JSON.stringify({
							isValid: true,
							payer: "0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (urlString.endsWith("/settle")) {
					return new Response(
						JSON.stringify({
							success: true,
							transaction: mockTxHash,
							network: "eip155:84532",
							payer: "0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("Not found", { status: 404 });
			};

			try {
				const result = await settleViaFacilitator(
					mockPaymentPayload,
					"https://facilitator.example.com",
				);

				expect(result.txHash).toBe(mockTxHash as `0x${string}`);
				expect(result.payer).toBe("0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602");
				expect(result.settleResponse.success).toBe(true);

				// Verify both endpoints were called
				expect(fetchCalls).toHaveLength(2);
				expect(fetchCalls[0]?.url).toBe("https://facilitator.example.com/verify");
				expect(fetchCalls[1]?.url).toBe("https://facilitator.example.com/settle");

				// Verify request body format
				expect(fetchCalls[0]?.body).toHaveProperty("paymentPayload");
				expect(fetchCalls[0]?.body).toHaveProperty("paymentRequirements");
				expect(fetchCalls[0]?.body.paymentPayload).toEqual(mockPaymentPayload);
				expect(fetchCalls[0]?.body.paymentRequirements).toEqual(mockPaymentPayload.accepted);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		test("should throw error if verification fails", async () => {
			const originalFetch = globalThis.fetch;
			(globalThis as any).fetch = async (url: string | URL | Request) => {
				const urlString =
					typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

				if (urlString.endsWith("/verify")) {
					return new Response(
						JSON.stringify({
							isValid: false,
							invalidReason: "insufficient_funds",
							payer: "0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("Not found", { status: 404 });
			};

			try {
				await expect(
					settleViaFacilitator(mockPaymentPayload, "https://facilitator.example.com"),
				).rejects.toThrow("insufficient_funds");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		test("should throw error if verify endpoint returns non-2xx", async () => {
			const originalFetch = globalThis.fetch;
			(globalThis as any).fetch = async (url: string | URL | Request) => {
				const urlString =
					typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

				if (urlString.endsWith("/verify")) {
					return new Response(JSON.stringify({ error: "Invalid request" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}

				return new Response("Not found", { status: 404 });
			};

			try {
				await expect(
					settleViaFacilitator(mockPaymentPayload, "https://facilitator.example.com"),
				).rejects.toThrow("Invalid request");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		test("should throw error if settle endpoint fails", async () => {
			const originalFetch = globalThis.fetch;
			(globalThis as any).fetch = async (url: string | URL | Request) => {
				const urlString =
					typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

				if (urlString.endsWith("/verify")) {
					return new Response(
						JSON.stringify({
							isValid: true,
							payer: "0x50c773eAC96Fb0A64D437228156b2DA2f5e9e602",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (urlString.endsWith("/settle")) {
					return new Response(
						JSON.stringify({
							success: false,
							errorReason: "transaction_failed",
							transaction: "",
							network: "eip155:84532",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response("Not found", { status: 404 });
			};

			try {
				await expect(
					settleViaFacilitator(mockPaymentPayload, "https://facilitator.example.com"),
				).rejects.toThrow("transaction_failed");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		test("should throw error for invalid payment signature", async () => {
			const invalidSignature = "not-valid-base64";

			await expect(
				Promise.resolve().then(() => decodePaymentSignature(invalidSignature)),
			).rejects.toThrow("Invalid PAYMENT-SIGNATURE header");
		});
	});

	describe("ChallengeEngine.requestHttpAccess", () => {
		let engine: ChallengeEngine;
		let config: SellerConfig;
		let store: TestChallengeStore;

		beforeEach(() => {
			config = makeConfig();
			store = new TestChallengeStore();
			const seenTxStore = new TestSeenTxStore();
			const adapter = new MockPaymentAdapter();

			engine = new ChallengeEngine({
				config,
				store,
				seenTxStore,
				adapter,
			});
		});

		test("should create PENDING record and return challengeId", async () => {
			const result = await engine.requestHttpAccess("req-1", "basic", "default");

			expect(result.challengeId).toMatch(/^http-/);
			const record = await store.get(result.challengeId);
			expect(record).toBeDefined();
			expect(record!.state).toBe("PENDING");
			expect(record!.requestId).toBe("req-1");
			expect(record!.tierId).toBe("basic");
			expect(record!.clientAgentId).toBe("x402-http");
		});

		test("should return same challengeId for idempotent request", async () => {
			const first = await engine.requestHttpAccess("req-1", "basic", "default");
			const second = await engine.requestHttpAccess("req-1", "basic", "default");

			expect(second.challengeId).toBe(first.challengeId);
		});

		test("should reject invalid tier", async () => {
			await expect(engine.requestHttpAccess("req-1", "invalid-tier", "default")).rejects.toThrow(
				'Tier "invalid-tier" not found',
			);
		});

		test("should reject nonexistent resource", async () => {
			await expect(engine.requestHttpAccess("req-1", "basic", "nonexistent")).rejects.toThrow(
				'Resource "nonexistent" not found',
			);
		});
	});

	describe("ChallengeEngine.processHttpPayment", () => {
		let engine: ChallengeEngine;
		let config: SellerConfig;
		let store: TestChallengeStore;
		let seenTxStore: TestSeenTxStore;

		beforeEach(() => {
			config = makeConfig();
			store = new TestChallengeStore();
			seenTxStore = new TestSeenTxStore();
			const adapter = new MockPaymentAdapter();

			engine = new ChallengeEngine({
				config,
				store,
				seenTxStore,
				adapter,
			});
		});

		test("should process payment and return AccessGrant", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			const grant = await engine.processHttpPayment("req-1", "basic", "default", txHash);

			expect(grant.type).toBe("AccessGrant");
			expect(grant.tierId).toBe("basic");
			expect(grant.resourceId).toBe("default");
			expect(grant.txHash).toBe(txHash);
			expect(grant.accessToken).toBeDefined();
			expect(grant.tokenType).toBe("Bearer");
		});

		test("should create PENDING record, transition to PAID then DELIVERED", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			const payer = `0x${"aa".repeat(20)}` as `0x${string}`;

			const grant = await engine.processHttpPayment("req-1", "basic", "default", txHash, payer);

			const record = await store.get(grant.challengeId);
			expect(record).toBeDefined();
			expect(record!.state).toBe("DELIVERED");
			expect(record!.txHash).toBe(txHash);
			expect(record!.fromAddress).toBe(payer);
			expect(record!.paidAt).toBeDefined();
			expect(record!.deliveredAt).toBeDefined();
			expect(record!.accessGrant).toBeDefined();
		});

		test("should use existing PENDING record from requestHttpAccess", async () => {
			const { challengeId } = await engine.requestHttpAccess("req-1", "basic", "default");
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			const payer = `0x${"aa".repeat(20)}` as `0x${string}`;

			const grant = await engine.processHttpPayment("req-1", "basic", "default", txHash, payer);

			expect(grant.challengeId).toBe(challengeId);
			const record = await store.get(challengeId);
			expect(record!.state).toBe("DELIVERED");
		});

		test("should auto-create PENDING record if step 1 was skipped", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			const grant = await engine.processHttpPayment("req-skip", "basic", "default", txHash);

			const record = await store.get(grant.challengeId);
			expect(record).toBeDefined();
			expect(record!.state).toBe("DELIVERED");
			expect(record!.requestId).toBe("req-skip");
		});

		test("should leave record as PAID when onIssueToken throws", async () => {
			const failConfig: SellerConfig = {
				...config,
				onIssueToken: async () => {
					throw new Error("Token issuance failed");
				},
			};
			const failStore = new TestChallengeStore();
			const failSeenTx = new TestSeenTxStore();
			const failEngine = new ChallengeEngine({
				config: failConfig,
				store: failStore,
				seenTxStore: failSeenTx,
				adapter: new MockPaymentAdapter(),
			});

			const { challengeId } = await failEngine.requestHttpAccess("req-fail", "basic", "default");
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			const payer = `0x${"bb".repeat(20)}` as `0x${string}`;

			await expect(
				failEngine.processHttpPayment("req-fail", "basic", "default", txHash, payer),
			).rejects.toThrow("Token issuance failed");

			const record = await failStore.get(challengeId);
			expect(record).toBeDefined();
			expect(record!.state).toBe("PAID");
			expect(record!.txHash).toBe(txHash);
			expect(record!.fromAddress).toBe(payer);
			expect(record!.deliveredAt).toBeUndefined();
		});

		test("should reject invalid tier", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;

			await expect(
				engine.processHttpPayment("req-1", "invalid-tier", "default", txHash),
			).rejects.toThrow('Tier "invalid-tier" not found');
		});

		test("should reject nonexistent resource", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;

			await expect(
				engine.processHttpPayment("req-1", "basic", "nonexistent", txHash),
			).rejects.toThrow('Resource "nonexistent" not found');
		});

		test("should reject double-spend (same txHash twice)", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;

			await engine.processHttpPayment("req-1", "basic", "default", txHash);

			await expect(engine.processHttpPayment("req-2", "basic", "default", txHash)).rejects.toThrow(
				"txHash has already been redeemed",
			);
		});

		test("should mark txHash in seenTxStore", async () => {
			const txHash = `0x${"12".repeat(32)}` as `0x${string}`;
			await engine.processHttpPayment("req-1", "basic", "default", txHash);

			const challengeId = await seenTxStore.get(txHash);
			expect(challengeId).toBeDefined();
			expect(challengeId).toMatch(/^http-/);
		});
	});
});
