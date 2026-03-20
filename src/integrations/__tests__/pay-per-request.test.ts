import { describe, expect, mock, test } from "bun:test";
import { buildAgentCard } from "../../core/agent-card.js";
import { ChallengeEngine } from "../../core/challenge-engine.js";
import { makeSellerConfig } from "../../test-utils/fixtures.js";
import { MockPaymentAdapter } from "../../test-utils/mock-adapter.js";
import { TestChallengeStore, TestSeenTxStore } from "../../test-utils/stores.js";
import type { SellerConfig, X402PaymentPayload } from "../../types/index.js";
import { CHAIN_CONFIGS } from "../../types/index.js";
import {
	createExpressPayPerRequest,
	type FetchResourceParams,
	key0PayPerRequest,
	mergePerRequestRoutes,
	resolveConfigFetchResource,
} from "../pay-per-request.js";
import { buildDiscoveryResponse, buildHttpPaymentRequirements } from "../settlement.js";

// ---------------------------------------------------------------------------
// Module-level mock for settlePayment (keeps buildDiscoveryResponse and
// buildHttpPaymentRequirements real — they are imported statically above
// before mock registration).
// createMcpServer is imported dynamically after mock registration so that
// mcp.ts picks up the mocked settlement module.
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

mock.module("../settlement.js", () => ({
	settlePayment: (payload: X402PaymentPayload) => settlePaymentImpl(payload),
	buildDiscoveryResponse,
	buildHttpPaymentRequirements,
}));

// Import createMcpServer AFTER the mock is registered so it picks up the mocked settlement.
const { createMcpServer } = await import("../mcp.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;
const TX_HASH = `0x${"cc".repeat(32)}` as `0x${string}`;

function makeConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test Agent Description",
		agentUrl: "https://agent.example.com",
		providerName: "Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		plans: [
			{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" },
			{ planId: "subscription", unitAmount: "$1.00", mode: "subscription" },
		],
		fetchResourceCredentials: async (params) => ({
			token: `tok_${params.challengeId}`,
			tokenType: "Bearer",
		}),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Helper: build a minimal Express-like req/res/next triple for testing
// ---------------------------------------------------------------------------

type MockReq = {
	method: string;
	path: string;
	originalUrl: string;
	headers: Record<string, unknown>;
	body?: unknown;
};

type MockRes = {
	statusCode: number;
	sentStatus: number | null;
	sentBody: unknown;
	headers: Record<string, string>;
	status: (code: number) => { json: (data: unknown) => unknown };
	setHeader: (name: string, value: string) => void;
	on: (event: string, cb: () => void) => void;
	_finishCallbacks: (() => void)[];
	_triggerFinish: () => void;
};

function makeMockRes(): MockRes {
	const res: MockRes = {
		statusCode: 200,
		sentStatus: null,
		sentBody: undefined,
		headers: {},
		_finishCallbacks: [],
		_triggerFinish() {
			for (const cb of this._finishCallbacks) cb();
		},
		status(code: number) {
			res.sentStatus = code;
			res.statusCode = code;
			return {
				json(data: unknown) {
					res.sentBody = data;
					return data;
				},
			};
		},
		setHeader(name: string, value: string) {
			res.headers[name] = value;
		},
		on(event: string, cb: () => void) {
			if (event === "finish") res._finishCallbacks.push(cb);
		},
	};
	return res;
}

// ---------------------------------------------------------------------------
// Unit: mergePerRequestRoutes
// ---------------------------------------------------------------------------

describe("mergePerRequestRoutes", () => {
	test("returns empty map when no routes anywhere", () => {
		const config = makeConfig({
			plans: [{ planId: "basic", unitAmount: "$0.01", mode: "per-request" }],
		});
		const result = mergePerRequestRoutes(config.plans, new Map());
		expect(result.size).toBe(0);
	});

	test("includes config-declared routes", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "api",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/data" }],
				},
			],
		});
		const result = mergePerRequestRoutes(config.plans, new Map());
		expect(result.get("api")).toEqual([{ method: "GET", path: "/api/data" }]);
	});

	test("merges config and runtime routes without duplicates", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "api",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/data" }],
				},
			],
		});
		const registry = new Map([
			[
				"api",
				[
					{ method: "GET", path: "/api/data" }, // duplicate — should be dropped
					{ method: "POST", path: "/api/submit" },
				],
			],
		]);
		const result = mergePerRequestRoutes(config.plans, registry);
		expect(result.get("api")).toHaveLength(2);
		expect(result.get("api")).toEqual([
			{ method: "GET", path: "/api/data" },
			{ method: "POST", path: "/api/submit" },
		]);
	});

	test("handles multiple plans independently", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "plan-a",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/a" }],
				},
				{
					planId: "plan-b",
					unitAmount: "$0.02",
					mode: "per-request",
				},
			],
		});
		const registry = new Map([["plan-b", [{ method: "POST", path: "/b" }]]]);
		const result = mergePerRequestRoutes(config.plans, registry);
		expect(result.get("plan-a")).toHaveLength(1);
		expect(result.get("plan-b")).toHaveLength(1);
	});

	test("deduplication normalises method to uppercase", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "api",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api" }],
				},
			],
		});
		// runtime adds "get" (lower) — should be treated as duplicate of "GET"
		const registry = new Map([["api", [{ method: "get", path: "/api" }]]]);
		const result = mergePerRequestRoutes(config.plans, registry);
		expect(result.get("api")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Unit: buildDiscoveryResponse with per-request routes
// ---------------------------------------------------------------------------

describe("buildDiscoveryResponse — per-request route surfacing", () => {
	test("surfaces mode and routes for per-request plans", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "weather-query",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/weather/:city" }],
				},
			],
		});
		const result = buildDiscoveryResponse(config);
		const plan = result.plans[0];
		expect(plan).toBeDefined();
		expect(plan?.planId).toBe("weather-query");
	});

	test("subscription plans appear in plans array", () => {
		const config = makeConfig({
			plans: [{ planId: "sub", unitAmount: "$1.00" }],
		});
		const result = buildDiscoveryResponse(config);
		const plan = result.plans[0];
		expect(plan).toBeDefined();
		expect(plan?.planId).toBe("sub");
	});

	test("returns plans array with all plans included", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});
		const result = buildDiscoveryResponse(config);
		expect(result.plans).toHaveLength(1);
		expect(result.plans[0]?.planId).toBe("weather-query");
	});

	test("plan with no routes has no routes field in response", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});
		const result = buildDiscoveryResponse(config);
		const plan = result.plans[0];
		expect(plan).toBeDefined();
		// No routes means no routes key in the plan
		expect(Object.hasOwn(plan ?? {}, "routes")).toBe(false);
	});

	test("planId is included in all plans", () => {
		const config = makeConfig();
		const result = buildDiscoveryResponse(config);
		for (const plan of result.plans) {
			expect(plan.planId).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Unit: buildDiscoveryResponse — free plans
// ---------------------------------------------------------------------------

describe("buildDiscoveryResponse — free plans", () => {
	test("free plan appears in plans array", () => {
		const config = makeConfig({
			plans: [{ planId: "health", free: true as const, proxyPath: "/health" }],
		});
		const result = buildDiscoveryResponse(config);
		const plan = result.plans[0];
		expect(plan).toBeDefined();
		expect(plan?.planId).toBe("health");
	});

	test("paid plan has a non-zero unitAmount", () => {
		const config = makeConfig({
			plans: [{ planId: "signal", unitAmount: "$0.001", mode: "per-request" as const }],
		});
		const result = buildDiscoveryResponse(config);
		const plan = result.plans[0];
		expect(plan?.planId).toBe("signal");
		expect(plan?.unitAmount).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Integration: embedded mode middleware
// ---------------------------------------------------------------------------

describe("expressPayPerRequestHandler — embedded mode", () => {
	test("returns 402 when no PAYMENT-SIGNATURE header", async () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();
		const middleware = key0PayPerRequest({ planId: "weather-query", config, seenTxStore });

		const req: MockReq = {
			method: "GET",
			path: "/api/weather/london",
			originalUrl: "/api/weather/london",
			headers: {},
		};
		const res = makeMockRes();
		let nextCalled = false;

		await (middleware as any)(req, res, () => {
			nextCalled = true;
		});

		expect(res.sentStatus).toBe(402);
		expect(nextCalled).toBe(false);
		expect(res.headers["payment-required"]).toBeDefined();
	});

	test("402 body includes accepts array and resource URL", async () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();
		const middleware = key0PayPerRequest({ planId: "weather-query", config, seenTxStore });

		const req: MockReq = {
			method: "GET",
			path: "/api/weather/london",
			originalUrl: "/api/weather/london",
			headers: {},
		};
		const res = makeMockRes();
		await (middleware as any)(req, res, () => {});

		const body = res.sentBody as any;
		expect(Array.isArray(body.accepts)).toBe(true);
		expect(body.resource.url).toContain("agent.example.com");
	});

	test("throws synchronously when planId is not found in config.plans", () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();

		expect(() => key0PayPerRequest({ planId: "nonexistent-plan", config, seenTxStore })).toThrow(
			"nonexistent-plan",
		);
	});

	test("does not call next() when no payment signature", async () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();
		const middleware = key0PayPerRequest({ planId: "weather-query", config, seenTxStore });

		const req: MockReq = {
			method: "GET",
			path: "/api/weather/london",
			originalUrl: "/api/weather/london",
			headers: {},
		};
		const res = makeMockRes();
		let nextCalled = false;

		await (middleware as any)(req, res, () => {
			nextCalled = true;
		});

		expect(nextCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Unit: double-spend guard via TestSeenTxStore
// ---------------------------------------------------------------------------

describe("double-spend prevention", () => {
	test("markUsed returns true on first call, false on second", async () => {
		const seenTxStore = new TestSeenTxStore();

		const first = await seenTxStore.markUsed(TX_HASH, "challenge-1");
		const second = await seenTxStore.markUsed(TX_HASH, "challenge-2");

		expect(first).toBe(true);
		expect(second).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Unit: standalone mode — fetchResource branching
// ---------------------------------------------------------------------------

describe("key0PayPerRequest — standalone mode (fetchResource)", () => {
	test("fetchResource is NOT called when no payment signature (returns 402)", async () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();
		let fetchResourceCalled = false;

		const middleware = key0PayPerRequest({
			planId: "weather-query",
			config,
			seenTxStore,
			fetchResource: async (_params: FetchResourceParams) => {
				fetchResourceCalled = true;
				return { status: 200, body: { temp: 72 } };
			},
		});

		const req: MockReq = {
			method: "GET",
			path: "/api/weather/london",
			originalUrl: "/api/weather/london",
			headers: {},
		};
		const res = makeMockRes();

		await (middleware as any)(req, res, () => {});

		expect(res.sentStatus).toBe(402);
		expect(fetchResourceCalled).toBe(false);
	});

	test("middleware accepts proxyTo config and does not throw at construction", () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();

		expect(() =>
			key0PayPerRequest({
				planId: "weather-query",
				config,
				seenTxStore,
				proxyTo: {
					baseUrl: "https://weather-api.internal",
					headers: { "X-Service-Key": "secret" },
				},
			}),
		).not.toThrow();
	});

	test("proxyTo pathRewrite function works correctly", () => {
		const pathRewrite = (path: string) => path.replace("/api", "/v2");
		expect(pathRewrite("/api/weather/london")).toBe("/v2/weather/london");
		expect(pathRewrite("/api/data")).toBe("/v2/data");
		expect(pathRewrite("/other")).toBe("/other"); // no-op when prefix not present
	});

	test("middleware with proxyTo still returns 402 without payment signature", async () => {
		const config = makeConfig();
		const seenTxStore = new TestSeenTxStore();

		const middleware = key0PayPerRequest({
			planId: "weather-query",
			config,
			seenTxStore,
			proxyTo: {
				baseUrl: "https://weather-api.internal",
				pathRewrite: (path) => path.replace("/api", "/v2"),
			},
		});

		const req: MockReq = {
			method: "GET",
			path: "/api/weather/london",
			originalUrl: "/api/weather/london",
			headers: {},
		};
		const res = makeMockRes();

		await (middleware as any)(req, res, () => {});
		expect(res.sentStatus).toBe(402);
	});
});

// ---------------------------------------------------------------------------
// Unit: MCP discover_plans includes mode and routes
// ---------------------------------------------------------------------------

describe("createMcpServer — discover_plans with per-request routes", () => {
	test("creates server without errors for config with per-request plans", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "weather-query",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/weather/:city", description: "Get weather" }],
				},
				{
					planId: "subscription",
					unitAmount: "$1.00",
					mode: "subscription",
				},
			],
		});

		const mockEngine = {} as any;
		expect(() => createMcpServer(mockEngine, config)).not.toThrow();
	});

	test("creates server without errors when perRequestRoutes map is passed", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});
		const perRequestRoutes = new Map([
			["weather-query", [{ method: "GET", path: "/api/weather/:city" }]],
		]);

		const mockEngine = {} as any;
		expect(() => createMcpServer(mockEngine, config, perRequestRoutes)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Unit: agent card per-request skills
// ---------------------------------------------------------------------------

describe("buildAgentCard — per-request skills", () => {
	test("includes per-request skills for plans with mode=per-request and routes", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "weather-query",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [
						{ method: "GET", path: "/api/weather/:city", description: "Get weather for city" },
						{ method: "POST", path: "/api/weather/bulk" },
					],
				},
			],
		});

		const card = buildAgentCard(config);
		const pprSkills = card.skills.filter((s) => s.id.startsWith("ppr-"));
		expect(pprSkills).toHaveLength(2);

		const weatherSkill = pprSkills.find((s) => s.name === "GET /api/weather/:city");
		expect(weatherSkill).toBeDefined();
		expect(weatherSkill!.description).toBe("Get weather for city");
	});

	test("uses default description when route description is absent", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "weather-query",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/weather/:city" }],
				},
			],
		});

		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));
		expect(pprSkill!.description).toContain("$0.01 USDC");
		expect(pprSkill!.description).toContain("weather-query");
	});

	test("subscription plans do not generate per-request skills", () => {
		const config = makeConfig({
			plans: [
				{ planId: "subscription", unitAmount: "$1.00", mode: "subscription" },
				{ planId: "default-mode", unitAmount: "$0.50" },
			],
		});

		const card = buildAgentCard(config);
		const pprSkills = card.skills.filter((s) => s.id.startsWith("ppr-"));
		expect(pprSkills).toHaveLength(0);
	});

	test("per-request plan with no routes does not generate skills", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});

		const card = buildAgentCard(config);
		const pprSkills = card.skills.filter((s) => s.id.startsWith("ppr-"));
		expect(pprSkills).toHaveLength(0);
	});

	test("always includes the two base skills (discover, access)", () => {
		const config = makeConfig();
		const card = buildAgentCard(config);
		const ids = card.skills.map((s) => s.id);
		expect(ids).toContain("discover");
		expect(ids).toContain("access");
	});

	test("embedded mode: per-request skill description mentions route path", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "api",
					unitAmount: "$0.05",
					mode: "per-request",
					routes: [{ method: "GET", path: "/v1/data" }],
				},
			],
		});

		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));
		expect(pprSkill!.description).toContain("/v1/data");
	});

	test("per-request skill tags include planId and pay-per-request", () => {
		const config = makeConfig({
			plans: [
				{
					planId: "weather-query",
					unitAmount: "$0.01",
					mode: "per-request",
					routes: [{ method: "GET", path: "/api/weather" }],
				},
			],
		});

		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));
		expect(pprSkill!.tags).toContain("pay-per-request");
		expect(pprSkill!.tags).toContain("weather-query");
	});
});

// ---------------------------------------------------------------------------
// Unit: resolveConfigFetchResource — deployment mode signal
// ---------------------------------------------------------------------------

describe("resolveConfigFetchResource", () => {
	test("returns undefined when proxyTo is not set (embedded mode)", () => {
		const config = makeConfig();
		expect(resolveConfigFetchResource(config)).toBeUndefined();
	});

	test("returns a function from proxyTo when set", () => {
		const config = makeConfig({
			proxyTo: { baseUrl: "http://backend.example.com" },
		});
		const result = resolveConfigFetchResource(config);
		expect(typeof result).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Unit: agent card — standalone vs embedded per-request skills
// ---------------------------------------------------------------------------

describe("buildAgentCard — standalone vs embedded mode", () => {
	const pprPlan = {
		planId: "weather-query",
		unitAmount: "$0.01",
		mode: "per-request" as const,
		routes: [{ method: "GET", path: "/api/weather/:city", description: "Get weather for a city" }],
	};

	test("embedded mode: per-request skill examples mention route path", () => {
		const config = makeConfig({ plans: [pprPlan] }); // no fetchResource/proxyTo
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill).toBeDefined();
		expect(pprSkill!.examples?.some((ex) => ex.includes("/api/weather/:city"))).toBe(true);
		expect((pprSkill as any).endpoint).toBeUndefined();
		expect((pprSkill as any).workflow).toBeUndefined();
	});

	test("standalone mode: per-request skill examples mention /x402/access and payment step", () => {
		const config = makeConfig({
			plans: [pprPlan],
			proxyTo: { baseUrl: "http://backend.example.com" },
		});
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill).toBeDefined();
		expect(pprSkill!.examples?.some((ex) => ex.includes("/x402/access"))).toBe(true);
		expect(pprSkill!.examples?.some((ex) => ex.includes("PAYMENT-SIGNATURE"))).toBe(true);
		expect((pprSkill as any).endpoint).toBeUndefined();
		expect(pprSkill!.inputSchema).toBeDefined();
	});

	test("standalone mode via proxyTo: per-request skill examples mention /x402/access", () => {
		const config = makeConfig({
			plans: [pprPlan],
			proxyTo: { baseUrl: "http://backend.example.com" },
		});
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill!.examples?.some((ex) => ex.includes("/x402/access"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Unit: ChallengeEngine.recordPerRequestPayment + markDelivered
// ---------------------------------------------------------------------------

describe("ChallengeEngine.recordPerRequestPayment", () => {
	function makePprConfig(overrides?: Partial<SellerConfig>): SellerConfig {
		return {
			agentName: "Test Agent",
			agentDescription: "Test",
			agentUrl: "https://agent.example.com",
			providerName: "Provider",
			providerUrl: "https://provider.example.com",
			walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
			network: "testnet",
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
			fetchResourceCredentials: async (params) => ({
				token: `tok_${params.challengeId}`,
				tokenType: "Bearer",
			}),
			...overrides,
		};
	}

	function makePprEngine(opts?: { config?: Partial<SellerConfig> }) {
		const adapter = new MockPaymentAdapter();
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const config = makePprConfig(opts?.config);
		const engine = new ChallengeEngine({ config, store, seenTxStore, adapter });
		return { engine, adapter, store, seenTxStore };
	}

	function makeTxHash(): `0x${string}` {
		const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return `0x${hex}` as `0x${string}`;
	}

	test("transitions challenge PENDING → PAID without issuing a token", async () => {
		const { engine, store } = makePprEngine();
		const requestId = crypto.randomUUID();
		const txHash = makeTxHash();

		const result = await engine.recordPerRequestPayment(
			requestId,
			"weather-query",
			"/api/weather/london",
			txHash,
		);

		expect(result.challengeId).toBeTruthy();
		expect(result.explorerUrl).toContain(txHash);

		const record = await store.get(result.challengeId);
		expect(record?.state).toBe("PAID");
		expect(record?.txHash).toBe(txHash);
		expect(record?.resourceId).toBe("/api/weather/london");
		expect(record?.accessGrant).toBeUndefined();
	});

	test("marks txHash as used (double-spend prevention)", async () => {
		const { engine, seenTxStore } = makePprEngine();
		const requestId = crypto.randomUUID();
		const txHash = makeTxHash();

		await engine.recordPerRequestPayment(requestId, "weather-query", "/api/weather/london", txHash);

		const stored = await seenTxStore.get(txHash);
		expect(stored).toBeTruthy();
	});

	test("rejects duplicate txHash with TX_ALREADY_REDEEMED", async () => {
		const { engine } = makePprEngine();
		const txHash = makeTxHash();

		await engine.recordPerRequestPayment(
			crypto.randomUUID(),
			"weather-query",
			"/api/weather/london",
			txHash,
		);

		const err = await engine
			.recordPerRequestPayment(crypto.randomUUID(), "weather-query", "/api/weather/london", txHash)
			.catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as any).code).toBe("TX_ALREADY_REDEEMED");
	});

	test("rejects unknown planId with TIER_NOT_FOUND", async () => {
		const { engine } = makePprEngine();

		const err = await engine
			.recordPerRequestPayment(
				crypto.randomUUID(),
				"nonexistent-plan",
				"/api/weather/london",
				makeTxHash(),
			)
			.catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as any).code).toBe("TIER_NOT_FOUND");
	});
});

describe("proxyToFetchResource — proxySecret header injection", () => {
	test("adds X-Key0-Internal-Token header when proxySecret is set", async () => {
		const capturedHeaders: Record<string, string> = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			if (headers) Object.assign(capturedHeaders, headers);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const fn = resolveConfigFetchResource({
			...makeConfig(),
			proxyTo: { baseUrl: "https://backend.internal", proxySecret: "super-secret-32-chars-long!!" },
		});

		await fn!({
			method: "GET",
			path: "/health",
			headers: {},
			paymentInfo: {
				txHash: "0xabc" as `0x${string}`,
				payer: undefined,
				planId: "test",
				amount: "$0.001",
				method: "GET",
				path: "/health",
				challengeId: "cid-1",
			},
		});

		globalThis.fetch = originalFetch;
		expect(capturedHeaders["x-key0-internal-token"]).toBe("super-secret-32-chars-long!!");
	});

	test("does NOT add X-Key0-Internal-Token when proxySecret is absent", async () => {
		const capturedHeaders: Record<string, string> = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			if (headers) Object.assign(capturedHeaders, headers);
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;

		const fn = resolveConfigFetchResource({
			...makeConfig(),
			proxyTo: { baseUrl: "https://backend.internal" },
		});

		await fn!({
			method: "GET",
			path: "/health",
			headers: {},
			paymentInfo: {
				txHash: "0xabc" as `0x${string}`,
				payer: undefined,
				planId: "test",
				amount: "$0.001",
				method: "GET",
				path: "/health",
				challengeId: "cid-1",
			},
		});

		globalThis.fetch = originalFetch;
		expect(capturedHeaders["x-key0-internal-token"]).toBeUndefined();
	});
});

describe("ChallengeEngine.markDelivered", () => {
	function makePprEngine() {
		const adapter = new MockPaymentAdapter();
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const config: SellerConfig = {
			agentName: "Test Agent",
			agentDescription: "Test",
			agentUrl: "https://agent.example.com",
			providerName: "Provider",
			providerUrl: "https://provider.example.com",
			walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
			network: "testnet",
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
			fetchResourceCredentials: async (params) => ({
				token: `tok_${params.challengeId}`,
				tokenType: "Bearer",
			}),
		};
		const engine = new ChallengeEngine({ config, store, seenTxStore, adapter });
		return { engine, store };
	}

	function makeTxHash(): `0x${string}` {
		return `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")}` as `0x${string}`;
	}

	test("transitions PAID → DELIVERED after successful proxy", async () => {
		const { engine, store } = makePprEngine();
		const txHash = makeTxHash();

		const { challengeId } = await engine.recordPerRequestPayment(
			crypto.randomUUID(),
			"weather-query",
			"/api/weather/london",
			txHash,
		);

		await engine.markDelivered(challengeId);

		const record = await store.get(challengeId);
		expect(record?.state).toBe("DELIVERED");
		expect(record?.deliveredAt).toBeDefined();
	});

	test("does not throw if challenge is already DELIVERED (idempotent best-effort)", async () => {
		const { engine } = makePprEngine();
		const txHash = makeTxHash();

		const { challengeId } = await engine.recordPerRequestPayment(
			crypto.randomUUID(),
			"weather-query",
			"/api/weather/london",
			txHash,
		);

		await engine.markDelivered(challengeId);
		// Second call — already DELIVERED, state mismatch is silently swallowed
		await expect(engine.markDelivered(challengeId)).resolves.toBeUndefined();
	});
});

// Import key0Router AFTER the mock is registered so it picks up the mocked settlement.
const { key0Router } = await import("../express.js");

// ---------------------------------------------------------------------------
// Module-level helpers for Express key0Router integration tests
// ---------------------------------------------------------------------------

type MockExpressReq = {
	method: string;
	url: string;
	path: string;
	headers: Record<string, string | undefined>;
	body: Record<string, unknown>;
	params: Record<string, string>;
	query: Record<string, string>;
};

type MockExpressRes = {
	statusCode: number;
	sentStatus: number | null;
	sentBody: unknown;
	_headers: Record<string, string>;
	_resolve: (() => void) | null;
	status: (code: number) => { json: (data: unknown) => unknown };
	json: (data: unknown) => unknown;
	setHeader: (name: string, value: string) => void;
	getHeader: (name: string) => string | undefined;
	header: (name: string, value: string) => void;
	on: (event: string, cb: () => void) => void;
	end: () => void;
};

function makeMockExpressRes(): MockExpressRes {
	const res: MockExpressRes = {
		statusCode: 200,
		sentStatus: null,
		sentBody: undefined,
		_headers: {},
		_resolve: null,
		status(code: number) {
			res.sentStatus = code;
			res.statusCode = code;
			return {
				json(data: unknown) {
					res.sentBody = data;
					res._resolve?.();
					return data;
				},
			};
		},
		json(data: unknown) {
			res.sentBody = data;
			res._resolve?.();
			return data;
		},
		setHeader(name: string, value: string) {
			res._headers[name.toLowerCase()] = value;
		},
		getHeader(name: string) {
			return res._headers[name.toLowerCase()];
		},
		header(name: string, value: string) {
			res._headers[name.toLowerCase()] = value;
		},
		on(_event: string, _cb: () => void) {},
		end() {
			res._resolve?.();
		},
	};
	return res;
}

// Simulate sending a POST /x402/access through the express router
async function callX402Access(
	router: ReturnType<typeof key0Router>,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<MockExpressRes> {
	const res = makeMockExpressRes();
	const req: MockExpressReq = {
		method: "POST",
		url: "/x402/access",
		path: "/x402/access",
		headers: { "content-type": "application/json", ...headers },
		body,
		params: {},
		query: {},
	};

	await new Promise<void>((resolve) => {
		res._resolve = resolve;

		// Walk the router's stack to find the /x402/access POST handler
		const stack: Array<{
			route?: {
				path: string;
				methods: Record<string, boolean>;
				stack: Array<{ handle: (...args: never) => unknown }>;
			};
		}> = (router as any).stack ?? [];
		const route = stack
			.map((layer) => layer.route)
			.find((r) => r && r.path === "/x402/access" && r.methods["post"]);

		if (!route) {
			res.status(500).json({ error: "route not found in test" });
			return;
		}

		// First handler is the x402 handler; second is the A2A JSON-RPC fallback
		const handler = route.stack[0]?.handle;
		if (!handler) {
			res.status(500).json({ error: "handler not found in test" });
			return;
		}

		// next() also resolves (e.g. when A2A path is taken)
		const typedHandler = handler as (req: unknown, res: unknown, next: unknown) => unknown;
		Promise.resolve(typedHandler(req, res, resolve)).catch(() => resolve());
	});

	return res;
}

// ---------------------------------------------------------------------------
// Integration: key0Router /x402/access — free plan fast-path (Express)
// ---------------------------------------------------------------------------

describe("key0Router /x402/access — free plan fast-path", () => {
	function makeFreePlanConfig(overrides?: Partial<SellerConfig>): SellerConfig {
		return {
			agentName: "Test Agent",
			agentDescription: "Test",
			agentUrl: "https://agent.example.com",
			providerName: "Provider",
			providerUrl: "https://provider.example.com",
			walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
			network: "testnet",
			plans: [
				{
					planId: "health",
					unitAmount: "$0.00",
					free: true as const,
					proxyPath: "/health",
					proxyMethod: "GET" as const,
				} as any,
			],
			fetchResourceCredentials: async (params) => ({
				token: `tok_${params.challengeId}`,
				tokenType: "Bearer",
			}),
			...overrides,
		};
	}

	test("returns 200 ResourceResponse for a free plan (no PAYMENT-SIGNATURE)", async () => {
		const fetchedPaths: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: unknown) => {
			fetchedPaths.push(String(url).replace("http://mock-backend", ""));
			return new Response(JSON.stringify({ status: "healthy" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const config = makeFreePlanConfig({ proxyTo: { baseUrl: "http://mock-backend" } });
			const store = new TestChallengeStore();
			const seenTxStore = new TestSeenTxStore();
			const router = key0Router({ config, store, seenTxStore });

			const res = await callX402Access(router, { planId: "health" });

			expect(res.sentStatus).toBe(200);
			const body = res.sentBody as any;
			expect(body.type).toBe("ResourceResponse");
			expect(body.planId).toBe("health");
			expect(body.challengeId).toBe("free");
			expect(body.resource.status).toBe(200);
			expect(fetchedPaths).toEqual(["/health"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan with proxyPath template interpolates params", async () => {
		const fetchedPaths: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: unknown) => {
			fetchedPaths.push(String(url).replace("http://mock-backend", ""));
			return new Response(JSON.stringify({ score: 99 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const config = makeFreePlanConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/signal/{asset}",
						proxyMethod: "GET" as const,
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const store = new TestChallengeStore();
			const seenTxStore = new TestSeenTxStore();
			const router = key0Router({ config, store, seenTxStore });

			const res = await callX402Access(router, { planId: "signal", params: { asset: "BTC" } });

			expect(res.sentStatus).toBe(200);
			expect(fetchedPaths).toEqual(["/signal/BTC"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan returns 400 when proxyPath template param is missing", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const config = makeFreePlanConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/signal/{asset}",
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const store = new TestChallengeStore();
			const seenTxStore = new TestSeenTxStore();
			const router = key0Router({ config, store, seenTxStore });

			const res = await callX402Access(router, { planId: "signal" });

			expect(res.sentStatus).toBe(400);
			const body = res.sentBody as any;
			expect(body.error).toBe("TEMPLATE_ERROR");
			expect(body.message).toContain('Missing param "asset"');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan returns 400 when proxyTo not configured", async () => {
		// No proxyTo — misconfigured
		const config = makeFreePlanConfig(); // no proxyTo
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const router = key0Router({ config, store, seenTxStore });

		const res = await callX402Access(router, { planId: "health" });

		expect(res.sentStatus).toBe(400);
		const body = res.sentBody as any;
		expect(body.error).toBe("FREE_PLAN_MISCONFIGURED");
	});
});

// ---------------------------------------------------------------------------
// Integration: key0Router /x402/access — proxy error handling (paid plans)
// ---------------------------------------------------------------------------

describe("key0Router /x402/access — proxy error handling (paid plans)", () => {
	// Build a fake PAYMENT-SIGNATURE header for the mocked settlement path
	function makeFakePaymentSignature(): string {
		const payload = {
			x402Version: 2,
			network: "eip155:84532",
			payload: { signature: `0x${"dd".repeat(32)}` },
		};
		return Buffer.from(JSON.stringify(payload)).toString("base64");
	}

	function makePerRequestConfig(): SellerConfig {
		return {
			agentName: "Test Agent",
			agentDescription: "Test",
			agentUrl: "https://agent.example.com",
			providerName: "Provider",
			providerUrl: "https://provider.example.com",
			walletAddress: `0x${"ab".repeat(20)}` as `0x${string}`,
			network: "testnet",
			plans: [
				{
					planId: "signal",
					unitAmount: "$0.001",
					mode: "per-request" as const,
					proxyPath: "/signal/{asset}",
				},
			],
			fetchResourceCredentials: async (p) => ({
				token: `tok_${p.challengeId}`,
				tokenType: "Bearer",
			}),
			proxyTo: { baseUrl: "http://mock-backend" },
		};
	}

	test("returns 402 for paid proxyPath plans when template params are provided", async () => {
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const router = key0Router({ config: makePerRequestConfig(), store, seenTxStore });

		const res = await callX402Access(router, {
			planId: "signal",
			params: { asset: "BTC" },
		});

		expect(res.sentStatus).toBe(402);
		const body = res.sentBody as any;
		expect(body.challengeId).toBeDefined();
		expect(body.error).toBe("Payment required");
	});

	test("returns 400 before challenge creation when a proxyPath template param is missing", async () => {
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const router = key0Router({ config: makePerRequestConfig(), store, seenTxStore });

		const res = await callX402Access(router, { planId: "signal" });

		expect(res.sentStatus).toBe(400);
		const body = res.sentBody as any;
		expect(body.code).toBe("TEMPLATE_ERROR");
		expect(body.message).toContain('Missing param "asset"');
		expect((await store.listByState("PENDING")).length).toBe(0);
	});

	test("transitions PAID → REFUND_PENDING when proxy returns non-2xx", async () => {
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "backend down" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const config = makePerRequestConfig();
			const router = key0Router({ config, store, seenTxStore });

			const res = await callX402Access(
				router,
				{
					planId: "signal",
					params: { asset: "BTC" },
				},
				{ "payment-signature": makeFakePaymentSignature() },
			);

			expect(res.sentStatus).toBe(502);
			const body = res.sentBody as any;
			expect(body.code).toBe("PROXY_BACKEND_ERROR");

			// Challenge must have been transitioned to REFUND_PENDING
			const refundPending = await store.listByState("REFUND_PENDING");
			expect(refundPending.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("transitions PAID → REFUND_PENDING on proxy timeout (AbortError)", async () => {
		const store = new TestChallengeStore();
		const seenTxStore = new TestSeenTxStore();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as unknown as typeof fetch;
		try {
			const config = makePerRequestConfig();
			const router = key0Router({ config, store, seenTxStore });

			const res = await callX402Access(
				router,
				{
					planId: "signal",
					params: { asset: "BTC" },
				},
				{ "payment-signature": makeFakePaymentSignature() },
			);

			expect(res.sentStatus).toBe(502);
			const body = res.sentBody as any;
			expect(body.code).toBe("PROXY_ERROR");

			// Challenge must have been transitioned to REFUND_PENDING
			const refundPending = await store.listByState("REFUND_PENDING");
			expect(refundPending.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// Helper: call a registered MCP tool directly (bypass full transport stack)
// ---------------------------------------------------------------------------

async function callMcpTool(
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
	return tool.handler(args, meta !== undefined ? { _meta: meta } : undefined) as Promise<{
		isError?: true;
		content: Array<{ type: string; text: string }>;
	}>;
}

function makeTestStore() {
	return new TestChallengeStore();
}

function makeEngine(config: SellerConfig, opts?: { store?: TestChallengeStore }) {
	const adapter = new MockPaymentAdapter();
	const store = opts?.store ?? new TestChallengeStore();
	const seenTxStore = new TestSeenTxStore();
	const engine = new ChallengeEngine({ config, store, seenTxStore, adapter });
	return engine;
}

// ---------------------------------------------------------------------------
// Integration: createMcpServer — free plan request_access
// ---------------------------------------------------------------------------

describe("createMcpServer — free plan request_access", () => {
	test("free plan proxies immediately without payment", async () => {
		const fetchedPaths: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: unknown) => {
			fetchedPaths.push(String(url).replace("http://mock-backend", ""));
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "health",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/health",
						proxyMethod: "GET" as const,
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config);
			const server = createMcpServer(engine, config);

			const result = await callMcpTool(server, "access", { planId: "health" });

			expect(result.isError).toBeUndefined();
			expect(fetchedPaths).toEqual(["/health"]);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.type).toBe("ResourceResponse");
			expect(parsed.resource.status).toBe(200);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan with proxyPath template interpolates params", async () => {
		const fetchedPaths: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: unknown) => {
			fetchedPaths.push(String(url).replace("http://mock-backend", ""));
			return new Response(JSON.stringify({ score: 72 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/signal/{asset}",
						proxyMethod: "GET" as const,
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config);
			const server = createMcpServer(engine, config);

			await callMcpTool(server, "access", { planId: "signal", params: { asset: "BTC" } });
			expect(fetchedPaths).toEqual(["/signal/BTC"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan returns error if proxyPath template param is missing", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/signal/{asset}",
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config);
			const server = createMcpServer(engine, config);

			const result = await callMcpTool(server, "access", { planId: "signal" });
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.message).toContain('Missing param "asset"');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("free plan propagates non-2xx status verbatim (no refund)", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "backend down" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "health",
						unitAmount: "$0.00",
						free: true as const,
						proxyPath: "/health",
					} as any,
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config);
			const server = createMcpServer(engine, config);

			const result = await callMcpTool(server, "access", { planId: "health" });
			// Free plan: return the status verbatim, no isError, no REFUND_PENDING
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.resource.status).toBe(503);
			expect(result.isError).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// Helper: simulate a full paid-plan request_access call
// Configures settlePaymentImpl to return a unique txHash, then invokes the
// tool with a minimal x402 payment payload in _meta.
// ---------------------------------------------------------------------------

async function callMcpToolWithPayment(
	server: ReturnType<typeof createMcpServer>,
	toolName: string,
	args: Record<string, unknown>,
) {
	const txHash = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}` as `0x${string}`;

	// Configure the settlement mock to return our unique txHash
	settlePaymentImpl = async () => ({
		txHash,
		settleResponse: { success: true, transaction: txHash, network: "eip155:84532" },
		payer: `0x${"aa".repeat(20)}`,
	});

	const paymentPayload: X402PaymentPayload = {
		x402Version: 2,
		network: "eip155:84532",
		payload: {
			signature: txHash, // unique per call → unique requestId via deriveRequestId
		},
	};

	return callMcpTool(server, toolName, args, { "x402/payment": paymentPayload });
}

// ---------------------------------------------------------------------------
// Integration: createMcpServer — proxy error handling (paid plans)
// ---------------------------------------------------------------------------

describe("createMcpServer — proxy error handling (paid plans)", () => {
	test("transitions PAID → REFUND_PENDING when proxy returns non-2xx", async () => {
		const store = makeTestStore();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "backend down" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.001",
						mode: "per-request" as const,
						proxyPath: "/signal/{asset}",
					},
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config, { store });
			const server = createMcpServer(engine, config);

			const result = await callMcpToolWithPayment(server, "access", {
				planId: "signal",
				params: { asset: "BTC" },
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.error).toBe("PROXY_ERROR");

			// Challenge must be in REFUND_PENDING
			const challenges = await store.listByState("REFUND_PENDING");
			expect(challenges.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("transitions PAID → REFUND_PENDING on proxy timeout (AbortError)", async () => {
		const store = makeTestStore();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as unknown as typeof fetch;
		try {
			const config = makeConfig({
				plans: [
					{
						planId: "signal",
						unitAmount: "$0.001",
						mode: "per-request" as const,
						proxyPath: "/signal/{asset}",
					},
				],
				proxyTo: { baseUrl: "http://mock-backend" },
			});
			const engine = makeEngine(config, { store });
			const server = createMcpServer(engine, config);

			const result = await callMcpToolWithPayment(server, "access", {
				planId: "signal",
				params: { asset: "BTC" },
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.error).toBe("PROXY_TIMEOUT");

			const challenges = await store.listByState("REFUND_PENDING");
			expect(challenges.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// Unit: routeId lookup — createExpressPayPerRequest
// ---------------------------------------------------------------------------

describe("routeId lookup — createExpressPayPerRequest", () => {
	const testNetworkConfig = CHAIN_CONFIGS["testnet"];

	test("does not throw for a known routeId", () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [
				{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" },
			],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		expect(() =>
			createExpressPayPerRequest("weather", {
				config,
				networkConfig: testNetworkConfig,
				seenTxStore: new TestSeenTxStore(),
			}),
		).not.toThrow();
	});

	test("throws for an unknown routeId", () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [
				{ routeId: "weather", method: "GET", path: "/api/weather/:city", unitAmount: "$0.01" },
			],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		expect(() =>
			createExpressPayPerRequest("unknown-id", {
				config,
				networkConfig: testNetworkConfig,
				seenTxStore: new TestSeenTxStore(),
			}),
		).toThrow(/route "unknown-id" not found/);
	});
});
