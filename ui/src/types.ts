export interface Plan {
	planId: string;
	unitAmount: string;
	description: string;
}

export interface Route {
	routeId: string;
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	path: string;
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

	// Agent Card (agentName & agentDescription derived from providerName)
	agentUrl: string;
	providerName: string;
	providerUrl: string;

	// Plans
	plans: Plan[];

	// Routes
	routes: Route[];
	proxyToBaseUrl: string;
	proxySecret: string;

	// Challenge
	challengeTtlSeconds: string;

	// MCP
	mcpEnabled: boolean;

	// Token API Auth
	backendAuthStrategy: "none" | "shared-secret" | "jwt";
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

	routes: [],
	proxyToBaseUrl: "",
	proxySecret: "",

	challengeTtlSeconds: "900",

	mcpEnabled: true,

	backendAuthStrategy: "none",
	issueTokenApiSecret: "",

	gasWalletPrivateKey: "",

	walletPrivateKey: "",
	refundIntervalMs: "60000",
	refundMinAgeMs: "300000",
};
