import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseCli, runDiscover, runMain, runRequest } from "../cli-template.js";

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

	test("parses '-h' shorthand", () => {
		const result = parseCli(["-h"]);
		expect(result).toEqual({ command: "help" });
	});

	test("parses '--version'", () => {
		const result = parseCli(["--version"]);
		expect(result).toEqual({ command: "version" });
	});

	test("parses '-v' shorthand", () => {
		const result = parseCli(["-v"]);
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

	test("returns error when --plan flag has no value", () => {
		// "--plan" is the last arg, value is undefined
		const result = parseCli(["request", "--plan"]);
		expect(result).toEqual({ command: "error", message: "Missing required flag: --plan" });
	});

	test("ignores unknown flags in request command", () => {
		const result = parseCli(["request", "--plan", "basic", "--unknown", "value"]);
		expect(result).toEqual({ command: "request", plan: "basic" });
	});

	test("parses request with all optional flags", () => {
		const result = parseCli([
			"request",
			"--plan",
			"pro",
			"--resource",
			"res-456",
			"--payment-signature",
			"eyJhbGciOiJIUzI1NiJ9",
		]);
		expect(result).toEqual({
			command: "request",
			plan: "pro",
			resource: "res-456",
			paymentSignature: "eyJhbGciOiJIUzI1NiJ9",
		});
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
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://api.example.com/discovery",
			expect.objectContaining({
				method: "GET",
				headers: { Accept: "application/json" },
			}),
		);
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

	test("returns exit 1 on non-2xx HTTP status", async () => {
		const mockError = { type: "Error", code: "INTERNAL_ERROR", message: "Server error" };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockError), { status: 500 })),
		) as unknown as typeof fetch;

		const result = await runDiscover("https://api.example.com");
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual(mockError);
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

	test("sends planId in body", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ x402Version: 2, accepts: [] }), { status: 402 }),
			),
		) as unknown as typeof fetch;
		await runRequest("https://api.example.com", "single-photo");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const fetchOpts = call![1] as RequestInit;
		const body = JSON.parse(fetchOpts.body as string);
		expect(body.planId).toBe("single-photo");
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

	test("sends both resourceId and payment-signature when both provided", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ accessToken: "jwt..." }), { status: 200 })),
		) as unknown as typeof fetch;
		await runRequest("https://api.example.com", "pro", "res-456", "eyJhbGciOiJIUzI1NiJ9");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const fetchOpts = call![1] as RequestInit;
		const body = JSON.parse(fetchOpts.body as string);
		expect(body.planId).toBe("pro");
		expect(body.resourceId).toBe("res-456");
		expect((fetchOpts.headers as Record<string, string>)["payment-signature"]).toBe(
			"eyJhbGciOiJIUzI1NiJ9",
		);
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

describe("runMain", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("--help returns help JSON with name and url", async () => {
		const result = await runMain(["--help"], "mycli", "https://api.example.com");
		expect(result.exitCode).toBe(0);
		expect(result.output).toEqual({
			name: "mycli",
			url: "https://api.example.com",
			commands: {
				discover: "List available plans (GET /discovery)",
				request: "Request access or submit payment (POST /x402/access)",
			},
			flags: {
				"--plan": "Plan ID (required for request)",
				"--resource": "Resource ID (optional, defaults to 'default')",
				"--payment-signature": "Base64-encoded x402 payment payload from payments-mcp",
				"--install": "Install this binary to PATH (~/.local/bin or /usr/local/bin)",
			},
		});
	});

	test("--version returns version JSON", async () => {
		const result = await runMain(["--version"], "mycli", "https://api.example.com");
		expect(result.exitCode).toBe(0);
		expect(result.output["name"]).toBe("mycli");
		expect(result.output["url"]).toBe("https://api.example.com");
		expect(result.output).toHaveProperty("version");
	});

	test("unknown command returns error with exit 1", async () => {
		const result = await runMain(["foobar"], "mycli", "https://api.example.com");
		expect(result.exitCode).toBe(1);
		expect(result.output["error"]).toBe('Unknown command: "foobar"');
		expect(result.output["code"]).toBe("INVALID_REQUEST");
	});

	test("discover delegates to runDiscover", async () => {
		const mockBody = { discoveryResponse: { x402Version: 2 } };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockBody), { status: 200 })),
		) as unknown as typeof fetch;
		const result = await runMain(["discover"], "mycli", "https://api.example.com");
		expect(result.exitCode).toBe(0);
		expect(result.output).toEqual(mockBody);
	});

	test("request delegates to runRequest and returns 402", async () => {
		const mockBody = { x402Version: 2, accepts: [], error: "Payment required" };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(mockBody), { status: 402 })),
		) as unknown as typeof fetch;
		const result = await runMain(
			["request", "--plan", "single-photo"],
			"mycli",
			"https://api.example.com",
		);
		expect(result.exitCode).toBe(42);
	});
});
