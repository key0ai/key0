/**
 * AgentGate Docker Standalone Server
 *
 * Two modes:
 *   1. Setup mode — if required env vars are missing, serves the setup UI at /setup
 *   2. Running mode — full AgentGate server with /setup still accessible for reconfiguration
 *
 * See docker/.env.example for the full list of env vars.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";

const PORT = Number(process.env.PORT ?? 3000);
const WALLET_ADDRESS = process.env.AGENTGATE_WALLET_ADDRESS;
const ISSUE_TOKEN_API = process.env.ISSUE_TOKEN_API;
const REDIS_URL = process.env.REDIS_URL;
const SETUP_SECRET = process.env.SETUP_SECRET;

const isConfigured = Boolean(WALLET_ADDRESS && ISSUE_TOKEN_API && REDIS_URL);

const app = express();
app.use(express.json());

// ─── Setup UI (served at /setup only) ─────────────────────────────────────

const UI_DIR = resolve(import.meta.dir, "../ui/dist");
const hasUI = existsSync(UI_DIR);

if (hasUI) {
	app.use("/setup", express.static(UI_DIR));

	// SPA fallback — serve index.html for any /setup/* route
	app.get("/setup/*path", (_req, res) => {
		res.sendFile(resolve(UI_DIR, "index.html"));
	});
}

// ─── Setup API ────────────────────────────────────────────────────────────

// In running mode, require SETUP_SECRET to prevent unauthorized reconfiguration.
// In setup mode (not configured), allow unauthenticated access.
function requireSetupAuth(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
): void {
	if (!isConfigured) {
		next();
		return;
	}
	if (!SETUP_SECRET) {
		res.status(403).json({
			error: "Setup API is disabled in running mode. Set SETUP_SECRET env var to enable.",
		});
		return;
	}
	const auth = req.headers.authorization;
	if (auth !== `Bearer ${SETUP_SECRET}`) {
		res.status(401).json({ error: "Invalid setup secret" });
		return;
	}
	next();
}

app.get("/api/setup/status", (req, res) => {
	const authed =
		!isConfigured || (SETUP_SECRET && req.headers.authorization === `Bearer ${SETUP_SECRET}`);

	res.json({
		configured: isConfigured,
		setupProtected: !!(isConfigured && !SETUP_SECRET),
		// Only expose full config to unauthenticated requests in setup mode,
		// or to authenticated requests in running mode.
		config: authed
			? {
					walletAddress: WALLET_ADDRESS ?? "",
					issueTokenApi: ISSUE_TOKEN_API ?? "",
					network: process.env.AGENTGATE_NETWORK ?? "testnet",
					redisUrl: REDIS_URL ?? "",
					port: PORT.toString(),
					basePath: process.env.BASE_PATH ?? "/a2a",
					agentName: process.env.AGENT_NAME ?? "AgentGate Server",
					agentDescription: process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint",
					agentUrl: process.env.AGENT_URL ?? `http://localhost:${PORT}`,
					providerName: process.env.PROVIDER_NAME ?? "",
					providerUrl: process.env.PROVIDER_URL ?? "",
					challengeTtlSeconds: process.env.CHALLENGE_TTL_SECONDS ?? "900",
					issueTokenApiSecret: process.env.ISSUE_TOKEN_API_SECRET ? "••••••" : "",
					gasWalletPrivateKey: process.env.GAS_WALLET_PRIVATE_KEY ? "••••••" : "",
					walletPrivateKey: process.env.AGENTGATE_WALLET_PRIVATE_KEY ? "••••••" : "",
					refundIntervalMs: process.env.REFUND_INTERVAL_MS ?? "60000",
					refundMinAgeMs: process.env.REFUND_MIN_AGE_MS ?? "300000",
				}
			: null,
	});
});

interface SetupBody {
	walletAddress: string;
	issueTokenApi: string;
	network: string;
	redisUrl: string;
	port: string;
	basePath: string;
	agentName: string;
	agentDescription: string;
	agentUrl: string;
	providerName: string;
	providerUrl: string;
	products: Array<{
		tierId: string;
		label: string;
		amount: string;
		resourceType: string;
		accessDurationSeconds?: number;
	}>;
	challengeTtlSeconds: string;
	issueTokenApiSecret: string;
	gasWalletPrivateKey: string;
	walletPrivateKey: string;
	refundIntervalMs: string;
	refundMinAgeMs: string;
}

app.post("/api/setup", requireSetupAuth, async (req, res) => {
	const body = req.body as SetupBody;

	if (!body.walletAddress || !body.issueTokenApi || !body.redisUrl) {
		res.status(400).json({
			error: "walletAddress, issueTokenApi, and redisUrl are required",
		});
		return;
	}

	// Build .env content — values with spaces must be double-quoted for shell sourcing
	const q = (v: string) => (v.includes(" ") ? `"${v.replace(/"/g, '\\"')}"` : v);
	const lines: string[] = [
		`AGENTGATE_WALLET_ADDRESS=${body.walletAddress}`,
		`ISSUE_TOKEN_API=${body.issueTokenApi}`,
		`REDIS_URL=${body.redisUrl}`,
		`AGENTGATE_NETWORK=${body.network || "testnet"}`,
		`PORT=${body.port || PORT}`,
		`AGENT_NAME=${q(body.agentName || "AgentGate Server")}`,
		`AGENT_DESCRIPTION=${q(body.agentDescription || "Payment-gated A2A endpoint")}`,
		`AGENT_URL=${body.agentUrl || `http://localhost:${body.port || PORT}`}`,
	];

	if (body.basePath && body.basePath !== "/a2a") {
		lines.push(`BASE_PATH=${body.basePath}`);
	}
	if (body.providerName) lines.push(`PROVIDER_NAME=${q(body.providerName)}`);
	if (body.providerUrl) lines.push(`PROVIDER_URL=${body.providerUrl}`);
	if (body.products?.length > 0) {
		// Base64-encode JSON to avoid shell quoting issues
		const json = JSON.stringify(body.products);
		const b64 = Buffer.from(json).toString("base64");
		lines.push(`PRODUCTS_B64=${b64}`);
	}
	if (body.challengeTtlSeconds && body.challengeTtlSeconds !== "900") {
		lines.push(`CHALLENGE_TTL_SECONDS=${body.challengeTtlSeconds}`);
	}
	if (body.issueTokenApiSecret) {
		lines.push(`ISSUE_TOKEN_API_SECRET=${body.issueTokenApiSecret}`);
	}
	if (body.gasWalletPrivateKey && !body.gasWalletPrivateKey.includes("•")) {
		lines.push(`GAS_WALLET_PRIVATE_KEY=${body.gasWalletPrivateKey}`);
	}
	if (body.walletPrivateKey && !body.walletPrivateKey.includes("•")) {
		lines.push(`AGENTGATE_WALLET_PRIVATE_KEY=${body.walletPrivateKey}`);
		if (body.refundIntervalMs && body.refundIntervalMs !== "60000") {
			lines.push(`REFUND_INTERVAL_MS=${body.refundIntervalMs}`);
		}
		if (body.refundMinAgeMs && body.refundMinAgeMs !== "300000") {
			lines.push(`REFUND_MIN_AGE_MS=${body.refundMinAgeMs}`);
		}
	}

	const envContent = `${lines.join("\n")}\n`;
	const envPath = resolve("/app/config/.env.runtime");

	try {
		await writeFile(envPath, envContent, "utf-8");
		console.log("[agentgate] Configuration saved to config/.env.runtime — restarting...");
		res.json({ success: true, message: "Configuration saved. Restarting..." });

		// Give the response time to flush, then exit with code 42 to trigger restart
		setTimeout(() => process.exit(42), 500);
	} catch (err) {
		console.error("[agentgate] Failed to write config:", err);
		res.status(500).json({ error: "Failed to save configuration" });
	}
});

// ─── Setup mode: redirect root to /setup ──────────────────────────────────

if (!isConfigured) {
	app.get("/health", (_req, res) => {
		res.json({ status: "setup", message: "AgentGate is not configured yet. Visit /setup" });
	});

	app.get("/", (_req, res) => {
		if (hasUI) {
			res.redirect("/setup");
		} else {
			res.json({
				status: "setup_required",
				message: "AgentGate is not configured. UI not found — set env vars manually.",
			});
		}
	});

	app.listen(PORT, () => {
		console.log("\n[agentgate] Setup mode — no configuration found");
		console.log(`  Open http://localhost:${PORT}/setup to configure\n`);
	});
} else {
	// ─── Running mode: full AgentGate ──────────────────────────────────────

	const agentgate = await import("@riklr/agentgate");
	const { agentGateRouter } = await import("@riklr/agentgate/express");
	const { buildDockerTokenIssuer } = await import("../src/helpers/docker-token-issuer.js");

	type IChallengeStore = agentgate.IChallengeStore;
	type ISeenTxStore = agentgate.ISeenTxStore;
	type NetworkName = agentgate.NetworkName;
	type ProductTier = agentgate.ProductTier;
	const {
		processRefunds,
		PostgresChallengeStore,
		PostgresSeenTxStore,
		RedisChallengeStore,
		RedisSeenTxStore,
		X402Adapter,
	} = agentgate;

	const NETWORK = (process.env.AGENTGATE_NETWORK ?? "testnet") as NetworkName;
	const AGENT_NAME = process.env.AGENT_NAME ?? "AgentGate Server";
	const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint";
	const AGENT_URL = process.env.AGENT_URL ?? `http://localhost:${PORT}`;
	const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "AgentGate";
	const PROVIDER_URL = process.env.PROVIDER_URL ?? "https://agentgate.dev";
	const BASE_PATH = process.env.BASE_PATH ?? "/a2a";
	const CHALLENGE_TTL_SECONDS = Number(process.env.CHALLENGE_TTL_SECONDS ?? 900);
	const ISSUE_TOKEN_API_SECRET = process.env.ISSUE_TOKEN_API_SECRET;
	const GAS_WALLET_PRIVATE_KEY = process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
	const WALLET_PRIVATE_KEY = process.env.AGENTGATE_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
	const REFUND_INTERVAL_MS = Number(process.env.REFUND_INTERVAL_MS ?? 60_000);
	const REFUND_MIN_AGE_MS = Number(process.env.REFUND_MIN_AGE_MS ?? 300_000);
	const REFUND_BATCH_SIZE = Number(process.env.REFUND_BATCH_SIZE ?? 50);
	const TOKEN_ISSUE_TIMEOUT_MS = Number(process.env.TOKEN_ISSUE_TIMEOUT_MS ?? 15_000);
	const TOKEN_ISSUE_RETRIES = Number(process.env.TOKEN_ISSUE_RETRIES ?? 2);
	const STORAGE_BACKEND = (process.env.STORAGE_BACKEND ?? "redis") as "redis" | "postgres";
	const DATABASE_URL = process.env.DATABASE_URL;

	// Products — support both PRODUCTS (raw JSON) and PRODUCTS_B64 (base64-encoded JSON)
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
		if (process.env.PRODUCTS_B64) {
			products = JSON.parse(Buffer.from(process.env.PRODUCTS_B64, "base64").toString("utf-8"));
		} else if (process.env.PRODUCTS) {
			products = JSON.parse(process.env.PRODUCTS) as ProductTier[];
		} else {
			products = DEFAULT_PRODUCTS;
		}
	} catch {
		console.error("FATAL: PRODUCTS / PRODUCTS_B64 env var is not valid JSON");
		process.exit(1);
	}

	// ─── Storage ───────────────────────────────────────────────────────────

	// Redis is required for BullMQ refund cron queue, even when using Postgres storage
	let store: IChallengeStore;
	let seenTxStore: ISeenTxStore;
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

		// Still need Redis for BullMQ refund cron queue
		const Redis = (await import("ioredis")).default;
		redis = new Redis(REDIS_URL!);

		console.log("[agentgate] Using Postgres storage:", DATABASE_URL);
	} else {
		const Redis = (await import("ioredis")).default;
		redis = new Redis(REDIS_URL!);
		store = new RedisChallengeStore({
			redis,
			challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
		});
		seenTxStore = new RedisSeenTxStore({ redis });
		console.log("[agentgate] Using Redis storage:", REDIS_URL);
	}

	// Token issuance
	const onIssueToken = buildDockerTokenIssuer(ISSUE_TOKEN_API!, {
		apiSecret: ISSUE_TOKEN_API_SECRET,
		products,
	});

	// Adapter & routes
	const adapter = new X402Adapter({ network: NETWORK });

	app.get("/health", (_req, res) => {
		res.json({ status: "ok", network: NETWORK, wallet: WALLET_ADDRESS, storage: STORAGE_BACKEND });
	});

	// ─── Test helper endpoints (for e2e tests) ───────────────────────────────

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
			// biome-ignore lint/suspicious/noExplicitAny: test endpoint accepts any state string
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
	 * POST /test/expire-request-id
	 * Simulate TTL expiry by finding the active challenge for a requestId
	 * and ensuring the next requestHttpAccess call will create a NEW challenge.
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
		console.log("\n[agentgate] Server started");
		console.log(`  Network:    ${NETWORK}`);
		console.log(`  Port:       ${PORT}`);
		console.log(`  Wallet:     ${WALLET_ADDRESS}`);
		console.log(`  Token API:  ${ISSUE_TOKEN_API}`);
		console.log(`  Storage:    ${STORAGE_BACKEND.toUpperCase()}`);
		console.log(`  Setup UI:   http://localhost:${PORT}/setup`);
		console.log(`  Agent Card: ${AGENT_URL}/.well-known/agent.json`);
		console.log(
			`  Refund cron: ${WALLET_PRIVATE_KEY ? `every ${REFUND_INTERVAL_MS / 1000}s` : "DISABLED (set AGENTGATE_WALLET_PRIVATE_KEY)"}\n`,
		);
	});

	// Refund cron
	async function runRefundCron(): Promise<void> {
		if (!WALLET_PRIVATE_KEY) return;

		const results = await processRefunds({
			store,
			walletPrivateKey: WALLET_PRIVATE_KEY,
			gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY,
			network: NETWORK,
			minAgeMs: REFUND_MIN_AGE_MS,
			batchSize: REFUND_BATCH_SIZE,
		});

		for (const result of results) {
			if (result.success) {
				console.log(`[refund] ✓ ${result.amount} → ${result.toAddress}  tx=${result.refundTxHash}`);
			} else {
				console.error(`[refund] ✗ challengeId=${result.challengeId}  error=${result.error}`);
			}
		}
	}

	// BullMQ: only one worker processes the cron across replicas (requires Redis)
	const { Queue, Worker } = await import("bullmq");
	const parsed = new URL(REDIS_URL!);
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
}
