/**
 * Key0 Gateway — demonstrates coexistence of subscription plans and per-request routes.
 *
 * Two ways to access /api/weather/:city:
 *   1. Subscribe: POST /x402/access { planId: "basic" } → pay $5 → get Bearer token
 *      → call backend directly: GET /api/weather/london  (Authorization: Bearer <token>)
 *   2. Pay-per-use: POST /x402/access { planId: "weather-query", resource: { method: "GET", path: "/api/weather/london" } }
 *      → pay $0.10 → Key0 proxies to backend and returns data inline (no token issued)
 *
 * The backend (see backend.ts) accepts requests from EITHER path:
 *   - Subscription clients present a Bearer JWT (validated locally, no gateway in path).
 *   - PPR clients arrive via Key0 proxy, identified by the X-Key0-Internal-Token header.
 *
 * Start order:
 *   1. bun run start:backend   (port 3001)
 *   2. bun run start:gateway   (port 3000)
 */

import type { NetworkName } from "@key0ai/key0";
import {
	AccessTokenIssuer,
	RedisChallengeStore,
	RedisSeenTxStore,
	X402Adapter,
} from "@key0ai/key0";
import { key0Router } from "@key0ai/key0/express";
import express from "express";
import Redis from "ioredis";

const GATEWAY_PORT = Number(process.env["GATEWAY_PORT"] ?? 3000);
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? `http://localhost:${GATEWAY_PORT}`;
const BACKEND_URL = process.env["BACKEND_URL"] ?? "http://localhost:3001";
const NETWORK = (process.env["KEY0_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = (process.env["KEY0_WALLET_ADDRESS"] ??
	"0x0000000000000000000000000000000000000000") as `0x${string}`;
const SECRET =
	process.env["KEY0_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
// Shared secret injected into every proxied request so the backend can verify Key0 origin.
const PROXY_SECRET = process.env["KEY0_PROXY_SECRET"] ?? "dev-proxy-secret-change-in-production!!";
// Gas wallet private key for self-contained on-chain settlement (no Coinbase facilitator needed).
const GAS_WALLET_KEY = process.env["GAS_WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;

const app = express();
app.use(express.json());

const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env["KEY0_RPC_URL"],
});

const redis = new Redis(REDIS_URL);
const store = new RedisChallengeStore({ redis });
const seenTxStore = new RedisSeenTxStore({ redis });

// Token issuer for subscription plans — issues a signed JWT after payment.
// Subscription clients store this token and call the backend directly with Bearer auth.
const tokenIssuer = new AccessTokenIssuer(SECRET);

/**
 * Issue a JWT for a given subscription plan.
 * In production, customise expiry and claims to match your access model.
 */
async function issueJwtForPlan(
	planId: string,
	challengeId: string,
	txHash: string,
): Promise<string> {
	const { token } = await tokenIssuer.sign(
		{
			sub: challengeId,
			jti: challengeId,
			resourceId: planId,
			planId,
			txHash,
		},
		// 30 days TTL for subscription access
		60 * 60 * 24 * 30,
	);
	return token;
}

const key0 = key0Router({
	config: {
		agentName: "Weather API",
		agentDescription:
			"Weather data API — available via subscription (Bearer JWT) or pay-per-request. " +
			"Both access patterns are accepted by the backend.",
		agentUrl: PUBLIC_URL,
		providerName: "Example Corp",
		providerUrl: "https://example.com",
		walletAddress: WALLET,
		network: NETWORK,
		challengeTTLSeconds: 300,
		...(GAS_WALLET_KEY ? { gasWalletPrivateKey: GAS_WALLET_KEY } : {}),

		// ── Subscription plans ───────────────────────────────────────────────
		// Clients pay once, receive a Bearer JWT, and call the backend directly.
		// Key0 is NOT in the request path after token issuance.
		plans: [
			{
				planId: "basic",
				unitAmount: "$5.00",
				description: "100 API calls — pay once, use your token for ongoing access",
			},
		],
		fetchResourceCredentials: async ({ planId, challengeId, txHash }) => ({
			token: await issueJwtForPlan(planId, challengeId, txHash),
			tokenType: "Bearer",
		}),

		// ── Per-request routes ───────────────────────────────────────────────
		// Clients pay per call. Key0 settles the payment and proxies the request
		// to the backend, returning the backend response inline — no token issued.
		routes: [
			{
				routeId: "weather-query",
				method: "GET" as const,
				path: "/api/weather/:city",
				unitAmount: "$0.10",
				description: "Pay per query — no subscription needed",
			},
			{
				routeId: "joke-of-the-day",
				method: "GET" as const,
				path: "/api/joke",
				unitAmount: "$0.005",
				description: "Get a random programming joke",
			},
			{
				routeId: "health",
				method: "GET" as const,
				path: "/health",
				// no unitAmount = free
			},
		],

		// proxyTo enables standalone mode: after payment, Key0 forwards the request
		// to the backend and returns the response directly.
		// proxySecret is sent as X-Key0-Internal-Token so the backend can reject
		// requests that bypass the gateway.
		proxyTo: {
			baseUrl: BACKEND_URL,
			proxySecret: PROXY_SECRET,
		},
	},
	adapter,
	store,
	seenTxStore,
});

// Mount Key0 — serves agent card, /discovery, and /x402/access.
app.use(key0);

app.listen(GATEWAY_PORT, () => {
	console.log(`\nWeather API Gateway (Key0) running on ${PUBLIC_URL}`);
	console.log(`  Agent card:    ${PUBLIC_URL}/.well-known/agent.json`);
	console.log(`  Discovery:     GET ${PUBLIC_URL}/discovery`);
	console.log(`  x402 endpoint: POST ${PUBLIC_URL}/x402/access`);
	console.log(`\n  Subscription flow (pay once, call backend directly):`);
	console.log(`    POST ${PUBLIC_URL}/x402/access  { planId: "basic" }`);
	console.log(`    → 402 Payment Required ($5.00)`);
	console.log(`    → Pay USDC on-chain → receive Bearer JWT`);
	console.log(`    → GET http://localhost:3001/api/weather/london`);
	console.log(`         Authorization: Bearer <token>   (Key0 not in path)`);
	console.log(`\n  Pay-per-request flow (pay per call, Key0 proxies):`);
	console.log(`    POST ${PUBLIC_URL}/x402/access`);
	console.log(
		`         { routeId: "weather-query", resource: { method: "GET", path: "/api/weather/london" } }`,
	);
	console.log(`    → 402 Payment Required ($0.10)`);
	console.log(`    → Pay USDC on-chain → Key0 proxies to backend → 200 ResourceResponse`);
	console.log(`\n  Backend: ${BACKEND_URL}`);
	console.log(`  Network: ${NETWORK}`);
	console.log(`  Wallet:  ${WALLET}\n`);
});
