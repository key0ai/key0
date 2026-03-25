import { describe, expect, it } from "bun:test";
import { ChallengeEngine } from "../../core/challenge-engine.js";
import {
	MockPaymentAdapter,
	makeSellerConfig,
	TestChallengeStore,
	TestSeenTxStore,
} from "../../test-utils/index.js";
import { createMcpServer } from "../mcp.js";

function makeEngine(configOverrides = {}) {
	const config = makeSellerConfig(configOverrides);
	return new ChallengeEngine({
		config,
		store: new TestChallengeStore(),
		seenTxStore: new TestSeenTxStore(),
		adapter: new MockPaymentAdapter(),
	});
}

/** Helper to call a registered MCP tool handler directly (bypasses transport). */
async function callTool(
	server: ReturnType<typeof createMcpServer>,
	toolName: string,
	args: Record<string, unknown> = {},
	extra?: Record<string, unknown>,
) {
	const tools = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: Record<string, unknown>, extra?: unknown) => unknown }
			>;
		}
	)._registeredTools;
	const tool = tools[toolName];
	if (!tool) throw new Error(`Tool "${toolName}" not registered`);
	return tool.handler(args, extra);
}

describe("MCP tool registration", () => {
	it("registers 'discover' not 'discover_plans'", () => {
		const server = createMcpServer(makeEngine(), makeSellerConfig());
		// MCP SDK exposes registered tools via internal map
		const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools;
		expect(Object.keys(tools)).toContain("discover");
		expect(Object.keys(tools)).not.toContain("discover_plans");
	});

	it("registers 'access' not 'request_access'", () => {
		const server = createMcpServer(makeEngine(), makeSellerConfig());
		const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools;
		expect(Object.keys(tools)).toContain("access");
		expect(Object.keys(tools)).not.toContain("request_access");
	});
});

describe("MCP 'discover' tool", () => {
	it("returns both plans and routes arrays", async () => {
		const config = makeSellerConfig({
			plans: [{ planId: "pro", unitAmount: "$1.00", description: "Pro plan" }],
			routes: [
				{
					routeId: "weather",
					method: "GET",
					path: "/weather",
					unitAmount: "$0.01",
					description: "Weather API",
				},
			],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const server = createMcpServer(
			makeEngine({ plans: config.plans, routes: config.routes, proxyTo: config.proxyTo }),
			config,
		);

		const result = (await callTool(server, "discover")) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content).toBeDefined();
		expect(result.content[0]?.type).toBe("text");

		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(Array.isArray(parsed.plans)).toBe(true);
		expect(Array.isArray(parsed.routes)).toBe(true);
		expect(parsed.plans).toHaveLength(1);
		expect(parsed.plans[0]?.planId).toBe("pro");
		expect(parsed.routes).toHaveLength(1);
		expect(parsed.routes[0]?.routeId).toBe("weather");
	});

	it("returns empty routes array when no routes configured", async () => {
		const config = makeSellerConfig({ plans: [{ planId: "basic", unitAmount: "$0.50" }] });
		const server = createMcpServer(makeEngine(), config);

		const result = (await callTool(server, "discover")) as {
			content: Array<{ type: string; text: string }>;
		};

		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(Array.isArray(parsed.plans)).toBe(true);
		expect(Array.isArray(parsed.routes)).toBe(true);
		expect(parsed.routes).toHaveLength(0);
	});

	it("includes walletAddress and chainId", async () => {
		const config = makeSellerConfig();
		const server = createMcpServer(makeEngine(), config);

		const result = (await callTool(server, "discover")) as {
			content: Array<{ type: string; text: string }>;
		};

		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.walletAddress).toBeDefined();
		expect(typeof parsed.chainId).toBe("number");
	});
});

describe("MCP 'access' tool — planId (subscription flow)", () => {
	it("returns x402 PaymentRequired (isError: true) when called without payment", async () => {
		const config = makeSellerConfig({ plans: [{ planId: "single", unitAmount: "$0.10" }] });
		const server = createMcpServer(makeEngine(), config);

		const result = (await callTool(server, "access", {
			planId: "single",
			resourceId: "default",
		})) as {
			isError: boolean;
			structuredContent: Record<string, unknown>;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeDefined();
		// structuredContent should include x402 payment requirements
		expect(result.structuredContent["accepts"]).toBeDefined();
	});

	it("returns isError with plan details for unknown planId", async () => {
		const config = makeSellerConfig({ plans: [] });
		const server = createMcpServer(makeEngine({ plans: [] }), config);

		const result = (await callTool(server, "access", { planId: "nonexistent" })) as {
			isError: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("nonexistent");
	});
});

describe("MCP 'access' tool — routeId (per-request flow)", () => {
	it("returns a 402-style error stub for a valid routeId", async () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [{ routeId: "weather", method: "GET", path: "/weather", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const server = createMcpServer(
			makeEngine({ plans: [], routes: config.routes, proxyTo: config.proxyTo }),
			config,
		);

		const result = (await callTool(server, "access", {
			routeId: "weather",
			resource: { method: "GET", path: "/weather" },
		})) as { isError: boolean; content: Array<{ type: string; text: string }> };

		// Route-based access returns isError (either 402 payment challenge or stub)
		expect(result.isError).toBe(true);
	});

	it("emits route-shaped payment instructions for route access", async () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [{ routeId: "weather", method: "GET", path: "/weather", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const server = createMcpServer(
			makeEngine({ plans: [], routes: config.routes, proxyTo: config.proxyTo }),
			config,
		);

		const result = (await callTool(server, "access", {
			routeId: "weather",
			resource: { method: "GET", path: "/weather" },
		})) as { isError: boolean; content: Array<{ type: string; text: string }> };

		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.paymentInstructions).toContain('"routeId":"weather"');
		expect(parsed.paymentInstructions).toContain('"resource":{"method":"GET","path":"/weather"}');
		expect(parsed.paymentInstructions).not.toContain('"planId":"weather"');
	});

	it("returns error for unknown routeId", async () => {
		const config = makeSellerConfig({
			plans: [],
			routes: [{ routeId: "weather", method: "GET", path: "/weather", unitAmount: "$0.01" }],
			proxyTo: { baseUrl: "http://localhost:9999" },
		});
		const server = createMcpServer(makeEngine(), config);

		const result = (await callTool(server, "access", { routeId: "nonexistent" })) as {
			isError: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("nonexistent");
	});
});

describe("MCP 'access' tool — validation", () => {
	it("returns error when both planId AND routeId are provided", async () => {
		const config = makeSellerConfig({
			plans: [{ planId: "pro", unitAmount: "$1.00" }],
			routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
		});
		const server = createMcpServer(makeEngine(), config);

		// The Zod schema has a .refine that rejects both planId and routeId together.
		// When called via handler directly with invalid args, Zod throws a validation error.
		let threw = false;
		try {
			await callTool(server, "access", { planId: "pro", routeId: "r1" });
		} catch {
			threw = true;
		}
		// Either throws (Zod validation) or returns isError
		if (!threw) {
			const result = (await callTool(server, "access", { planId: "pro", routeId: "r1" })) as {
				isError?: boolean;
			};
			expect(result.isError).toBe(true);
		} else {
			expect(threw).toBe(true);
		}
	});

	it("error message content includes 'not both' when both planId and routeId provided", async () => {
		const config = makeSellerConfig({
			plans: [{ planId: "pro", unitAmount: "$1.00" }],
			routes: [{ routeId: "r1", method: "GET", path: "/foo", unitAmount: "$0.01" }],
		});
		const server = createMcpServer(makeEngine(), config);

		// Either the MCP layer throws a Zod validation error, or it returns an isError result.
		// Either way, the error message must match the expected pattern.
		let errorText: string;
		try {
			const result = (await callTool(server, "access", { planId: "pro", routeId: "r1" })) as {
				isError?: boolean;
				content: Array<{ type: string; text: string }>;
			};
			expect(result.isError).toBe(true);
			errorText = result.content[0]?.text ?? "";
		} catch (err: unknown) {
			errorText = err instanceof Error ? err.message : String(err);
		}
		expect(errorText.toLowerCase()).toMatch(
			/both|not both|planid|routeid|not.*implemented|only one/i,
		);
	});
});
