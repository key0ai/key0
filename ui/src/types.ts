export interface Plan {
	planId: string;
	unitAmount: string;
	description: string;
}

export interface Config {
	// Required
	walletAddress: string;
	issueTokenApi: string;
	network: "testnet" | "mainnet";

	// Storage
	storageBackend: "redis" | "postgres";
	redisUrl: string;
	databaseUrl: string;

	// Server
	port: string;
	basePath: string;

	// Agent Card
	agentName: string;
	agentDescription: string;
	agentUrl: string;
	providerName: string;
	providerUrl: string;

	// Plans
	plans: Plan[];

	// Challenge
	challengeTtlSeconds: string;

	// MCP
	mcpEnabled: boolean;

	// Token API Auth
	backendAuthStrategy: "shared-secret" | "jwt";
	issueTokenApiSecret: string;

	// Settlement
	gasWalletPrivateKey: string;

	// Refund cron
	walletPrivateKey: string;
	refundIntervalMs: string;
	refundMinAgeMs: string;
}

export const defaultConfig: Config = {
	walletAddress: "",
	issueTokenApi: "",
	network: "testnet",

	storageBackend: "redis",
	redisUrl: "redis://redis:6379",
	databaseUrl: "",

	port: "3000",
	basePath: "/a2a",

	agentName: "",
	agentDescription: "",
	agentUrl: "http://localhost:3000",
	providerName: "",
	providerUrl: "",

	plans: [
		{
			planId: "starter",
			unitAmount: "$10.00",
			description: "",
		},
	],

	challengeTtlSeconds: "900",

	mcpEnabled: false,

	backendAuthStrategy: "shared-secret",
	issueTokenApiSecret: "",

	gasWalletPrivateKey: "",

	walletPrivateKey: "",
	refundIntervalMs: "60000",
	refundMinAgeMs: "300000",
};
