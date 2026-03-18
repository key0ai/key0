import { describe, expect, test } from "bun:test";
import { buildAgentCard } from "../../core/agent-card.js";
import { ChallengeEngine } from "../../core/challenge-engine.js";
import { MockPaymentAdapter } from "../../test-utils/mock-adapter.js";
import { TestChallengeStore, TestSeenTxStore } from "../../test-utils/stores.js";
import type { FetchResourceResult, SellerConfig } from "../../types/index.js";
import { CHAIN_CONFIGS } from "../../types/index.js";
import { createMcpServer } from "../mcp.js";
import {
	type FetchResourceParams,
	key0PayPerRequest,
	mergePerRequestRoutes,
	resolveConfigFetchResource,
} from "../pay-per-request.js";
import { buildDiscoveryResponse } from "../settlement.js";

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
	const networkConfig = CHAIN_CONFIGS["testnet"];

	test("surfaces mode and routes in accepts extra for per-request plans", () => {
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
		const result = buildDiscoveryResponse(config, networkConfig);
		const extra = result.accepts[0]?.extra;
		expect(extra).toBeDefined();
		expect(extra?.["mode"]).toBe("per-request");
		expect(extra?.["routes"]).toEqual([{ method: "GET", path: "/api/weather/:city" }]);
	});

	test("subscription plans have mode=subscription and no routes", () => {
		const config = makeConfig({
			plans: [{ planId: "sub", unitAmount: "$1.00" }],
		});
		const result = buildDiscoveryResponse(config, networkConfig);
		const extra = result.accepts[0]?.extra;
		expect(extra).toBeDefined();
		expect(extra?.["mode"]).toBe("subscription");
		expect(extra?.["routes"]).toBeUndefined();
	});

	test("runtime-registered routes appear when perRequestRoutes map is passed", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});
		const runtimeRoutes = new Map([
			["weather-query", [{ method: "GET", path: "/api/weather/:city" }]],
		]);
		const result = buildDiscoveryResponse(config, networkConfig, runtimeRoutes);
		const extra = result.accepts[0]?.extra;
		expect(extra?.["routes"]).toEqual([{ method: "GET", path: "/api/weather/:city" }]);
	});

	test("omits routes key when plan has no routes", () => {
		const config = makeConfig({
			plans: [{ planId: "weather-query", unitAmount: "$0.01", mode: "per-request" }],
		});
		const result = buildDiscoveryResponse(config, networkConfig);
		const extra = result.accepts[0]?.extra;
		expect(Object.hasOwn(extra ?? {}, "routes")).toBe(false);
	});

	test("planId is included in extra for all plans", () => {
		const config = makeConfig();
		const result = buildDiscoveryResponse(config, networkConfig);
		for (const accept of result.accepts) {
			expect(accept.extra?.["planId"]).toBeDefined();
		}
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
		expect(weatherSkill!.endpoint?.method).toBe("GET");
		expect(weatherSkill!.endpoint?.url).toContain("/api/weather/:city");
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

	test("always includes the two base skills (discover-plans, request-access)", () => {
		const config = makeConfig();
		const card = buildAgentCard(config);
		const ids = card.skills.map((s) => s.id);
		expect(ids).toContain("discover-plans");
		expect(ids).toContain("request-access");
	});

	test("per-request skill endpoint URL contains the route path", () => {
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
		expect(pprSkill!.endpoint?.url).toBe("https://agent.example.com/v1/data");
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
	test("returns undefined when neither fetchResource nor proxyTo is set (embedded mode)", () => {
		const config = makeConfig();
		expect(resolveConfigFetchResource(config)).toBeUndefined();
	});

	test("returns fetchResource directly when set", () => {
		const fn = async (_params: FetchResourceParams): Promise<FetchResourceResult> => ({
			status: 200,
			body: { ok: true },
		});
		const config = makeConfig({ fetchResource: fn });
		expect(resolveConfigFetchResource(config)).toBe(fn);
	});

	test("returns a function from proxyTo when set", () => {
		const config = makeConfig({
			proxyTo: { baseUrl: "http://backend.example.com" },
		});
		const result = resolveConfigFetchResource(config);
		expect(typeof result).toBe("function");
	});

	test("fetchResource takes priority over proxyTo when both set", () => {
		const fn = async (_params: FetchResourceParams): Promise<FetchResourceResult> => ({
			status: 200,
			body: { ok: true },
		});
		const config = makeConfig({
			fetchResource: fn,
			proxyTo: { baseUrl: "http://should-not-be-used.example.com" },
		});
		expect(resolveConfigFetchResource(config)).toBe(fn);
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

	test("embedded mode: per-request skills point to the route URL", () => {
		const config = makeConfig({ plans: [pprPlan] }); // no fetchResource/proxyTo
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill).toBeDefined();
		expect(pprSkill!.endpoint?.url).toBe("https://agent.example.com/api/weather/:city");
		expect(pprSkill!.endpoint?.method).toBe("GET");
		expect(pprSkill!.workflow).toBeUndefined();
		expect(pprSkill!.inputSchema).toBeUndefined();
	});

	test("standalone mode: per-request skills point to /x402/access with workflow", () => {
		const config = makeConfig({
			plans: [pprPlan],
			fetchResource: async (_p: FetchResourceParams): Promise<FetchResourceResult> => ({
				status: 200,
				body: {},
			}),
		});
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill).toBeDefined();
		expect(pprSkill!.endpoint?.url).toBe("https://agent.example.com/x402/access");
		expect(pprSkill!.endpoint?.method).toBe("POST");
		expect(Array.isArray(pprSkill!.workflow)).toBe(true);
		expect(pprSkill!.inputSchema).toBeDefined();
	});

	test("standalone mode via proxyTo: per-request skills point to /x402/access", () => {
		const config = makeConfig({
			plans: [pprPlan],
			proxyTo: { baseUrl: "http://backend.example.com" },
		});
		const card = buildAgentCard(config);
		const pprSkill = card.skills.find((s) => s.id.startsWith("ppr-"));

		expect(pprSkill!.endpoint?.url).toBe("https://agent.example.com/x402/access");
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
		globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			if (headers) Object.assign(capturedHeaders, headers);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

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
		globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			if (headers) Object.assign(capturedHeaders, headers);
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		};

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
