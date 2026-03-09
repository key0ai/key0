/**
 * Global e2e setup — loaded via `bun test --preload ./global-setup.ts`.
 *
 * Starts (once per test run):
 *   1. Backend server (port 3001) — in-process Express
 *   2. Docker stack (AgentGate port 3000 + Redis port 6379) — via docker compose
 *
 * Tears down both in afterAll.
 *
 * Note: challenge-timeout.test.ts and refund-failure.test.ts each manage their
 * own separate docker stacks in their own beforeAll/afterAll.
 */

import { afterAll, beforeAll } from "bun:test";
import type { Server } from "node:http";
import { AGENTGATE_URL } from "./fixtures/constants.ts";
import { startBackend } from "./helpers/backend-server.ts";
import {
	printLogs,
	type StackConfig,
	startDockerStack,
	stopDockerStack,
} from "./helpers/docker-manager.ts";
import { connectRedis, disconnectRedis } from "./helpers/redis-client.ts";
import { setStorageBackend } from "./helpers/storage-client.ts";

let backendServer: Server | null = null;

// Detect storage backend from env var
const usePostgres = process.env.E2E_STORAGE_BACKEND === "postgres";

const STACK_CONFIG: StackConfig = usePostgres
	? {
			composeFile: "docker-compose.e2e-postgres.yml",
			projectName: "agentgate-e2e-pg",
		}
	: {
			composeFile: "docker-compose.e2e.yml",
			projectName: "agentgate-e2e",
		};

beforeAll(async () => {
	// 1. Start the backend
	backendServer = await startBackend();

	// 2. Start the Docker stack (builds image + waits for health)
	console.log(`[setup] Using storage backend: ${usePostgres ? "postgres" : "redis"}`);
	try {
		startDockerStack(STACK_CONFIG);
	} catch (err) {
		console.error("[setup] Docker stack failed to start:", err);
		printLogs(STACK_CONFIG);
		throw err;
	}

	// 3. Verify AgentGate is reachable
	const healthRes = await fetch(`${AGENTGATE_URL}/health`);
	if (!healthRes.ok) {
		throw new Error(`AgentGate health check failed: ${healthRes.status}`);
	}
	const health = await healthRes.json();
	console.log("[setup] AgentGate health:", health);

	// 4. Configure storage-agnostic helpers
	if (usePostgres) {
		// For Postgres, helpers talk to AgentGate via HTTP
		setStorageBackend("postgres", undefined, AGENTGATE_URL, null);
		console.log("[setup] Storage helpers configured for Postgres");
	} else {
		// For Redis, connect the Redis client for direct state assertions
		connectRedis();
		setStorageBackend("redis", undefined, AGENTGATE_URL, null);
	}

	console.log("[setup] Ready.");
});

afterAll(async () => {
	if (!usePostgres) {
		await disconnectRedis();
	}

	if (backendServer) {
		await new Promise<void>((resolve) => backendServer!.close(() => resolve()));
		backendServer = null;
	}

	stopDockerStack(STACK_CONFIG);
});
