import { describe, expect, it } from "bun:test";
import { createMcpServer } from "../mcp.js";
import { makeSellerConfig, TestChallengeStore, TestSeenTxStore, MockPaymentAdapter } from "../../test-utils/index.js";
import { ChallengeEngine } from "../../core/challenge-engine.js";

function makeEngine(configOverrides = {}) {
	const config = makeSellerConfig(configOverrides);
	return new ChallengeEngine({
		config,
		store: new TestChallengeStore(),
		seenTxStore: new TestSeenTxStore(),
		adapter: new MockPaymentAdapter(),
	});
}

describe("MCP tool registration", () => {
	it("registers 'discover' not 'discover_plans'", () => {
		const server = createMcpServer(makeEngine(), makeSellerConfig());
		// MCP SDK exposes registered tools via internal map
		const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
		expect(Object.keys(tools)).toContain("discover");
		expect(Object.keys(tools)).not.toContain("discover_plans");
	});

	it("registers 'access' not 'request_access'", () => {
		const server = createMcpServer(makeEngine(), makeSellerConfig());
		const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
		expect(Object.keys(tools)).toContain("access");
		expect(Object.keys(tools)).not.toContain("request_access");
	});
});
