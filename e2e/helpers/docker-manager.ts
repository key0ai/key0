/**
 * Manages docker compose lifecycle for e2e tests.
 */

import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

const E2E_DIR = path.resolve(import.meta.dir, "..");

export type StackConfig = {
	composeFile?: string;
	projectName?: string;
	/** milliseconds to wait for health before giving up (default: 60_000) */
	healthTimeoutMs?: number;
};

function compose(args: string, config: StackConfig): void {
	const file = config.composeFile ?? "docker-compose.e2e.yml";
	const project = config.projectName ?? "key0-e2e";
	const cmd = `docker compose -f ${file} -p ${project} ${args}`;
	execSync(cmd, { cwd: E2E_DIR, stdio: "inherit", env: { ...process.env } });
}

export function startDockerStack(config: StackConfig = {}): void {
	console.log("[docker] Starting stack...");
	compose("up -d --build --wait", config);
	console.log("[docker] Stack healthy.");
}

export function stopDockerStack(config: StackConfig = {}): void {
	console.log("[docker] Stopping stack...");
	compose("down -v", config);
	console.log("[docker] Stack stopped.");
}

/** Wait for an HTTP endpoint to return 2xx. */
export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await Bun.sleep(1000);
	}
	throw new Error(`Timed out waiting for ${url}`);
}

/** Print recent docker compose logs (for debugging on failure). */
export function printLogs(config: StackConfig = {}): void {
	const file = config.composeFile ?? "docker-compose.e2e.yml";
	const project = config.projectName ?? "key0-e2e";
	const result = spawnSync("docker", ["compose", "-f", file, "-p", project, "logs", "--tail=100"], {
		cwd: E2E_DIR,
		encoding: "utf8",
		env: { ...process.env },
	});
	console.log(result.stdout);
	console.error(result.stderr);
}
