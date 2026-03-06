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
import { printLogs, startDockerStack, stopDockerStack } from "./helpers/docker-manager.ts";
import { connectRedis, disconnectRedis } from "./helpers/redis-client.ts";

let backendServer: Server | null = null;

beforeAll(async () => {
	// 1. Start the backend
	backendServer = await startBackend();

	// 2. Start the Docker stack (builds image + waits for health)
	try {
		startDockerStack();
	} catch (err) {
		console.error("[setup] Docker stack failed to start:", err);
		printLogs();
		throw err;
	}

	// 3. Verify AgentGate is reachable
	const healthRes = await fetch(`${AGENTGATE_URL}/health`);
	if (!healthRes.ok) {
		throw new Error(`AgentGate health check failed: ${healthRes.status}`);
	}
	console.log("[setup] AgentGate health:", await healthRes.json());

	// 4. Connect Redis client for assertions
	connectRedis();

	console.log("[setup] Ready.");
});

afterAll(async () => {
	await disconnectRedis();

	if (backendServer) {
		await new Promise<void>((resolve) => backendServer!.close(() => resolve()));
		backendServer = null;
	}

	stopDockerStack();
});
