/**
 * Key0 Docker Standalone Server
 *
 * Two modes:
 *   1. Setup mode — if required env vars are missing, serves the setup UI at /setup
 *   2. Running mode — full Key0 server with /setup still accessible for reconfiguration
 *
 * See docker/.env.example for the full list of env vars.
 */

import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";

const PORT = Number(process.env.PORT ?? 3000);
const WALLET_ADDRESS = process.env.KEY0_WALLET_ADDRESS;
const ISSUE_TOKEN_API = process.env.ISSUE_TOKEN_API;
const REDIS_URL = process.env.REDIS_URL;

// Optional explicit hint from the user (e.g. KEY0_MANAGED_INFRA=redis,postgres).
// No longer required — managed infra is auto-detected via DNS at startup.
const MANAGED_INFRA_EXPLICIT = (process.env.KEY0_MANAGED_INFRA ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

// ─── Auto-detect infrastructure availability via DNS ─────────────────────
//
// Instead of relying on a user-supplied env var to know whether compose-internal
// services (redis, postgres) are running, we do a quick DNS lookup at startup.
//   - hostname resolves  → service is reachable → URL is usable
//   - hostname fails     → service not running  → enter setup mode
//
// This works transparently for all deployment scenarios:
//   docker compose --profile full up   → redis/postgres resolve inside compose network
//   docker compose up (no profile)     → hostnames don't resolve → setup mode
//   docker run -e REDIS_URL=redis://external:6379  → external hostname resolves

async function isHostReachable(url: string | undefined, timeoutMs = 3000): Promise<boolean> {
	if (!url) return false;
	try {
		const hostname = new URL(url).hostname;
		await Promise.race([
			lookup(hostname),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
		]);
		return true;
	} catch {
		return false;
	}
}

const redisUsable = await isHostReachable(REDIS_URL);
const postgresUrlUsable = await isHostReachable(process.env.DATABASE_URL);
const STORAGE_BACKEND_EARLY = (process.env.STORAGE_BACKEND ?? "redis") as "redis" | "postgres";

// Proxy-only mode: ISSUE_TOKEN_API not required when PROXY_TO_BASE_URL is set
const isProxyOnlyMode = Boolean(process.env.PROXY_TO_BASE_URL);
const isConfigured = Boolean(
	WALLET_ADDRESS &&
		(ISSUE_TOKEN_API || isProxyOnlyMode) &&
		(STORAGE_BACKEND_EARLY === "postgres" ? postgresUrlUsable && redisUsable : redisUsable),
);

const app = express();
app.use(express.json());

// ─── Setup UI (served at /setup only) ─────────────────────────────────────
//
// WARNING: /setup and /api/setup are unauthenticated by design — intended for
// Docker-internal use where the port is not exposed publicly.
// For production deployments, restrict access via network policy or a reverse
// proxy (e.g. allow only localhost / VPN). See docs/setup-ui.md for details.

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

app.get("/api/setup/status", (_req, res) => {
	let plans: Array<{ planId: string; unitAmount: string; description?: string }> | undefined;
	try {
		if (process.env.PLANS_B64) {
			plans = JSON.parse(Buffer.from(process.env.PLANS_B64, "base64").toString("utf-8"));
		} else if (process.env.PLANS) {
			plans = JSON.parse(process.env.PLANS);
		}
	} catch {
		// ignore — UI will fall back to its default
	}

	// Auto-detect which infra is managed by Docker Compose:
	// A service is "managed" if its URL points to a compose-internal hostname
	// (e.g. redis, postgres) AND that hostname actually resolved at startup.
	const autoManaged: string[] = [];
	if (redisUsable && REDIS_URL && /^redis:\/\/redis[^.]*:/.test(REDIS_URL)) {
		autoManaged.push("redis");
	}
	if (
		postgresUrlUsable &&
		process.env.DATABASE_URL &&
		/postgresql?:\/\/[^@]+@postgres[^.]*:/.test(process.env.DATABASE_URL)
	) {
		autoManaged.push("postgres");
	}
	// Merge explicit KEY0_MANAGED_INFRA (if set) with auto-detected
	const managedInfra = [...new Set([...MANAGED_INFRA_EXPLICIT, ...autoManaged])];

	res.json({
		configured: isConfigured,
		managedInfra,
		config: {
			walletAddress: WALLET_ADDRESS ?? "",
			issueTokenApi: ISSUE_TOKEN_API ?? "",
			network: process.env.KEY0_NETWORK ?? "testnet",
			storageBackend: process.env.STORAGE_BACKEND ?? "redis",
			redisUrl: REDIS_URL ?? "",
			databaseUrl: process.env.DATABASE_URL ?? "",
			port: PORT.toString(),
			basePath: process.env.BASE_PATH ?? "/a2a",
			agentName: process.env.AGENT_NAME ?? "Key0 Server",
			agentDescription: process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint",
			agentUrl: process.env.AGENT_URL ?? `http://localhost:${PORT}`,
			providerName: process.env.PROVIDER_NAME ?? "",
			providerUrl: process.env.PROVIDER_URL ?? "",
			plans: plans ?? [],
			routes: (() => {
				try {
					if (process.env.ROUTES_B64)
						return JSON.parse(Buffer.from(process.env.ROUTES_B64, "base64").toString("utf-8"));
					if (process.env.ROUTES) return JSON.parse(process.env.ROUTES);
				} catch {}
				return [];
			})(),
			proxyToBaseUrl: process.env.PROXY_TO_BASE_URL ?? "",
			proxySecret: process.env.KEY0_PROXY_SECRET ? "••••••" : "",
			challengeTtlSeconds: process.env.CHALLENGE_TTL_SECONDS ?? "900",
			backendAuthStrategy: process.env.BACKEND_AUTH_STRATEGY ?? "none",
			issueTokenApiSecret: process.env.ISSUE_TOKEN_API_SECRET ? "••••••" : "",
			gasWalletPrivateKey: process.env.GAS_WALLET_PRIVATE_KEY ? "••••••" : "",
			walletPrivateKey: process.env.KEY0_WALLET_PRIVATE_KEY ? "••••••" : "",
			mcpEnabled: process.env.MCP_ENABLED === "true",
			refundIntervalMs: process.env.REFUND_INTERVAL_MS ?? "60000",
			refundMinAgeMs: process.env.REFUND_MIN_AGE_MS ?? "300000",
		},
	});
});

interface SetupBody {
	walletAddress: string;
	issueTokenApi: string;
	network: string;
	storageBackend: "redis" | "postgres";
	redisUrl: string;
	databaseUrl: string;
	port: string;
	basePath: string;
	agentName?: string;
	agentDescription?: string;
	agentUrl: string;
	providerName: string;
	providerUrl: string;
	plans: Array<{
		planId: string;
		unitAmount: string;
		description?: string;
	}>;
	routes?: Array<{
		routeId: string;
		method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
		path: string;
		unitAmount?: string;
		description?: string;
	}>;
	proxyToBaseUrl?: string;
	proxySecret?: string;
	challengeTtlSeconds: string;
	mcpEnabled: boolean;
	backendAuthStrategy: "none" | "shared-secret" | "jwt";
	issueTokenApiSecret: string;
	gasWalletPrivateKey: string;
	walletPrivateKey: string;
	refundIntervalMs: string;
	refundMinAgeMs: string;
}

// Unauthenticated — see warning above.
app.post("/api/setup", async (req, res) => {
	const body = req.body as SetupBody;
	const { plans, routes, proxyToBaseUrl, proxySecret, issueTokenApi, walletAddress } = body;

	if (!walletAddress) {
		res.status(400).json({ error: "walletAddress is required" });
		return;
	}
	if (!plans?.length && !routes?.length) {
		res.status(400).json({ error: "At least one plan or route must be configured" });
		return;
	}
	if (plans?.length && !issueTokenApi) {
		res.status(400).json({ error: "issueTokenApi is required when plans are configured" });
		return;
	}
	if (routes?.length && !proxyToBaseUrl) {
		res.status(400).json({ error: "proxyToBaseUrl is required when routes are configured" });
		return;
	}

	// Build .env content — values with spaces must be double-quoted for shell sourcing
	const q = (v: string) => (v.includes(" ") ? `"${v.replace(/"/g, '\\"')}"` : v);
	const lines: string[] = [
		`KEY0_WALLET_ADDRESS=${walletAddress}`,
		`KEY0_NETWORK=${body.network || "testnet"}`,
		`PORT=${body.port || PORT}`,
		`AGENT_NAME=${q(body.agentName || (body.providerName ? `${body.providerName} Agent` : "Key0 Server"))}`,
		`AGENT_DESCRIPTION=${q(body.agentDescription || (body.providerName ? `Payment-gated API by ${body.providerName}` : "Payment-gated A2A endpoint"))}`,
		`AGENT_URL=${body.agentUrl || `http://localhost:${body.port || PORT}`}`,
	];

	if (body.storageBackend === "postgres") {
		lines.push(`STORAGE_BACKEND=postgres`);
		if (body.databaseUrl) lines.push(`DATABASE_URL=${body.databaseUrl}`);
	}
	if (body.redisUrl) lines.push(`REDIS_URL=${body.redisUrl}`);

	if (body.basePath && body.basePath !== "/a2a") {
		lines.push(`BASE_PATH=${body.basePath}`);
	}
	if (body.providerName) lines.push(`PROVIDER_NAME=${q(body.providerName)}`);
	if (body.providerUrl) lines.push(`PROVIDER_URL=${body.providerUrl}`);
	if (plans?.length) {
		// Base64-encode JSON to avoid shell quoting issues
		const json = JSON.stringify(plans);
		const b64 = Buffer.from(json).toString("base64");
		lines.push(`PLANS_B64=${b64}`);
	}
	// Routes — normalize unitAmount: empty string → omit from serialized JSON
	if (routes?.length) {
		type RouteWithOptionalAmount = { unitAmount?: string; [key: string]: unknown };
		const normalizedRoutes = routes.map((r: RouteWithOptionalAmount) =>
			r.unitAmount === "" ? { ...r, unitAmount: undefined } : r,
		);
		lines.push(`ROUTES_B64=${Buffer.from(JSON.stringify(normalizedRoutes)).toString("base64")}`);
		if (proxyToBaseUrl) lines.push(`PROXY_TO_BASE_URL=${proxyToBaseUrl}`);
		if (proxySecret && !proxySecret.includes("•")) lines.push(`KEY0_PROXY_SECRET=${proxySecret}`);
	}
	// Only write ISSUE_TOKEN_API when plans are configured
	if (plans?.length && issueTokenApi) {
		lines.push(`ISSUE_TOKEN_API=${issueTokenApi}`);
	}
	if (body.challengeTtlSeconds && body.challengeTtlSeconds !== "900") {
		lines.push(`CHALLENGE_TTL_SECONDS=${body.challengeTtlSeconds}`);
	}
	if (body.mcpEnabled) {
		lines.push(`MCP_ENABLED=true`);
	}
	if (body.backendAuthStrategy && body.backendAuthStrategy !== "none") {
		lines.push(`BACKEND_AUTH_STRATEGY=${body.backendAuthStrategy}`);
	}
	if (body.backendAuthStrategy !== "none" && body.issueTokenApiSecret) {
		lines.push(`ISSUE_TOKEN_API_SECRET=${body.issueTokenApiSecret}`);
	}
	if (body.gasWalletPrivateKey && !body.gasWalletPrivateKey.includes("•")) {
		lines.push(`GAS_WALLET_PRIVATE_KEY=${body.gasWalletPrivateKey}`);
	}
	if (body.walletPrivateKey && !body.walletPrivateKey.includes("•")) {
		lines.push(`KEY0_WALLET_PRIVATE_KEY=${body.walletPrivateKey}`);
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
		console.log("[key0] Configuration saved to config/.env.runtime — restarting...");
		res.json({ success: true, message: "Configuration saved. Restarting..." });

		// Give the response time to flush, then exit with code 42 to trigger restart
		setTimeout(() => process.exit(42), 500);
	} catch (err) {
		console.error("[key0] Failed to write config:", err);
		res.status(500).json({ error: "Failed to save configuration" });
	}
});

// ─── Setup mode: redirect root to /setup ──────────────────────────────────

if (!isConfigured) {
	app.get("/health", (_req, res) => {
		res.json({ status: "setup", message: "Key0 is not configured yet. Visit /setup" });
	});

	app.get("/", (_req, res) => {
		if (hasUI) {
			res.redirect("/setup");
		} else {
			res.json({
				status: "setup_required",
				message: "Key0 is not configured. UI not found — set env vars manually.",
			});
		}
	});

	app.listen(PORT, () => {
		console.log("\n[key0] Setup mode — no configuration found");
		console.log(`  Open http://localhost:${PORT}/setup to configure\n`);
	});
} else {
	// ─── Running mode: full Key0 ──────────────────────────────────────

	const key0 = await import("@key0ai/key0");
	const { key0Router } = await import("@key0ai/key0/express");
	const { buildDockerTokenIssuer } = await import("../src/helpers/docker-token-issuer.js");

	type IAuditStore = key0.IAuditStore;
	type IChallengeStore = key0.IChallengeStore;
	type ISeenTxStore = key0.ISeenTxStore;
	type NetworkName = key0.NetworkName;
	type Plan = key0.Plan;
	type Route = key0.Route;
	const {
		processRefunds,
		PostgresAuditStore,
		PostgresChallengeStore,
		PostgresSeenTxStore,
		RedisAuditStore,
		RedisChallengeStore,
		RedisSeenTxStore,
		X402Adapter,
	} = key0;

	const NETWORK = (process.env.KEY0_NETWORK ?? "testnet") as NetworkName;
	const AGENT_NAME = process.env.AGENT_NAME ?? "Key0 Server";
	const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? "Payment-gated A2A endpoint";
	const AGENT_URL = process.env.AGENT_URL ?? `http://localhost:${PORT}`;
	const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "Key0";
	const PROVIDER_URL = process.env.PROVIDER_URL ?? "https://key0.ai";
	const BASE_PATH = process.env.BASE_PATH ?? "/a2a";
	const CHALLENGE_TTL_SECONDS = Number(process.env.CHALLENGE_TTL_SECONDS ?? 900);
	const ISSUE_TOKEN_API_SECRET = process.env.ISSUE_TOKEN_API_SECRET;
	const GAS_WALLET_PRIVATE_KEY = process.env.GAS_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
	const _PROXY_TO_BASE_URL = process.env.PROXY_TO_BASE_URL;
	const _KEY0_PROXY_SECRET = process.env.KEY0_PROXY_SECRET;
	const WALLET_PRIVATE_KEY = process.env.KEY0_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
	const REFUND_INTERVAL_MS = Number(process.env.REFUND_INTERVAL_MS ?? 60_000);
	const REFUND_MIN_AGE_MS = Number(process.env.REFUND_MIN_AGE_MS ?? 300_000);
	const REFUND_BATCH_SIZE = Number(process.env.REFUND_BATCH_SIZE ?? 50);
	const TOKEN_ISSUE_TIMEOUT_MS = Number(process.env.TOKEN_ISSUE_TIMEOUT_MS ?? 15_000);
	const TOKEN_ISSUE_RETRIES = Number(process.env.TOKEN_ISSUE_RETRIES ?? 2);
	const STORAGE_BACKEND = (process.env.STORAGE_BACKEND ?? "redis") as "redis" | "postgres";
	const DATABASE_URL = process.env.DATABASE_URL;
	const _RPC_URL_OVERRIDE =
		process.env.ALCHEMY_BASE_SEPOLIA_RPC_URL || process.env.RPC_URL_OVERRIDE;
	const _MCP_ENABLED = process.env.MCP_ENABLED === "true";

	// Plans — support both PLANS (raw JSON) and PLANS_B64 (base64-encoded JSON)
	const _DEFAULT_PLANS: Plan[] = [
		{
			planId: "basic",
			unitAmount: "$0.10",
		},
	];

	let plans: Plan[];
	try {
		if (process.env.PLANS_B64) {
			plans = JSON.parse(Buffer.from(process.env.PLANS_B64, "base64").toString("utf-8"));
		} else if (process.env.PLANS) {
			plans = JSON.parse(process.env.PLANS) as Plan[];
		} else {
			plans = _DEFAULT_PLANS;
		}
	} catch {
		console.error("FATAL: PLANS / PLANS_B64 env var is not valid JSON");
		process.exit(1);
	}

	let routes: Route[] = [];
	try {
		if (process.env.ROUTES_B64) {
			routes = JSON.parse(
				Buffer.from(process.env.ROUTES_B64, "base64").toString("utf-8"),
			) as Route[];
		} else if (process.env.ROUTES) {
			routes = JSON.parse(process.env.ROUTES) as Route[];
		}
	} catch {
		console.error("FATAL: ROUTES / ROUTES_B64 env var is not valid JSON");
		process.exit(1);
	}

	// ─── Storage ───────────────────────────────────────────────────────────

	// Redis is required for BullMQ refund cron queue, even when using Postgres storage
	let store: IChallengeStore;
	let seenTxStore: ISeenTxStore;
	let auditStore: IAuditStore;
	let redis: import("ioredis").default | null = null;

	if (STORAGE_BACKEND === "postgres") {
		if (!DATABASE_URL) {
			console.error("FATAL: DATABASE_URL is required when STORAGE_BACKEND=postgres");
			process.exit(1);
		}

		const postgres = (await import(/* @vite-ignore */ "postgres")).default;
		const sql = postgres(DATABASE_URL);

		store = new PostgresChallengeStore({ sql });
		seenTxStore = new PostgresSeenTxStore({ sql });
		auditStore = new PostgresAuditStore({ sql });

		// Still need Redis for BullMQ refund cron queue
		const Redis = (await import("ioredis")).default;
		redis = new Redis(REDIS_URL!);

		console.log("[key0] Using Postgres storage:", DATABASE_URL);
	} else {
		const Redis = (await import("ioredis")).default;
		redis = new Redis(REDIS_URL!);
		store = new RedisChallengeStore({
			redis,
			challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
		});
		seenTxStore = new RedisSeenTxStore({ redis });
		auditStore = new RedisAuditStore({ redis });
		console.log("[key0] Using Redis storage:", REDIS_URL);
	}

	// Token issuance — optional in proxy-only mode (no ISSUE_TOKEN_API)
	const fetchResourceCredentials = ISSUE_TOKEN_API
		? buildDockerTokenIssuer(ISSUE_TOKEN_API, {
				apiSecret: ISSUE_TOKEN_API_SECRET,
				plans,
			})
		: undefined;

	// Adapter & routes
	const adapter = new X402Adapter({
		network: NETWORK,
		...(_RPC_URL_OVERRIDE ? { rpcUrl: _RPC_URL_OVERRIDE } : {}),
	});

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
			planId,
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
			planId: string;
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
			!planId ||
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
			await store.create(
				{
					challengeId,
					requestId,
					clientAgentId,
					resourceId,
					planId,
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
				},
				{ actor: "system", reason: "test_setup" },
			);
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
			const success = await store.transition(
				challengeId,
				fromState as Parameters<IChallengeStore["transition"]>[1],
				toState as Parameters<IChallengeStore["transition"]>[2],
			);
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
		key0Router({
			config: {
				agentName: AGENT_NAME,
				agentDescription: AGENT_DESCRIPTION,
				agentUrl: AGENT_URL,
				providerName: PROVIDER_NAME,
				providerUrl: PROVIDER_URL,
				walletAddress: WALLET_ADDRESS as `0x${string}`,
				network: NETWORK,
				plans,
				routes,
				challengeTTLSeconds: CHALLENGE_TTL_SECONDS,
				basePath: BASE_PATH,
				fetchResourceCredentials,
				tokenIssueTimeoutMs: TOKEN_ISSUE_TIMEOUT_MS,
				tokenIssueRetries: TOKEN_ISSUE_RETRIES,
				mcp: _MCP_ENABLED,
				...(_RPC_URL_OVERRIDE ? { rpcUrl: _RPC_URL_OVERRIDE } : {}),
				...(GAS_WALLET_PRIVATE_KEY && redis
					? { gasWalletPrivateKey: GAS_WALLET_PRIVATE_KEY, redis }
					: {}),
				...(_PROXY_TO_BASE_URL
					? {
							proxyTo: {
								baseUrl: _PROXY_TO_BASE_URL,
								...(_KEY0_PROXY_SECRET ? { proxySecret: _KEY0_PROXY_SECRET } : {}),
							},
						}
					: {}),
			},
			adapter,
			store,
			seenTxStore,
			auditStore,
		}),
	);

	app.listen(PORT, () => {
		console.log("\n[key0] Server started");
		console.log(`  Network:    ${NETWORK}`);
		console.log(`  Port:       ${PORT}`);
		console.log(`  Wallet:     ${WALLET_ADDRESS}`);
		console.log(`  Token API:  ${ISSUE_TOKEN_API}`);
		console.log(`  Storage:    ${STORAGE_BACKEND.toUpperCase()}`);
		console.log(`  Setup UI:   http://localhost:${PORT}/setup`);
		console.log(`  Agent Card: ${AGENT_URL}/.well-known/agent.json`);
		console.log(
			`  Refund cron: ${WALLET_PRIVATE_KEY ? `every ${REFUND_INTERVAL_MS / 1000}s` : "DISABLED (set KEY0_WALLET_PRIVATE_KEY)"}\n`,
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
			...(_RPC_URL_OVERRIDE ? { rpcUrl: _RPC_URL_OVERRIDE } : {}),
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
