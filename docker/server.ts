/**
 * Key2a Docker Standalone Server
 *
 * Configured entirely via environment variables.
 * Set KEY2A_WALLET_ADDRESS + ISSUE_TOKEN_API and you're done.
 *
 * See docker/.env.example for the full list of env vars.
 */

import {
	type IAuditStore,
	type IChallengeStore,
	type ISeenTxStore,
	type NetworkName,
	PostgresAuditStore,
	PostgresChallengeStore,
	PostgresSeenTxStore,
	type ProductTier,
	processRefunds,
	RedisAuditStore,
	RedisChallengeStore,
	RedisSeenTxStore,
	X402Adapter,
} from "@riklr/key2a";
import { key2aRouter } from "@riklr/key2a/express";
import express from "express";
import { buildDockerTokenIssuer } from "../src/helpers/docker-token-issuer.js";

// ─── Required env vars ─────────────────────────────────────────────────────

const WALLET_ADDRESS = process.env.KEY2A_WALLET_ADDRESS;
const ISSUE_TOKEN_API = process.env.ISSUE_TOKEN_API;

if (!WALLET_ADDRESS) {
	console.error("FATAL: KEY2A_WALLET_ADDRESS is required (e.g. 0xYourWallet...)");
	process.exit(1);
}

if (!ISSUE_TOKEN_API) {
	console.error("FATAL: ISSUE_TOKEN_API is required (e.g. https://api.example.com/issue-token)");
	process.exit(1);
}

// ─── Optional env vars ─────────────────────────────────────────────────────

const NETWORK = (process.env.KEY2A_NETWORK ?? "testnet") as NetworkName;
const PORT = Number(process.env.PORT ?? 3000);
const AGENT_NAME = process.env.AGENT_NAME ?? "Key2a Server";
const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint";
const AGENT_URL = process.env.AGENT_URL ?? `http://localhost:${PORT}`;
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Key2a";
const PROVIDER_URL = process.env.PROVIDER_URL ?? "https://key2a.dev";
const BASE_PATH = process.env.BASE_PATH ?? "/a2a";
const CHALLENGE_TTL_SECONDS = Number(process.env.CHALLENGE_TTL_SECONDS ?? 900);
const ISSUE_TOKEN_API_SECRET = process.env.ISSUE_TOKEN_API_SECRET;
const REDIS_URL = process.env.REDIS_URL;
const GAS_WALLET_PRIVATE_KEY = process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_PRIVATE_KEY = process.env.KEY2A_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const REFUND_INTERVAL_MS = Number(process.env.REFUND_INTERVAL_MS ?? 60_000);
const REFUND_MIN_AGE_MS = Number(process.env.REFUND_MIN_AGE_MS ?? 300_000);
const REFUND_BATCH_SIZE = Number(process.env.REFUND_BATCH_SIZE ?? 50);
const TOKEN_ISSUE_TIMEOUT_MS = Number(process.env.TOKEN_ISSUE_TIMEOUT_MS ?? 15_000);
const TOKEN_ISSUE_RETRIES = Number(process.env.TOKEN_ISSUE_RETRIES ?? 2);
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND ?? "redis") as "redis" | "postgres";
const DATABASE_URL = process.env.DATABASE_URL;

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

// Redis is required for BullMQ refund cron queue, even when using Postgres storage
if (!REDIS_URL) {
	console.error("FATAL: REDIS_URL is required (e.g. redis://localhost:6379)");
	process.exit(1);
}

let store: IChallengeStore;
let seenTxStore: ISeenTxStore;
let auditStore: IAuditStore;
// biome-ignore lint/suspicious/noExplicitAny: Redis client for BullMQ and gas wallet lock (if needed)
let redis: any = null;

if (STORAGE_BACKEND === "postgres") {
	if (!DATABASE_URL) {
		console.error("FATAL: DATABASE_URL is required when STORAGE_BACKEND=postgres");
		process.exit(1);
	}

	// biome-ignore lint/suspicious/noExplicitAny: postgres is an optional peer dependency
	const postgres = (await import("postgres" as any)).default;
	const sql = postgres(DATABASE_URL);

	store = new PostgresChallengeStore({ sql });
	seenTxStore = new PostgresSeenTxStore({ sql });
	auditStore = new PostgresAuditStore({ sql });

	// Still need Redis for BullMQ refund cron queue
	const Redis = (await import("ioredis")).default;
	redis = new Redis(REDIS_URL);

	console.log("[key2a] Using Postgres storage:", DATABASE_URL);
} else {
	const Redis = (await import("ioredis")).default;
	redis = new Redis(REDIS_URL);
	store = new RedisChallengeStore({
		redis,
		challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
	});
	seenTxStore = new RedisSeenTxStore({ redis });
	auditStore = new RedisAuditStore({ redis });
	console.log("[key2a] Using Redis storage:", REDIS_URL);
}

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
	res.json({ status: "ok", network: NETWORK, wallet: WALLET_ADDRESS, storage: STORAGE_BACKEND });
});

// ─── Test helper endpoints (for e2e tests) ───────────────────────────────────

/**
 * GET /test/challenge/:id
 * Returns the full challenge record from the store (Redis or Postgres).
 */
app.get("/test/challenge/:id", async (req, res) => {
	try {
		const challengeId = req.params.id;
		const record = await store.get(challengeId);
		if (!record) {
			return res.status(404).json({ error: "Not found" });
		}

		// JSON.stringify cannot serialize BigInt, so normalize bigint fields first
		const { amountRaw, ...rest } = record as typeof record & { amountRaw: bigint };
		const serializable = {
			...rest,
			amountRaw: amountRaw != null ? amountRaw.toString() : undefined,
		};

		res.json(serializable);
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

/**
 * POST /test/write-paid-challenge
 * Writes a PAID challenge record via the store for refund tests.
 */
app.post("/test/write-paid-challenge", async (req, res) => {
	const {
		challengeId,
		requestId,
		clientAgentId,
		resourceId,
		tierId,
		amount,
		amountRaw,
		destination,
		fromAddress,
		txHash,
		paidAt,
	} = req.body as {
		challengeId: string;
		requestId: string;
		clientAgentId: string;
		resourceId: string;
		tierId: string;
		amount: string;
		amountRaw: string | number;
		destination: `0x${string}`;
		fromAddress: `0x${string}`;
		txHash: `0x${string}`;
		paidAt: string;
	};

	if (
		!challengeId ||
		!requestId ||
		!clientAgentId ||
		!resourceId ||
		!tierId ||
		!amount ||
		!amountRaw ||
		!destination ||
		!fromAddress ||
		!txHash ||
		!paidAt
	) {
		return res.status(400).json({ error: "Missing required fields" });
	}

	try {
		const nowTs = new Date();
		await store.create({
			challengeId,
			requestId,
			clientAgentId,
			resourceId,
			tierId,
			amount,
			amountRaw: BigInt(amountRaw),
			asset: "USDC",
			chainId: NETWORK === "testnet" ? 84532 : 8453,
			destination,
			state: "PAID",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			createdAt: new Date(Date.now() - 60 * 1000),
			updatedAt: nowTs,
			paidAt: new Date(paidAt),
			txHash,
			fromAddress,
		});
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

/**
 * POST /test/transition-challenge
 * Transition a challenge from one state to another (for test setup).
 * Only available when NODE_ENV=test or E2E_TEST_MODE=true.
 */
app.post("/test/transition-challenge", async (req, res) => {
	const { challengeId, fromState, toState } = req.body as {
		challengeId: string;
		fromState: string;
		toState: string;
	};

	if (!challengeId || !fromState || !toState) {
		return res.status(400).json({ error: "Missing challengeId, fromState, or toState" });
	}

	try {
		const success = await store.transition(challengeId, fromState as any, toState as any);
		if (success) {
			res.json({ success: true, challengeId, fromState, toState });
		} else {
			res.status(409).json({
				error: "State transition failed",
				challengeId,
				fromState,
				toState,
			});
		}
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

/**
 * GET /test/audit/:challengeId
 * Returns the full audit history for a challenge (ordered chronologically).
 */
app.get("/test/audit/:challengeId", async (req, res) => {
	try {
		const history = await auditStore.getHistory(req.params.challengeId);
		res.json({ entries: history });
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

/**
 * POST /test/expire-request-id
 * Simulate TTL expiry by finding the active challenge for a requestId
 * and ensuring the next requestHttpAccess call will create a NEW challenge.
 *
 * For Redis, idempotency is controlled by a requestId→challengeId index key TTL.
 * For Postgres, we rely on challenge state: EXPIRED/CANCELLED/DELIVERED are
 * treated as non-active, so a new challenge will be created.
 * Only available when NODE_ENV=test or E2E_TEST_MODE=true.
 */
app.post("/test/expire-request-id", async (req, res) => {
	const { requestId } = req.body as { requestId: string };

	if (!requestId) {
		return res.status(400).json({ error: "Missing requestId" });
	}

	try {
		const record = await store.findActiveByRequestId(requestId);
		if (!record) {
			return res.status(404).json({ error: "No active challenge found for requestId" });
		}

		// If still PENDING, transition to EXPIRED so engine sees it as inactive
		if (record.state === "PENDING") {
			const success = await store.transition(record.challengeId, "PENDING", "EXPIRED");
			if (!success) {
				return res.status(409).json({
					error: "Failed to transition challenge to EXPIRED",
					requestId,
					challengeId: record.challengeId,
				});
			}
			return res.json({
				success: true,
				requestId,
				challengeId: record.challengeId,
				state: "EXPIRED",
			});
		}

		// For EXPIRED/CANCELLED/DELIVERED: state is already non-PENDING, which is
		// sufficient for the engine to create a new challenge on the next request.
		return res.json({
			success: true,
			requestId,
			challengeId: record.challengeId,
			state: record.state,
		});
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

app.use(
	key2aRouter({
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
			tokenIssueTimeoutMs: TOKEN_ISSUE_TIMEOUT_MS,
			tokenIssueRetries: TOKEN_ISSUE_RETRIES,
			...(GAS_WALLET_PRIVATE_KEY && redis
				? { gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY, redis }
				: {}),
		},
		adapter,
		store,
		seenTxStore,
	}),
);

app.listen(PORT, () => {
	console.log("\n[key2a] Server started");
	console.log(`  Network:    ${NETWORK}`);
	console.log(`  Port:       ${PORT}`);
	console.log(`  Wallet:     ${WALLET_ADDRESS}`);
	console.log(`  Token API:  ${ISSUE_TOKEN_API}`);
	console.log(`  Storage:    ${STORAGE_BACKEND.toUpperCase()}`);
	console.log(`  Agent Card: ${AGENT_URL}/.well-known/agent.json`);
	console.log(
		`  Refund cron: ${WALLET_PRIVATE_KEY ? `every ${REFUND_INTERVAL_MS / 1000}s` : "DISABLED (set KEY2A_WALLET_PRIVATE_KEY)"}\n`,
	);
});

// ─── Refund cron ───────────────────────────────────────────────────────────

async function runRefundCron(): Promise<void> {
	if (!WALLET_PRIVATE_KEY) return;

	const results = await processRefunds({
		store,
		walletPrivateKey: WALLET_PRIVATE_KEY,
		gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY,
		network: NETWORK,
		minAgeMs: REFUND_MIN_AGE_MS,
		batchSize: REFUND_BATCH_SIZE,
		// Share the same Redis client used by settlePayment so the distributed
		// lock serialises refund and settlement transactions from the same gas wallet.
		...(GAS_WALLET_PRIVATE_KEY && redis ? { redis } : {}),
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

// BullMQ: only one worker processes the cron across replicas (requires Redis)
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
