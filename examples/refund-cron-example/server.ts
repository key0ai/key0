import { AccessTokenIssuer, RedisChallengeStore, X402Adapter, processRefunds } from "@agentgate/sdk";
import type { NetworkName } from "@agentgate/sdk";
import { agentGateRouter, validateAccessToken } from "@agentgate/sdk/express";
import express from "express";
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";

const PORT = Number(process.env["PORT"] ?? 3000);
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? `http://localhost:${PORT}`;
const NETWORK = (process.env["AGENTGATE_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = (process.env["AGENTGATE_WALLET_ADDRESS"] ??
	"0x0000000000000000000000000000000000000000") as `0x${string}`;
const SECRET =
	process.env["AGENTGATE_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";
const SELLER_PRIVATE_KEY = process.env["AGENTGATE_SELLER_PRIVATE_KEY"] as
	| `0x${string}`
	| undefined;
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const REFUND_INTERVAL_MS = Number(process.env["REFUND_INTERVAL_MS"] ?? 15_000);
const REFUND_MIN_AGE_MS = Number(process.env["REFUND_MIN_AGE_MS"] ?? 30_000);

const app = express();
app.use(express.json());

const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env["AGENTGATE_RPC_URL"],
});

const tokenIssuer = new AccessTokenIssuer(SECRET);

// ─── Redis + Store ────────────────────────────────────────────────────────────

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const store = new RedisChallengeStore({ redis, challengeTTLSeconds: 900 });

// BullMQ bundles its own ioredis, so pass plain options to avoid type conflicts
const makeBullConnection = () => {
	const parsed = new URL(REDIS_URL);
	return {
		host: parsed.hostname,
		port: Number(parsed.port) || 6379,
		maxRetriesPerRequest: null,
	};
};

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(
	agentGateRouter({
		store,
		config: {
			agentName: "Refund Cron Demo",
			agentDescription: "Seller with automatic refund cron for undelivered payments",
			agentUrl: PUBLIC_URL,
			providerName: "Example Corp",
			providerUrl: "https://example.com",
			walletAddress: WALLET,
			network: NETWORK,
			challengeTTLSeconds: 900,
			products: [
				{
					tierId: "single",
					label: "Single access",
					amount: "$0.10",
					resourceType: "data",
					accessDurationSeconds: 3600,
				},
			],
			onVerifyResource: async (resourceId: string) => {
				return ["item-1", "item-2", "item-3"].includes(resourceId);
			},
			onIssueToken: async (params) => {
				console.log('New token issued', params);
				throw new Error('No Token Issued'); // NOTE: This is for testing the refund cron

				// NOTE: This is the original code that issues a token
				// return tokenIssuer.sign(
				// 	{
				// 		sub: params.requestId,
				// 		jti: params.challengeId,
				// 		resourceId: params.resourceId,
				// 		tierId: params.tierId,
				// 		txHash: params.txHash,
				// 	},
				// 	3600,
				// );
			},
			onPaymentReceived: async (grant) => {
				console.log(`[Payment] Received payment for ${grant.resourceId}`);
				console.log(`  TX: ${grant.explorerUrl}`);
			},
			resourceEndpointTemplate: `${PUBLIC_URL}/api/items/{resourceId}`,
		},
		adapter,
	}),
);

app.use("/api", validateAccessToken({ secret: SECRET }));

app.get("/api/items/:id", (req, res) => {
	res.json({
		id: req.params["id"],
		content: "Secret content — you paid for this!",
		servedAt: new Date().toISOString(),
	});
});

// ─── Refund cron ──────────────────────────────────────────────────────────────

async function runRefundCron(): Promise<void> {
	if (!SELLER_PRIVATE_KEY) {
		console.log("[Cron] Skipped — AGENTGATE_SELLER_PRIVATE_KEY not set.");
		return;
	}

	const results = await processRefunds({
		store,
		sellerPrivateKey: SELLER_PRIVATE_KEY,
		network: NETWORK,
		minAgeMs: REFUND_MIN_AGE_MS,
	});

	if (results.length === 0) {
		console.log("[Cron] No eligible records.");
		return;
	}

	for (const result of results) {
		if (result.success) {
			console.log(
				`[Cron] ✓ REFUNDED  ${result.amount} → ${result.toAddress}  tx=${result.refundTxHash}`,
			);
		} else {
			console.error(
				`[Cron] ✗ REFUND_FAILED  challengeId=${result.challengeId}  error=${result.error}`,
			);
		}
	}
	console.log("--------------------------------");
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
	// Register repeatable job, then close the queue — the Worker drives scheduling from Redis
	const refundQueue = new Queue("refund-cron", { connection: makeBullConnection() });
	const repeatables = await refundQueue.getRepeatableJobs();
	for (const job of repeatables) {
		await refundQueue.removeRepeatableByKey(job.key);
	}
	await refundQueue.add("process-refunds", {}, { repeat: { every: REFUND_INTERVAL_MS } });
	await refundQueue.close();

	const cronWorker = new Worker("refund-cron", () => runRefundCron(), { connection: makeBullConnection() });
	cronWorker.on("error", (err) => console.error("[Cron] Worker error:", err));

	// Graceful shutdown
	const shutdown = async () => {
		await cronWorker.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	app.listen(PORT, () => {
		console.log(`\nRefund Cron Demo — ${PUBLIC_URL}`);
		console.log(`  Network : ${NETWORK}`);
		console.log(`  Wallet  : ${WALLET}`);
		console.log(`  Redis   : ${REDIS_URL}`);
		console.log(`\nRefund cron:`);
		console.log(`  Interval     : ${REFUND_INTERVAL_MS / 1000}s`);
		console.log(`  Grace period : ${REFUND_MIN_AGE_MS / 1000}s`);
		console.log(`  Status       : ${SELLER_PRIVATE_KEY ? "ACTIVE" : "DISABLED (set AGENTGATE_SELLER_PRIVATE_KEY)"}\n`);
	});
}

start().catch((err) => {
	console.error("Failed to start:", err);
	process.exit(1);
});
