import type { NetworkName, PaymentInfo } from "@key0ai/key0";
import {
	AccessTokenIssuer,
	RedisChallengeStore,
	RedisSeenTxStore,
	X402Adapter,
} from "@key0ai/key0";
import { key0Router } from "@key0ai/key0/express";
import express from "express";
import Redis from "ioredis";

const PORT = Number(process.env["PORT"] ?? 3000);
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? `http://localhost:${PORT}`;
const NETWORK = (process.env["KEY0_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = (process.env["KEY0_WALLET_ADDRESS"] ??
	"0x0000000000000000000000000000000000000000") as `0x${string}`;
const SECRET =
	process.env["KEY0_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
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

// Required by SellerConfig for the subscription /x402/access endpoint.
// Per-request routes never call this — they settle inline via the payPerRequest middleware.
const _tokenIssuer = new AccessTokenIssuer(SECRET);

const key0 = key0Router({
	config: {
		agentName: "Pay-Per-Request Demo (Embedded)",
		agentDescription:
			"Micro-payment gated API running in embedded mode. Routes are gated inline — no token issuance, just pay and get your response.",
		agentUrl: PUBLIC_URL,
		providerName: "Example Corp",
		providerUrl: "https://example.com",
		walletAddress: WALLET,
		network: NETWORK,
		challengeTTLSeconds: 300,
		...(GAS_WALLET_KEY ? { gasWalletPrivateKey: GAS_WALLET_KEY } : {}),
		routes: [
			{
				routeId: "weather-query",
				method: "GET",
				path: "/api/weather/:city",
				unitAmount: "$0.01",
				description: "Current weather conditions for a given city",
			},
			{
				routeId: "joke-of-the-day",
				method: "GET",
				path: "/api/joke",
				unitAmount: "$0.005",
				description: "Get a random programming joke",
			},
		],
	},
	adapter,
	store,
	seenTxStore,
});

// Mount Key0 — serves agent card, /discovery, and /x402/access
app.use(key0);

// ── Gated route: GET /api/weather/:city ─────────────────────────────────────
// key0.payPerRequest returns an Express middleware. When a PAYMENT-SIGNATURE
// header is present it settles on-chain and calls next(); otherwise returns 402.
// After settlement, req.key0Payment holds the payment metadata.
app.get(
	"/api/weather/:city",
	key0.payPerRequest("weather-query", {
		onPayment: (info: PaymentInfo) => {
			console.log(`[PPR] weather-query settled | tx=${info.txHash} | path=${info.path}`);
		},
	}),
	(req, res) => {
		const payment = (req as { key0Payment?: PaymentInfo }).key0Payment;
		const city = req.params["city"] ?? "unknown";

		const conditions = ["Sunny", "Cloudy", "Rainy", "Windy", "Partly Cloudy"];
		res.json({
			city,
			tempF: Math.round(55 + Math.random() * 35),
			condition: conditions[Math.floor(Math.random() * conditions.length)],
			humidity: `${Math.round(40 + Math.random() * 40)}%`,
			txHash: payment?.txHash,
		});
	},
);

// ── Gated route: GET /api/joke ───────────────────────────────────────────────
app.get(
	"/api/joke",
	key0.payPerRequest("joke-of-the-day", {
		onPayment: (info: PaymentInfo) => {
			console.log(`[PPR] joke-of-the-day settled | tx=${info.txHash}`);
		},
	}),
	(req, res) => {
		const payment = (req as { key0Payment?: PaymentInfo }).key0Payment;

		const jokes = [
			"Why do programmers prefer dark mode? Because light attracts bugs.",
			"A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
			"Why did the developer go broke? Because he used up all his cache.",
			"There are only 10 types of people in the world: those who understand binary, and those who don't.",
			"Why do Java developers wear glasses? Because they don't C#.",
		];

		res.json({
			joke: jokes[Math.floor(Math.random() * jokes.length)],
			txHash: payment?.txHash,
		});
	},
);

app.listen(PORT, () => {
	console.log(`\nPay-Per-Request Demo (Embedded) running on ${PUBLIC_URL}`);
	console.log(`  Agent card:    ${PUBLIC_URL}/.well-known/agent.json`);
	console.log(`  Discovery:     GET ${PUBLIC_URL}/discovery`);
	console.log(`  x402 endpoint: ${PUBLIC_URL}/x402/access`);
	console.log(`  Weather API:   GET ${PUBLIC_URL}/api/weather/:city`);
	console.log(`  Joke API:      GET ${PUBLIC_URL}/api/joke`);
	console.log(`  Network: ${NETWORK}`);
	console.log(`  Wallet:  ${WALLET}\n`);
});
