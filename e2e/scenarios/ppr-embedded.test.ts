/**
 * PPR Embedded — verifies the pay-per-request flow when Key0 middleware is
 * embedded directly inside the application server (no proxy/gateway).
 *
 * Starts a local in-process Express server in beforeAll. The server mounts
 * key0Router + key0.payPerRequest() on two routes:
 *   GET /api/weather/:city  (routeId: weather-query,    $0.01)
 *   GET /api/joke           (routeId: joke-of-the-day,  $0.005)
 *
 * Clients call these routes directly. Without a PAYMENT-SIGNATURE header
 * the server returns 402 with payment requirements. With a valid payment
 * the route handler runs and returns the API response (+ txHash).
 *
 * Scenarios:
 *   1. No payment header → 402 with challengeId + payment requirements
 *   2. Happy path — weather route  → HTTP 200, city + txHash, no accessToken
 *   3. Happy path — joke route     → HTTP 200, joke + txHash
 *   4. Double-spend (embedded)     → second call with same auth rejected
 *   5. State verification          → PAID → DELIVERED after successful handler
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import Redis from "ioredis";
import type { NetworkName, PaymentInfo } from "../../src/index.ts";
import { RedisChallengeStore, RedisSeenTxStore, X402Adapter } from "../../src/index.ts";
import { key0Router } from "../../src/integrations/express.ts";
import { PPR_JOKE_ROUTE_ID, PPR_WEATHER_ROUTE_ID } from "../fixtures/constants.ts";
import { makeClientE2eClient } from "../fixtures/wallets.ts";

// ── Server config (uses the same env vars as the rest of the e2e suite) ──────

const EMBEDDED_PORT = 3003;
const EMBEDDED_URL = `http://localhost:${EMBEDDED_PORT}`;
const EMBEDDED_REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const NETWORK = (process.env["KEY0_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = process.env["KEY0_WALLET_ADDRESS"] as `0x${string}` | undefined;
const GAS_WALLET_KEY = process.env["GAS_WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;

let server: Server | null = null;
let embeddedRedis: Redis | null = null;

/** Read embedded challenge state directly from Redis. */
async function readEmbeddedChallengeState(challengeId: string): Promise<string | null> {
	if (!embeddedRedis) return null;
	return embeddedRedis.hget(`key0:challenge:${challengeId}`, "state");
}

beforeAll(async () => {
	if (!WALLET) {
		throw new Error("KEY0_WALLET_ADDRESS env var is required for embedded PPR tests");
	}
	if (!GAS_WALLET_KEY) {
		throw new Error("GAS_WALLET_PRIVATE_KEY env var is required for embedded PPR tests");
	}

	// Dedicated Redis connection (avoid polluting shared storage-client state)
	embeddedRedis = new Redis(EMBEDDED_REDIS_URL);
	embeddedRedis.on("error", (err) => {
		console.error("[ppr-embedded redis] connection error:", err.message);
	});

	const redis = new Redis(EMBEDDED_REDIS_URL);
	const store = new RedisChallengeStore({ redis });
	const seenTxStore = new RedisSeenTxStore({ redis });
	const ALCHEMY_RPC = process.env["ALCHEMY_BASE_SEPOLIA_RPC_URL"];
	const adapter = new X402Adapter({
		network: NETWORK,
		...(ALCHEMY_RPC ? { rpcUrl: ALCHEMY_RPC } : {}),
	});

	const app = express();
	app.use(express.json());

	// Routes are top-level in SellerConfig (no mode: "per-request" on plans).
	// proxyTo is not required in embedded mode — key0.payPerRequest() calls next()
	// and the route handler itself returns the response.
	const key0 = key0Router({
		config: {
			agentName: "Embedded PPR e2e Server",
			agentDescription: "In-process Key0 server for embedded PPR e2e tests",
			agentUrl: EMBEDDED_URL,
			providerName: "e2e",
			providerUrl: "https://localhost",
			walletAddress: WALLET,
			network: NETWORK,
			gasWalletPrivateKey: GAS_WALLET_KEY,
			// Cast required: ioredis Redis has a wider .set() overload signature than IRedisLockClient
			redis: redis as any,
			challengeTTLSeconds: 300,
			routes: [
				{
					routeId: PPR_WEATHER_ROUTE_ID,
					method: "GET",
					path: "/api/weather/:city",
					unitAmount: "$0.01",
					description: "Weather query per request",
				},
				{
					routeId: PPR_JOKE_ROUTE_ID,
					method: "GET",
					path: "/api/joke",
					unitAmount: "$0.005",
					description: "Joke per request",
				},
			],
			// No fetchResourceCredentials — routes-only config does not issue tokens
			// No proxyTo — embedded mode: payPerRequest calls next(), handler returns response
		},
		adapter,
		store,
		seenTxStore,
	});

	app.use(key0);

	// Gated route: weather
	app.get(
		"/api/weather/:city",
		key0.payPerRequest(PPR_WEATHER_ROUTE_ID, {
			onPayment: (info: PaymentInfo) => {
				console.log(`[ppr-embedded] weather settled | tx=${info.txHash}`);
			},
		}),
		(req, res) => {
			const payment = (req as { key0Payment?: PaymentInfo }).key0Payment;
			const city = req.params["city"] ?? "unknown";
			res.json({
				city,
				tempF: 72,
				condition: "Sunny",
				txHash: payment?.txHash ?? null,
				challengeId: payment?.challengeId ?? null,
			});
		},
	);

	// Gated route: joke
	app.get(
		"/api/joke",
		key0.payPerRequest(PPR_JOKE_ROUTE_ID, {
			onPayment: (info: PaymentInfo) => {
				console.log(`[ppr-embedded] joke settled | tx=${info.txHash}`);
			},
		}),
		(req, res) => {
			const payment = (req as { key0Payment?: PaymentInfo }).key0Payment;
			res.json({
				joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
				txHash: payment?.txHash ?? null,
				challengeId: payment?.challengeId ?? null,
			});
		},
	);

	server = await new Promise((resolve) => {
		const s = app.listen(EMBEDDED_PORT, () => {
			console.log(`[ppr-embedded] Server listening on port ${EMBEDDED_PORT}`);
			resolve(s);
		});
	});
}, 30_000);

afterAll(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = null;
	}
	if (embeddedRedis) {
		await embeddedRedis.quit();
		embeddedRedis = null;
	}
});

describe("PPR Embedded: 402 challenge flow", () => {
	test("no payment header → 402 with payment-required header", async () => {
		const client = makeClientE2eClient(EMBEDDED_URL);

		// Note: unlike /x402/access (subscription), the embedded payPerRequest
		// middleware does NOT pre-create a challenge — it uses the x402 format
		// directly. The challengeId is only created at settlement time.
		const { status, paymentRequired } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/weather/london",
			serverUrl: EMBEDDED_URL,
		});

		expect(status).toBe(402);
		expect(paymentRequired).toBeDefined();
		expect(paymentRequired!.accepts.length).toBeGreaterThan(0);

		const requirements = paymentRequired!.accepts[0]!;
		expect(requirements.scheme).toBe("exact");
		expect(requirements.network).toBe("eip155:84532");
		expect(BigInt(requirements.amount)).toBeGreaterThan(0n);
		expect(requirements.payTo).toMatch(/^0x/);
	}, 30_000);
});

describe("PPR Embedded: happy path", () => {
	test("weather route — HTTP 200 with city data, txHash, no accessToken", async () => {
		const client = makeClientE2eClient(EMBEDDED_URL);

		// Step 1: call route without payment → 402
		const { paymentRequired } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/weather/paris",
			serverUrl: EMBEDDED_URL,
		});
		expect(paymentRequired).toBeDefined();

		const requirements = paymentRequired!.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Step 2: retry with payment signature
		const { status, body } = await client.submitEmbeddedPayment({
			method: "GET",
			path: "/api/weather/paris",
			auth,
			paymentRequired: paymentRequired!,
			serverUrl: EMBEDDED_URL,
		});

		expect(status).toBe(200);
		const b = body as Record<string, unknown>;
		expect(b["city"]).toBe("paris");
		expect(b["tempF"]).toBeDefined();
		expect(typeof b["txHash"]).toBe("string");
		expect(b["txHash"] as string).toMatch(/^0x/);

		// No subscription fields
		expect(b["accessToken"]).toBeUndefined();
		expect(b["tokenType"]).toBeUndefined();
	}, 120_000);

	test("joke route — HTTP 200 with joke and txHash", async () => {
		const client = makeClientE2eClient(EMBEDDED_URL);

		const { paymentRequired } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/joke",
			serverUrl: EMBEDDED_URL,
		});
		expect(paymentRequired).toBeDefined();

		const requirements = paymentRequired!.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		const { status, body } = await client.submitEmbeddedPayment({
			method: "GET",
			path: "/api/joke",
			auth,
			paymentRequired: paymentRequired!,
			serverUrl: EMBEDDED_URL,
		});

		expect(status).toBe(200);
		const b = body as Record<string, unknown>;
		expect(typeof b["joke"]).toBe("string");
		expect((b["joke"] as string).length).toBeGreaterThan(0);
		expect(typeof b["txHash"]).toBe("string");
	}, 120_000);
});

describe("PPR Embedded: double-spend protection", () => {
	test("same auth rejected on second embedded route call", async () => {
		const client = makeClientE2eClient(EMBEDDED_URL);

		// First call: get 402
		const { paymentRequired: pr1 } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/weather/berlin",
			serverUrl: EMBEDDED_URL,
		});
		expect(pr1).toBeDefined();

		const requirements = pr1!.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// First payment — should succeed
		const result1 = await client.submitEmbeddedPayment({
			method: "GET",
			path: "/api/weather/berlin",
			auth,
			paymentRequired: pr1!,
			serverUrl: EMBEDDED_URL,
		});
		expect(result1.status).toBe(200);

		// Second call with same auth on a fresh 402 — burned nonce should be rejected
		const { paymentRequired: pr2 } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/weather/sydney",
			serverUrl: EMBEDDED_URL,
		});
		expect(pr2).toBeDefined();

		const result2 = await client.submitEmbeddedPayment({
			method: "GET",
			path: "/api/weather/sydney",
			auth, // reused nonce
			paymentRequired: pr2!,
			serverUrl: EMBEDDED_URL,
		});

		expect(result2.status).not.toBe(200);
	}, 120_000);
});

describe("PPR Embedded: state verification", () => {
	test("challenge transitions PAID → DELIVERED after successful route handler", async () => {
		const client = makeClientE2eClient(EMBEDDED_URL);

		// Step 1: call route without payment → get payment requirements
		// Note: in embedded mode there is no pre-created challenge; challengeId is
		// only assigned during settlement and returned in the route handler response.
		const { paymentRequired } = await client.callEmbeddedRoute({
			method: "GET",
			path: "/api/weather/madrid",
			serverUrl: EMBEDDED_URL,
		});
		expect(paymentRequired).toBeDefined();

		const requirements = paymentRequired!.accepts[0]!;
		const auth = await client.signEIP3009({
			destination: requirements.payTo as `0x${string}`,
			amountRaw: BigInt(requirements.amount),
		});

		// Step 2: submit payment — route handler echoes back challengeId in body
		const { status, body } = await client.submitEmbeddedPayment({
			method: "GET",
			path: "/api/weather/madrid",
			auth,
			paymentRequired: paymentRequired!,
			serverUrl: EMBEDDED_URL,
		});
		expect(status).toBe(200);

		// challengeId is echoed by the route handler via req.key0Payment.challengeId
		const challengeId = (body as Record<string, unknown>)["challengeId"] as string;
		expect(typeof challengeId).toBe("string");
		expect(challengeId).toMatch(/^ppr-/);

		// The middleware calls markDelivered synchronously before calling next(),
		// so by the time the handler responds the state should already be DELIVERED.
		const finalState = await readEmbeddedChallengeState(challengeId);
		expect(finalState).toBe("DELIVERED");
	}, 120_000);
});
