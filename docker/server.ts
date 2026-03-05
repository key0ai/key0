/**
 * AgentGate Docker Standalone Server
 *
 * Configured entirely via environment variables.
 * Set AGENTGATE_WALLET_ADDRESS + ISSUE_TOKEN_API and you're done.
 *
 * See docker/.env.example for the full list of env vars.
 */

import {
	type IChallengeStore,
	type NetworkName,
	type ProductTier,
	RedisChallengeStore,
	RedisSeenTxStore,
	X402Adapter,
	processRefunds,
} from "@riklr/agentgate";
import { agentGateRouter } from "@riklr/agentgate/express";
import express from "express";
import { buildDockerTokenIssuer } from "../src/helpers/docker-token-issuer.js";

// ─── Required env vars ─────────────────────────────────────────────────────

const WALLET_ADDRESS = process.env.AGENTGATE_WALLET_ADDRESS;
const ISSUE_TOKEN_API = process.env.ISSUE_TOKEN_API;

if (!WALLET_ADDRESS) {
	console.error("FATAL: AGENTGATE_WALLET_ADDRESS is required (e.g. 0xYourWallet...)");
	process.exit(1);
}

if (!ISSUE_TOKEN_API) {
	console.error("FATAL: ISSUE_TOKEN_API is required (e.g. https://api.example.com/issue-token)");
	process.exit(1);
}

// ─── Optional env vars ─────────────────────────────────────────────────────

const NETWORK = (process.env.AGENTGATE_NETWORK ?? "testnet") as NetworkName;
const PORT = Number(process.env.PORT ?? 3000);
const AGENT_NAME = process.env.AGENT_NAME ?? "AgentGate Server";
const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint";
const AGENT_URL = process.env.AGENT_URL ?? `http://localhost:${PORT}`;
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "AgentGate";
const PROVIDER_URL = process.env.PROVIDER_URL ?? "https://agentgate.dev";
const BASE_PATH = process.env.BASE_PATH ?? "/a2a";
const CHALLENGE_TTL_SECONDS = Number(process.env.CHALLENGE_TTL_SECONDS ?? 900);
const ISSUE_TOKEN_API_SECRET = process.env.ISSUE_TOKEN_API_SECRET;
const REDIS_URL = process.env.REDIS_URL;
const GAS_WALLET_PRIVATE_KEY = process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_PRIVATE_KEY = process.env.AGENTGATE_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const REFUND_INTERVAL_MS = Number(process.env.REFUND_INTERVAL_MS ?? 60_000);
const REFUND_MIN_AGE_MS = Number(process.env.REFUND_MIN_AGE_MS ?? 300_000);

// ─── Products ──────────────────────────────────────────────────────────────

const DEFAULT_PRODUCTS: ProductTier[] = [
	{
		tierId: "basic",
		label: "Basic",
		amount: "$0.10",
		resourceType: "api",
		accessDurationSeconds: 3600,
	},
];

let products: ProductTier[];
try {
	products = process.env.PRODUCTS
		? (JSON.parse(process.env.PRODUCTS) as ProductTier[])
		: DEFAULT_PRODUCTS;
} catch {
	console.error("FATAL: PRODUCTS env var is not valid JSON");
	process.exit(1);
}

// ─── Storage ───────────────────────────────────────────────────────────────

if (!REDIS_URL) {
	console.error("FATAL: REDIS_URL is required (e.g. redis://localhost:6379)");
	process.exit(1);
}

const Redis = (await import("ioredis")).default;
const redis = new Redis(REDIS_URL);
const store: IChallengeStore = new RedisChallengeStore({
	redis,
	challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
});
const seenTxStore = new RedisSeenTxStore({ redis });
console.log("[agentgate] Using Redis storage:", REDIS_URL);

// ─── Token issuance ────────────────────────────────────────────────────────

const onIssueToken = buildDockerTokenIssuer(ISSUE_TOKEN_API, {
	apiSecret: ISSUE_TOKEN_API_SECRET,
	products,
});

// ─── App ───────────────────────────────────────────────────────────────────

const adapter = new X402Adapter({ network: NETWORK });

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
	res.json({ status: "ok", network: NETWORK, wallet: WALLET_ADDRESS });
});

app.use(
	agentGateRouter({
		config: {
			agentName: AGENT_NAME,
			agentDescription: AGENT_DESCRIPTION,
			agentUrl: AGENT_URL,
			providerName: PROVIDER_NAME,
			providerUrl: PROVIDER_URL,
			walletAddress: WALLET_ADDRESS as `0x${string}`,
			network: NETWORK,
			products,
			challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
			basePath: BASE_PATH,
			onVerifyResource: async () => true,
			onIssueToken,
			...(GAS_WALLET_PRIVATE_KEY ? { gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY } : {}),
		},
		adapter,
		store,
		seenTxStore,
	}),
);

app.listen(PORT, () => {
	console.log("\n[agentgate] Server started");
	console.log(`  Network:    ${NETWORK}`);
	console.log(`  Port:       ${PORT}`);
	console.log(`  Wallet:     ${WALLET_ADDRESS}`);
	console.log(`  Token API:  ${ISSUE_TOKEN_API}`);
	console.log(`  Storage:    Redis`);
	console.log(`  Agent Card: ${AGENT_URL}/.well-known/agent.json`);
	console.log(
		`  Refund cron: ${WALLET_PRIVATE_KEY ? `every ${REFUND_INTERVAL_MS / 1000}s` : "DISABLED (set AGENTGATE_WALLET_PRIVATE_KEY)"}\n`,
	);
});

// ─── Refund cron ───────────────────────────────────────────────────────────

async function runRefundCron(): Promise<void> {
	if (!WALLET_PRIVATE_KEY) return;

	const results = await processRefunds({
		store,
		walletPrivateKey: WALLET_PRIVATE_KEY,
		network: NETWORK,
		minAgeMs: REFUND_MIN_AGE_MS,
	});

	for (const result of results) {
		if (result.success) {
			console.log(`[refund] ✓ ${result.amount} → ${result.toAddress}  tx=${result.refundTxHash}`);
		} else {
			console.error(`[refund] ✗ challengeId=${result.challengeId}  error=${result.error}`);
		}
	}
}

// ─── Start ─────────────────────────────────────────────────────────────────

// BullMQ: only one worker processes the cron across replicas
const { Queue, Worker } = await import("bullmq");
const parsed = new URL(REDIS_URL);
const bullConnection = {
	host: parsed.hostname,
	port: Number(parsed.port) || 6379,
	maxRetriesPerRequest: null,
};

const refundQueue = new Queue("refund-cron", { connection: bullConnection });
const repeatables = await refundQueue.getRepeatableJobs();
for (const job of repeatables) {
	await refundQueue.removeRepeatableByKey(job.key);
}
await refundQueue.add("process-refunds", {}, { repeat: { every: REFUND_INTERVAL_MS } });
await refundQueue.close();

const cronWorker = new Worker("refund-cron", () => runRefundCron(), {
	connection: bullConnection,
});
cronWorker.on("error", (err) => console.error("[refund] Worker error:", err));

const shutdown = async () => {
	await cronWorker.close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
