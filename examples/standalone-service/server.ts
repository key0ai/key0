/**
 * Key0 Standalone Service Example
 *
 * This example demonstrates how to deploy Key0 as a separate service
 * that communicates with your backend via HTTP.
 *
 * Architecture:
 *   Agent -> Key0 Service -> Backend (verify resource, issue token)
 *   Agent -> Backend (use token for protected resources)
 *
 * Prerequisites:
 *   - Set environment variables (see .env.example)
 *   - Backend service running and accessible
 *
 * Usage:
 *   bun run start
 */

import {
	AccessTokenIssuer,
	type AuthHeaderProvider,
	createRemoteTokenIssuer,
	type IChallengeStore,
	type ISeenTxStore,
	type IssueTokenParams,
	type NetworkName,
	noAuth,
	PostgresChallengeStore,
	PostgresSeenTxStore,
	processRefunds,
	RedisChallengeStore,
	RedisSeenTxStore,
	sharedSecretAuth,
	signedJwtAuth,
	type TokenIssuanceResult,
	X402Adapter,
} from "@riklr/key0";
import { key0Router } from "@riklr/key0/express";
import { Queue, Worker } from "bullmq";
import express from "express";
import Redis from "ioredis";

const PORT = Number(process.env.KEY0_PORT ?? 3001);
const NETWORK = (process.env.KEY0_NETWORK ?? "testnet") as NetworkName;
const SECRET = process.env.KEY0_ACCESS_TOKEN_SECRET!;
const BACKEND_API_URL = process.env.BACKEND_API_URL!;
const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET!;
const BACKEND_AUTH_STRATEGY = process.env.BACKEND_AUTH_STRATEGY || "none"; // "none" | "shared-secret" | "jwt"
const STORAGE_BACKEND = process.env.STORAGE_BACKEND || "redis"; // "redis" | "postgres"

// Gas wallet configuration for facilitation
const GAS_WALLET_PRIVATE_KEY = process.env.GAS_WALLET_PRIVATE_KEY;
const USE_GAS_WALLET = process.env.USE_GAS_WALLET === "true";

// Refund cron configuration
const REFUND_INTERVAL_MS = Number(process.env["REFUND_INTERVAL_MS"] ?? 15_000);
const REFUND_MIN_AGE_MS = Number(process.env["REFUND_MIN_AGE_MS"] ?? 30_000);
const WALLET_PRIVATE_KEY = process.env["KEY0_WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;

if (USE_GAS_WALLET) {
	console.log("🔐 Gas Wallet Mode: ENABLED");
	console.log("   Gas wallet will handle payment settlement directly");
}

// Validate required environment variables
if (!SECRET || SECRET.length < 32) {
	console.error("ERROR: KEY0_ACCESS_TOKEN_SECRET must be at least 32 characters");
	process.exit(1);
}

if (!BACKEND_API_URL) {
	console.error("ERROR: BACKEND_API_URL is required");
	process.exit(1);
}

if (STORAGE_BACKEND === "redis" && !process.env.REDIS_URL) {
	console.error("ERROR: REDIS_URL is required when using Redis storage backend");
	process.exit(1);
}

if (STORAGE_BACKEND === "postgres" && !process.env.DATABASE_URL) {
	console.error("ERROR: DATABASE_URL is required when using Postgres storage backend");
	process.exit(1);
}

if (BACKEND_AUTH_STRATEGY === "shared-secret" && !INTERNAL_AUTH_SECRET) {
	console.error("ERROR: INTERNAL_AUTH_SECRET is required for shared-secret auth");
	process.exit(1);
}
if (BACKEND_AUTH_STRATEGY === "jwt" && !SECRET) {
	console.error("ERROR: KEY0_ACCESS_TOKEN_SECRET is required for jwt auth");
	process.exit(1);
}

const app = express();
app.use(express.json());

// Initialize storage backend based on configuration
let store: IChallengeStore;
let seenTxStore: ISeenTxStore;

if (STORAGE_BACKEND === "postgres") {
	console.log("📦 Using Postgres storage backend");
	// biome-ignore lint/suspicious/noExplicitAny: postgres is an optional peer dependency
	const postgres = (await import("postgres" as any)).default;
	const sql = postgres(process.env.DATABASE_URL!);
	store = new PostgresChallengeStore({ sql });
	seenTxStore = new PostgresSeenTxStore({ sql });
} else {
	console.log("📦 Using Redis storage backend");
	const redis = new Redis(process.env.REDIS_URL!);
	store = new RedisChallengeStore({ redis, challengeTTLSeconds: 900 });
	seenTxStore = new RedisSeenTxStore({ redis });
}

// Create the x402 payment adapter
const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env.KEY0_RPC_URL,
});

// Configure auth strategy for backend communication
let authProvider: AuthHeaderProvider;

// We need an issuer instance if using JWT auth strategy
// This is used for service-to-service auth, not for access tokens issued to agents
const serviceTokenIssuer = new AccessTokenIssuer(SECRET);

if (BACKEND_AUTH_STRATEGY === "jwt") {
	// Strategy 2: Signed JWT
	// Requires SECRET to be a private key (PEM) if algorithm is RS256, or shared secret for HS256
	// The backend must have the corresponding public key or shared secret
	console.log("Using Signed JWT auth strategy for backend communication");
	authProvider = signedJwtAuth(serviceTokenIssuer, "backend-service");
} else if (BACKEND_AUTH_STRATEGY === "shared-secret") {
	// Strategy 1: Shared Secret
	console.log("Using Shared Secret auth strategy for backend communication");
	authProvider = sharedSecretAuth("X-Internal-Auth", INTERNAL_AUTH_SECRET);
} else {
	// No auth
	console.log("Using No Auth strategy for backend communication");
	authProvider = noAuth();
}

// Determine token issuance mode
const tokenMode = (process.env.TOKEN_MODE || "native") as "native" | "remote";

// Create token issuer callback based on mode
let fetchResourceCredentials: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;

if (tokenMode === "remote") {
	// Remote mode: Call backend to issue tokens
	console.log("Using Remote token issuance mode");
	const remoteTokenIssuer = createRemoteTokenIssuer({
		url: `${BACKEND_API_URL}/internal/issue-token`,
		auth: authProvider,
		timeoutMs: 10000,
	});
	fetchResourceCredentials = remoteTokenIssuer;
} else {
	// Native mode: Generate JWT locally using AccessTokenIssuer utility
	console.log("Using Native token issuance mode (local JWT)");
	const localTokenIssuer = new AccessTokenIssuer(SECRET);
	fetchResourceCredentials = async (params) => {
		const ttl = 3600;

		return localTokenIssuer.sign(
			{
				sub: params.requestId,
				jti: params.challengeId,
				resourceId: params.resourceId,
				planId: params.planId,
				txHash: params.txHash,
			},
			ttl,
		);
	};
}

// Product catalog
const plans = [
	{
		planId: "basic",
		unitAmount: "$0.015",
		description:
			"Pay-as-you-go. Best for low-volume or unpredictable workloads. 2 concurrent agents, 10 requests/minute, email support.",
	},
	{
		planId: "starter-monthly",
		unitAmount: "$15.00",
		description:
			"Starter (monthly). Best for developers running daily workflows. 1,650 requests/month, 10 concurrent agents, 100 requests/minute, priority email support. Past 1,650 requests: $0.014/req.",
	},
	{
		planId: "starter-yearly",
		unitAmount: "$168.00",
		description:
			"Starter (yearly — save 7%). Best for developers running daily workflows. 1,650 requests/month, 10 concurrent agents, 100 requests/minute, priority email support. Past 1,650 requests: $0.014/req.",
	},
	{
		planId: "pro-monthly",
		unitAmount: "$150.00",
		description:
			"Pro (monthly). Best for teams with high-volume workloads. 16,500 requests/month, 50 concurrent agents, 1,000 requests/minute, priority email + Slack. Past 16,500 requests: $0.012/req.",
	},
] as const;

// Mount Key0 — serves agent card + A2A endpoint
app.use(
	key0Router({
		config: {
			agentName: process.env.AGENT_NAME || "Key0 Service",
			agentDescription: process.env.AGENT_DESCRIPTION || "Payment-gated API access for AI agents",
			agentUrl: process.env.KEY0_PUBLIC_URL || `http://localhost:${PORT}`,
			providerName: process.env.PROVIDER_NAME || "Example Corp",
			providerUrl: process.env.PROVIDER_URL || "https://example.com",
			walletAddress: (process.env.KEY0_WALLET_ADDRESS ||
				"0x0000000000000000000000000000000000000000") as `0x${string}`,
			network: NETWORK,
			challengeTTLSeconds: Number(process.env.CHALLENGE_TTL_SECONDS ?? 900),
			plans,
			fetchResourceCredentials,
			onPaymentReceived: async (grant) => {
				// Notify backend when payment is received
				try {
					const headers = await authProvider();
					await fetch(`${BACKEND_API_URL}/internal/payment-received`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...headers,
						},
						body: JSON.stringify(grant),
					});
				} catch (err) {
					console.error("[Key0] Failed to notify backend:", err);
					// Don't fail the flow if notification fails
				}
			},
			resourceEndpointTemplate: `${BACKEND_API_URL}/api/{resourceId}`,
			mcp: true,
			// Gas wallet mode: provide private key to enable self-contained settlement
			...(USE_GAS_WALLET ? { gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY as `0x${string}` } : {}),
		},
		adapter,
		store,
		seenTxStore,
	}),
);

// Health check
app.get("/health", (_req, res) => {
	res.json({
		status: "ok",
		service: "key0",
		storage: STORAGE_BACKEND,
		tokenMode,
		network: NETWORK,
	});
});

// Token info endpoint (for backend to discover token format)
app.get("/.well-known/token-info", (_req, res) => {
	res.json({
		tokenType: "JWT",
		algorithm: tokenMode === "remote" ? "custom" : "HS256", // Could be RS256 if configured
		// If using RS256, include public key here:
		// publicKey: process.env.KEY0_PUBLIC_KEY,
	});
});

app.listen(PORT, () => {
	console.log("\n🚀 Key0 Standalone Service");
	console.log(`   Port: ${PORT}`);
	console.log(`   Network: ${NETWORK}`);
	console.log(`   Storage: ${STORAGE_BACKEND.toUpperCase()}`);
	console.log(`   Token Mode: ${tokenMode}`);
	console.log(`   Facilitation Mode: ${USE_GAS_WALLET ? "Gas Wallet" : "Standard"}`);
	console.log(`   Backend URL: ${BACKEND_API_URL}`);
	console.log(
		`   Agent Card: ${process.env.KEY0_PUBLIC_URL || `http://localhost:${PORT}`}/.well-known/agent.json`,
	);
	console.log(
		`   A2A Endpoint: ${process.env.KEY0_PUBLIC_URL || `http://localhost:${PORT}`}/agent\n`,
	);

	console.log("\nRefund cron:");
	console.log(`  Interval     : ${REFUND_INTERVAL_MS / 1000}s`);
	console.log(`  Grace period : ${REFUND_MIN_AGE_MS / 1000}s`);
	console.log(
		`  Status       : ${WALLET_PRIVATE_KEY ? "ACTIVE" : "DISABLED (set KEY0_WALLET_PRIVATE_KEY)"}\n`,
	);
});

// ─── Refund cron ──────────────────────────────────────────────────────────────

async function runRefundCron(): Promise<void> {
	if (!WALLET_PRIVATE_KEY) {
		console.log("[Cron] Skipped — KEY0_WALLET_PRIVATE_KEY not set.");
		return;
	}

	const results = await processRefunds({
		store,
		walletPrivateKey: WALLET_PRIVATE_KEY,
		...(USE_GAS_WALLET && GAS_WALLET_PRIVATE_KEY
			? { gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY as `0x${string}` }
			: {}),
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
	// BullMQ requires Redis for job queue, regardless of storage backend
	const redisUrl = process.env.REDIS_URL || process.env.BULLMQ_REDIS_URL;
	if (!redisUrl) {
		console.warn(
			"[Cron] WARNING: No Redis connection available for BullMQ. Set REDIS_URL or BULLMQ_REDIS_URL to enable background job processing.",
		);
		return;
	}

	const parsed = new URL(redisUrl);
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
	cronWorker.on("error", (err) => console.error("[Cron] Worker error:", err));

	const shutdown = async () => {
		await cronWorker.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

start().catch((err) => {
	console.error("Failed to start cron:", err);
	process.exit(1);
});
