import type { Config, Plan } from "./types";

/** Serialize a Plan to the JSON shape expected by Key0 config (strips empty optional fields). */
function serializePlan(p: Plan) {
	return {
		planId: p.planId,
		unitAmount: p.unitAmount,
		...(p.description ? { description: p.description } : {}),
	};
}

export function generateEnv(config: Config): string {
	const lines: string[] = [
		"# ──────────────────────────────────────────────────────────────────────────────",
		"# Key0 Docker — Generated Configuration",
		"# ──────────────────────────────────────────────────────────────────────────────",
		"",
		"# ── Required ──────────────────────────────────────────────────────────────────",
		"",
		`KEY0_WALLET_ADDRESS=${config.walletAddress}`,
		`ISSUE_TOKEN_API=${config.issueTokenApi}`,
		"",
		"# ── Network ───────────────────────────────────────────────────────────────────",
		"",
		`KEY0_NETWORK=${config.network}`,
		"",
		"# ── Storage ───────────────────────────────────────────────────────────────────",
		"",
		`STORAGE_BACKEND=${config.storageBackend}`,
		`REDIS_URL=${config.redisUrl}`,
	];

	if (config.storageBackend === "postgres" && config.databaseUrl) {
		lines.push(`DATABASE_URL=${config.databaseUrl}`);
	}

	lines.push(
		"",
		"# ── Server ────────────────────────────────────────────────────────────────────",
		"",
		`PORT=${config.port}`,
	);

	if (config.basePath && config.basePath !== "/a2a") {
		lines.push(`BASE_PATH=${config.basePath}`);
	}

	lines.push(
		"",
		"# ── Agent Card ────────────────────────────────────────────────────────────────",
		"",
	);
	if (config.agentName) lines.push(`AGENT_NAME=${config.agentName}`);
	if (config.agentDescription) lines.push(`AGENT_DESCRIPTION=${config.agentDescription}`);
	lines.push(`AGENT_URL=${config.agentUrl}`);

	if (config.providerName) {
		lines.push(`PROVIDER_NAME=${config.providerName}`);
	}
	if (config.providerUrl) {
		lines.push(`PROVIDER_URL=${config.providerUrl}`);
	}

	// Plans
	if (config.plans.length > 0) {
		const plansJson = JSON.stringify(config.plans.map(serializePlan), null, 2);
		lines.push(
			"",
			"# ── Pricing Plans ─────────────────────────────────────────────────────────────",
			"",
			`PLANS='${plansJson}'`,
		);
	}

	if (config.challengeTtlSeconds && config.challengeTtlSeconds !== "900") {
		lines.push(
			"",
			"# ── Challenge ─────────────────────────────────────────────────────────────────",
			"",
			`CHALLENGE_TTL_SECONDS=${config.challengeTtlSeconds}`,
		);
	}

	if (config.mcpEnabled) {
		lines.push(
			"",
			"# ── MCP ───────────────────────────────────────────────────────────────────────",
			"",
			"MCP_ENABLED=true",
		);
	}

	if (config.backendAuthStrategy !== "shared-secret" || config.issueTokenApiSecret) {
		lines.push(
			"",
			"# ── Token API Auth ────────────────────────────────────────────────────────────",
			"",
		);
		if (config.backendAuthStrategy !== "shared-secret") {
			lines.push(`BACKEND_AUTH_STRATEGY=${config.backendAuthStrategy}`);
		}
		if (config.issueTokenApiSecret) {
			lines.push(`ISSUE_TOKEN_API_SECRET=${config.issueTokenApiSecret}`);
		}
	}

	if (config.gasWalletPrivateKey) {
		lines.push(
			"",
			"# ── Settlement ────────────────────────────────────────────────────────────────",
			"",
			`GAS_WALLET_PRIVATE_KEY=${config.gasWalletPrivateKey}`,
		);
	}

	if (config.walletPrivateKey) {
		lines.push(
			"",
			"# ── Refund Cron ───────────────────────────────────────────────────────────────",
			"",
			`KEY0_WALLET_PRIVATE_KEY=${config.walletPrivateKey}`,
		);
		if (config.refundIntervalMs !== "60000") {
			lines.push(`REFUND_INTERVAL_MS=${config.refundIntervalMs}`);
		}
		if (config.refundMinAgeMs !== "300000") {
			lines.push(`REFUND_MIN_AGE_MS=${config.refundMinAgeMs}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}

export function generateDockerRun(config: Config): string {
	const envFlags: string[] = [];

	envFlags.push(`-e KEY0_WALLET_ADDRESS=${config.walletAddress}`);
	envFlags.push(`-e ISSUE_TOKEN_API=${config.issueTokenApi}`);
	envFlags.push(`-e KEY0_NETWORK=${config.network}`);
	envFlags.push(`-e STORAGE_BACKEND=${config.storageBackend}`);
	envFlags.push(`-e REDIS_URL=${config.redisUrl}`);
	if (config.storageBackend === "postgres" && config.databaseUrl) {
		envFlags.push(`-e DATABASE_URL=${config.databaseUrl}`);
	}
	envFlags.push(`-e PORT=${config.port}`);
	if (config.agentName) envFlags.push(`-e AGENT_NAME="${config.agentName}"`);
	if (config.agentDescription) envFlags.push(`-e AGENT_DESCRIPTION="${config.agentDescription}"`);
	envFlags.push(`-e AGENT_URL=${config.agentUrl}`);

	if (config.basePath && config.basePath !== "/a2a") {
		envFlags.push(`-e BASE_PATH=${config.basePath}`);
	}
	if (config.providerName) {
		envFlags.push(`-e PROVIDER_NAME="${config.providerName}"`);
	}
	if (config.providerUrl) {
		envFlags.push(`-e PROVIDER_URL=${config.providerUrl}`);
	}
	if (config.plans.length > 0) {
		const json = JSON.stringify(config.plans.map(serializePlan));
		envFlags.push(`-e PLANS='${json}'`);
	}
	if (config.challengeTtlSeconds !== "900") {
		envFlags.push(`-e CHALLENGE_TTL_SECONDS=${config.challengeTtlSeconds}`);
	}
	if (config.mcpEnabled) {
		envFlags.push(`-e MCP_ENABLED=true`);
	}
	if (config.backendAuthStrategy !== "shared-secret") {
		envFlags.push(`-e BACKEND_AUTH_STRATEGY=${config.backendAuthStrategy}`);
	}
	if (config.issueTokenApiSecret) {
		envFlags.push(`-e ISSUE_TOKEN_API_SECRET=${config.issueTokenApiSecret}`);
	}
	if (config.gasWalletPrivateKey) {
		envFlags.push(`-e GAS_WALLET_PRIVATE_KEY=${config.gasWalletPrivateKey}`);
	}
	if (config.walletPrivateKey) {
		envFlags.push(`-e KEY0_WALLET_PRIVATE_KEY=${config.walletPrivateKey}`);
	}

	return `docker run \\\n  ${envFlags.join(" \\\n  ")} \\\n  -p ${config.port}:${config.port} \\\n  riklr/key0:latest`;
}

export function generateDockerCompose(config: Config): string {
	const envVars: Record<string, string> = {
		KEY0_WALLET_ADDRESS: config.walletAddress,
		ISSUE_TOKEN_API: config.issueTokenApi,
		KEY0_NETWORK: config.network,
		STORAGE_BACKEND: config.storageBackend,
		REDIS_URL: config.storageBackend === "postgres" ? config.redisUrl : "redis://redis:6379",
		PORT: config.port,
		AGENT_URL: config.agentUrl,
	};

	if (config.agentName) envVars.AGENT_NAME = config.agentName;
	if (config.agentDescription) envVars.AGENT_DESCRIPTION = config.agentDescription;

	if (config.storageBackend === "postgres" && config.databaseUrl) {
		envVars.DATABASE_URL = config.databaseUrl;
	}

	if (config.basePath && config.basePath !== "/a2a") {
		envVars.BASE_PATH = config.basePath;
	}
	if (config.providerName) envVars.PROVIDER_NAME = config.providerName;
	if (config.providerUrl) envVars.PROVIDER_URL = config.providerUrl;
	if (config.plans.length > 0) {
		envVars.PLANS = JSON.stringify(config.plans.map(serializePlan));
	}
	if (config.challengeTtlSeconds !== "900") {
		envVars.CHALLENGE_TTL_SECONDS = config.challengeTtlSeconds;
	}
	if (config.mcpEnabled) {
		envVars.MCP_ENABLED = "true";
	}
	if (config.backendAuthStrategy !== "shared-secret") {
		envVars.BACKEND_AUTH_STRATEGY = config.backendAuthStrategy;
	}
	if (config.issueTokenApiSecret) {
		envVars.ISSUE_TOKEN_API_SECRET = config.issueTokenApiSecret;
	}
	if (config.gasWalletPrivateKey) {
		envVars.GAS_WALLET_PRIVATE_KEY = config.gasWalletPrivateKey;
	}
	if (config.walletPrivateKey) {
		envVars.KEY0_WALLET_PRIVATE_KEY = config.walletPrivateKey;
		if (config.refundIntervalMs !== "60000") {
			envVars.REFUND_INTERVAL_MS = config.refundIntervalMs;
		}
		if (config.refundMinAgeMs !== "300000") {
			envVars.REFUND_MIN_AGE_MS = config.refundMinAgeMs;
		}
	}

	const envLines = Object.entries(envVars)
		.map(([k, v]) => `      ${k}: "${v}"`)
		.join("\n");

	const dependsOn = ["redis"];
	if (config.storageBackend === "postgres") dependsOn.push("postgres");

	let services = `services:
  key0:
    image: riklr/key0:latest
    ports:
      - "${config.port}:${config.port}"
    environment:
${envLines}
    depends_on:
${dependsOn.map((d) => `      - ${d}`).join("\n")}

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
`;

	if (config.storageBackend === "postgres") {
		services += `
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: key0
      POSTGRES_PASSWORD: key0
      POSTGRES_DB: key0
    volumes:
      - pg-data:/var/lib/postgresql/data
`;
	}

	services += `\nvolumes:\n  redis-data:\n`;
	if (config.storageBackend === "postgres") {
		services += `  pg-data:\n`;
	}

	return services;
}
