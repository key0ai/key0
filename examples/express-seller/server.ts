import type { NetworkName } from "@riklr/key0";
import { AccessTokenIssuer, RedisChallengeStore, RedisSeenTxStore, X402Adapter } from "@riklr/key0";
import { key0Router, validateAccessToken } from "@riklr/key0/express";
import express from "express";
import Redis from "ioredis";

const PORT = Number(process.env["PORT"] ?? 3000);
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? `http://localhost:${PORT}`;
const NETWORK = (process.env["KEY0_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = (process.env["KEY0_WALLET_ADDRESS"] ??
	"0x0000000000000000000000000000000000000000") as `0x${string}`;
const SECRET =
	process.env["KEY0_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const app = express();
app.use(express.json());

// Create the x402 payment adapter
const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env["KEY0_RPC_URL"],
});

// Storage — Redis required
const redis = new Redis(REDIS_URL);
const store = new RedisChallengeStore({ redis });
const seenTxStore = new RedisSeenTxStore({ redis });

// Create token issuer (opt-in utility for JWT generation)
const tokenIssuer = new AccessTokenIssuer(SECRET);

// Mount Key0 — serves agent card + A2A endpoint
app.use(
	key0Router({
		config: {
			agentName: "Photo Gallery Agent",
			agentDescription: "Purchase access to premium photos via USDC payments on Base",
			agentUrl: PUBLIC_URL,
			providerName: "Example Corp",
			providerUrl: "https://example.com",
			walletAddress: WALLET,
			network: NETWORK,
			challengeTTLSeconds: 900,
			plans: [
				{ planId: "single-photo", unitAmount: "$0.10", description: "Single photo access." },
				{ planId: "full-album", unitAmount: "$1.00", description: "Full album access (24h)." },
			],
			fetchResourceCredentials: async (params) => {
				// Generate JWT using the opt-in AccessTokenIssuer utility
				const ttl = params.planId === "single-photo" ? 3600 : 86400;
				return tokenIssuer.sign(
					{
						sub: params.requestId,
						jti: params.challengeId,
						resourceId: params.resourceId,
						planId: params.planId,
						txHash: params.txHash,
					},
					ttl,
				);
			},
			onPaymentReceived: async (grant) => {
				console.log(`[Payment] Received payment for ${grant.resourceId} (${grant.planId})`);
				console.log(`  TX: ${grant.explorerUrl}`);
			},
			resourceEndpointTemplate: `${PUBLIC_URL}/api/photos/{resourceId}`,
		},
		adapter,
		store,
		seenTxStore,
	}),
);

// Protect existing API routes with access token validation
app.use("/api", validateAccessToken({ secret: SECRET }));

// Sample protected endpoint
app.get("/api/photos/:id", (req, res) => {
	const photoId = req.params["id"];
	// Token validation already happened via validateAccessToken middleware
	// Token with resourceId="default" grants tier-based access to all photos
	res.json({
		id: photoId,
		url: `https://cdn.example.com/photos/${photoId}.jpg`,
		title: `Premium Photo ${photoId}`,
		resolution: "4K",
	});
});

app.listen(PORT, () => {
	console.log(`\nPhoto Gallery Agent running on ${PUBLIC_URL}`);
	console.log(`  Agent card: ${PUBLIC_URL}/.well-known/agent.json`);
	console.log(`  A2A endpoint: ${PUBLIC_URL}/a2a/jsonrpc`);
	console.log(`  Network: ${NETWORK}`);
	console.log(`  Wallet: ${WALLET}\n`);
});
