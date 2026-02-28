/**
 * AgentGate Standalone Service Example
 *
 * This example demonstrates how to deploy AgentGate as a separate service
 * that communicates with your backend via HTTP.
 *
 * Architecture:
 *   Agent -> AgentGate Service -> Backend (verify resource, issue token)
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
	type IssueTokenParams,
	type NetworkName,
	RedisChallengeStore,
	RedisSeenTxStore,
	type TokenIssuanceResult,
	X402Adapter,
	createRemoteResourceVerifier,
	createRemoteTokenIssuer,
	sharedSecretAuth,
	signedJwtAuth,
} from "@agentgate/sdk";
import { agentGateRouter } from "@agentgate/sdk/express";
import express from "express";
import Redis from "ioredis";

const PORT = Number(process.env.AGENTGATE_PORT ?? 3001);
const NETWORK = (process.env.AGENTGATE_NETWORK ?? "testnet") as NetworkName;
const SECRET = process.env.AGENTGATE_ACCESS_TOKEN_SECRET!;
const BACKEND_API_URL = process.env.BACKEND_API_URL!;
const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET!;
const AUTH_STRATEGY = process.env.AUTH_STRATEGY || "shared-secret"; // "shared-secret" | "jwt"

// Validate required environment variables
if (!SECRET || SECRET.length < 32) {
	console.error("ERROR: AGENTGATE_ACCESS_TOKEN_SECRET must be at least 32 characters");
	process.exit(1);
}

if (!BACKEND_API_URL) {
	console.error("ERROR: BACKEND_API_URL is required");
	process.exit(1);
}

if (AUTH_STRATEGY === "shared-secret" && !INTERNAL_AUTH_SECRET) {
	console.error("ERROR: INTERNAL_AUTH_SECRET is required for shared-secret auth");
	process.exit(1);
}

const app = express();
app.use(express.json());

// Redis for multi-instance support (optional, falls back to in-memory if not provided)
let store: RedisChallengeStore | undefined;
let seenTxStore: RedisSeenTxStore | undefined;

if (process.env.REDIS_URL) {
	const redis = new Redis(process.env.REDIS_URL);
	store = new RedisChallengeStore({ redis, challengeTTLSeconds: 900 });
	seenTxStore = new RedisSeenTxStore({ redis });
	console.log("Using Redis storage");
} else {
	console.log("Using in-memory storage (set REDIS_URL for production)");
}

// Create the x402 payment adapter
const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env.AGENTGATE_RPC_URL,
});

// Configure auth strategy for backend communication
let authProvider: AuthHeaderProvider;

// We need an issuer instance if using JWT auth strategy
// This is used for service-to-service auth, not for access tokens issued to agents
const serviceTokenIssuer = new AccessTokenIssuer(SECRET);

if (AUTH_STRATEGY === "jwt") {
	// Strategy 2: Signed JWT
	// Requires SECRET to be a private key (PEM) if algorithm is RS256, or shared secret for HS256
	// The backend must have the corresponding public key or shared secret
	console.log("Using Signed JWT auth strategy for backend communication");
	authProvider = signedJwtAuth(serviceTokenIssuer, "backend-service");
} else {
	// Strategy 1: Shared Secret (default)
	console.log("Using Shared Secret auth strategy for backend communication");
	authProvider = sharedSecretAuth("X-Internal-Auth", INTERNAL_AUTH_SECRET);
}

// Determine token issuance mode
const tokenMode = (process.env.TOKEN_MODE || "native") as "native" | "remote";

// Create remote verifier (calls backend to verify resources)
const remoteVerifier = createRemoteResourceVerifier({
	url: `${BACKEND_API_URL}/internal/verify-resource`,
	auth: authProvider,
	timeoutMs: 5000,
});

// Create token issuer callback based on mode
let onIssueToken: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;

if (tokenMode === "remote") {
	// Remote mode: Call backend to issue tokens
	console.log("Using Remote token issuance mode");
	const remoteTokenIssuer = createRemoteTokenIssuer({
		url: `${BACKEND_API_URL}/internal/issue-token`,
		auth: authProvider,
		timeoutMs: 10000,
	});
	onIssueToken = remoteTokenIssuer;
} else {
	// Native mode: Generate JWT locally using AccessTokenIssuer utility
	console.log("Using Native token issuance mode (local JWT)");
	const localTokenIssuer = new AccessTokenIssuer(SECRET);
	onIssueToken = async (params) => {
		return localTokenIssuer.sign(
			{
				sub: params.requestId,
				jti: params.challengeId,
				resourceId: params.resourceId,
				tierId: params.tierId,
				txHash: params.txHash,
			},
			3600, // Default TTL, could be made configurable
		);
	};
}

// Product catalog
const products = [
	{
		tierId: "basic",
		label: "Basic Access",
		amount: "$0.99",
		resourceType: "api-call",
		accessDurationSeconds: 3600,
	},
	{
		tierId: "premium",
		label: "Premium Access",
		amount: "$4.99",
		resourceType: "api-call",
		accessDurationSeconds: 86400,
	},
] as const;

// Mount AgentGate — serves agent card + A2A endpoint
app.use(
	agentGateRouter({
		config: {
			agentName: process.env.AGENT_NAME || "AgentGate Service",
			agentDescription: process.env.AGENT_DESCRIPTION || "Payment-gated API access for AI agents",
			agentUrl: process.env.AGENTGATE_PUBLIC_URL || `http://localhost:${PORT}`,
			providerName: process.env.PROVIDER_NAME || "Example Corp",
			providerUrl: process.env.PROVIDER_URL || "https://example.com",
			walletAddress: (process.env.AGENTGATE_WALLET_ADDRESS ||
				"0x0000000000000000000000000000000000000000") as `0x${string}`,
			network: NETWORK,
			challengeTTLSeconds: Number(process.env.CHALLENGE_TTL_SECONDS ?? 900),
			products,
			onVerifyResource: remoteVerifier,
			onIssueToken,
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
					console.error("[AgentGate] Failed to notify backend:", err);
					// Don't fail the flow if notification fails
				}
			},
			resourceEndpointTemplate: `${BACKEND_API_URL}/api/{resourceId}`,
		},
		adapter,
		store,
		seenTxStore,
	}),
);

// Health check
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		service: "agentgate",
		tokenMode,
		network: NETWORK,
	});
});

// Token info endpoint (for backend to discover token format)
app.get("/.well-known/token-info", (req, res) => {
	res.json({
		tokenType: "JWT",
		algorithm: tokenMode === "remote" ? "custom" : "HS256", // Could be RS256 if configured
		// If using RS256, include public key here:
		// publicKey: process.env.AGENTGATE_PUBLIC_KEY,
	});
});

app.listen(PORT, () => {
	console.log("\n🚀 AgentGate Standalone Service");
	console.log(`   Port: ${PORT}`);
	console.log(`   Network: ${NETWORK}`);
	console.log(`   Token Mode: ${tokenMode}`);
	console.log(`   Backend URL: ${BACKEND_API_URL}`);
	console.log(
		`   Agent Card: ${process.env.AGENTGATE_PUBLIC_URL || `http://localhost:${PORT}`}/.well-known/agent.json`,
	);
	console.log(
		`   A2A Endpoint: ${process.env.AGENTGATE_PUBLIC_URL || `http://localhost:${PORT}`}/agent\n`,
	);
});
