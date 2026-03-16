import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseCli, runDiscover, runRequest } from "../cli-template.js";

const originalFetch = globalThis.fetch;

describe("parseCli", () => {
	test("parses 'discover' command", () => {
		const result = parseCli(["discover"]);
		expect(result).toEqual({ command: "discover" });
	});

	test("parses 'request --plan single-photo'", () => {
		const result = parseCli(["request", "--plan", "single-photo"]);
		expect(result).toEqual({ command: "request", plan: "single-photo" });
	});

	test("parses 'request --plan single-photo --resource img-123'", () => {
		const result = parseCli(["request", "--plan", "single-photo", "--resource", "img-123"]);
		expect(result).toEqual({ command: "request", plan: "single-photo", resource: "img-123" });
	});

	test("parses 'request --plan single-photo --payment-signature eyJhbG...'", () => {
		const result = parseCli([
			"request",
			"--plan",
			"single-photo",
			"--payment-signature",
			"eyJhbGciOiJIUzI1NiJ9",
		]);
		expect(result).toEqual({
			command: "request",
			plan: "single-photo",
			paymentSignature: "eyJhbGciOiJIUzI1NiJ9",
		});
	});

	test("parses '--help'", () => {
		const result = parseCli(["--help"]);
		expect(result).toEqual({ command: "help" });
	});

	test("parses '--version'", () => {
		const result = parseCli(["--version"]);
		expect(result).toEqual({ command: "version" });
	});

	test("returns error for unknown command", () => {
		const result = parseCli(["foobar"]);
		expect(result).toEqual({ command: "error", message: 'Unknown command: "foobar"' });
	});

	test("returns error when request missing --plan", () => {
		const result = parseCli(["request"]);
		expect(result).toEqual({ command: "error", message: "Missing required flag: --plan" });
	});

	test("returns help for no arguments", () => {
		const result = parseCli([]);
		expect(result).toEqual({ command: "help" });
	});
});

describe("runDiscover", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("calls GET /discovery and returns JSON body", async () => {
		const mockBody = { discoveryResponse: { x402Version: 2, accepts: [] } };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockBody), { status: 200 })),
		) as unknown as typeof fetch;
		const result = await runDiscover("https://api.example.com");
		expect(result).toEqual({ exitCode: 0, output: mockBody });
		expect(globalThis.fetch).toHaveBeenCalledWith("https://api.example.com/discovery", {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	});

	test("returns NETWORK_ERROR on fetch failure", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("Connection refused")),
		) as unknown as typeof fetch;
		const result = await runDiscover("https://api.example.com");
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual({ error: "Connection refused", code: "NETWORK_ERROR" });
	});

	test("returns INVALID_RESPONSE on non-JSON response", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("not json", { status: 200 })),
		) as unknown as typeof fetch;
		const result = await runDiscover("https://api.example.com");
		expect(result.exitCode).toBe(1);
		expect(result.output["code"]).toBe("INVALID_RESPONSE");
	});
});

describe("runRequest", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("sends POST with planId and returns 402 challenge with exit 42", async () => {
		const mockBody = {
			x402Version: 2,
			accepts: [],
			challengeId: "ch_1",
			requestId: "req_1",
			error: "Payment required",
		};
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockBody), { status: 402 })),
		) as unknown as typeof fetch;
		const result = await runRequest("https://api.example.com", "single-photo");
		expect(result).toEqual({ exitCode: 42, output: mockBody });
	});

	test("sends POST with payment-signature header, returns 200 grant", async () => {
		const mockGrant = {
			accessToken: "jwt...",
			txHash: "0xabc",
			expiresAt: "2026-03-16T12:00:00Z",
		};
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockGrant), { status: 200 })),
		) as unknown as typeof fetch;
		const result = await runRequest(
			"https://api.example.com",
			"single-photo",
			undefined,
			"eyJhbGciOiJIUzI1NiJ9",
		);
		expect(result).toEqual({ exitCode: 0, output: mockGrant });
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const fetchOpts = call![1] as RequestInit;
		expect((fetchOpts.headers as Record<string, string>)["payment-signature"]).toBe(
			"eyJhbGciOiJIUzI1NiJ9",
		);
	});

	test("passes resourceId in body when provided", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ x402Version: 2, accepts: [] }), { status: 402 }),
			),
		) as unknown as typeof fetch;
		await runRequest("https://api.example.com", "single-photo", "img-123");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const fetchOpts = call![1] as RequestInit;
		const body = JSON.parse(fetchOpts.body as string);
		expect(body.resourceId).toBe("img-123");
	});

	test("returns server error with exit 1 on 4xx/5xx", async () => {
		const mockError = { type: "Error", code: "TIER_NOT_FOUND", message: "Plan not found" };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockError), { status: 400 })),
		) as unknown as typeof fetch;
		const result = await runRequest("https://api.example.com", "nonexistent");
		expect(result).toEqual({ exitCode: 1, output: mockError });
	});

	test("returns NETWORK_ERROR on fetch failure", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch;
		const result = await runRequest("https://api.example.com", "single-photo");
		expect(result.exitCode).toBe(1);
		expect(result.output["code"]).toBe("NETWORK_ERROR");
	});
});
