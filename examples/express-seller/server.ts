import { AccessTokenIssuer, RedisSeenTxStore, X402Adapter } from "@riklr/agentgate";
import type { NetworkName } from "@riklr/agentgate";
import { agentGateRouter, validateAccessToken } from "@riklr/agentgate/express";
import express from "express";

const PORT = Number(process.env["PORT"] ?? 3000);
const PUBLIC_URL = process.env["PUBLIC_URL"] ?? `http://localhost:${PORT}`;
const NETWORK = (process.env["AGENTGATE_NETWORK"] ?? "testnet") as NetworkName;
const WALLET = (process.env["AGENTGATE_WALLET_ADDRESS"] ??
	"0x0000000000000000000000000000000000000000") as `0x${string}`;
const SECRET =
	process.env["AGENTGATE_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";

const app = express();
app.use(express.json());

// Create the x402 payment adapter
const adapter = new X402Adapter({
	network: NETWORK,
	rpcUrl: process.env["AGENTGATE_RPC_URL"],
});

// Create token issuer (opt-in utility for JWT generation)
const tokenIssuer = new AccessTokenIssuer(SECRET);

// Mount AgentGate — serves agent card + A2A endpoint
app.use(
	agentGateRouter({
		config: {
			agentName: "Photo Gallery Agent",
			agentDescription: "Purchase access to premium photos via USDC payments on Base",
			agentUrl: PUBLIC_URL,
			providerName: "Example Corp",
			providerUrl: "https://example.com",
			walletAddress: WALLET,
			network: NETWORK,
			challengeTTLSeconds: 900,
			products: [
				{
					tierId: "single-photo",
					label: "Single Photo",
					amount: "$0.10",
					resourceType: "photo",
					accessDurationSeconds: 3600,
				},
				{
					tierId: "full-album",
					label: "Full Album Access",
					amount: "$1.00",
					resourceType: "album",
					accessDurationSeconds: 86400,
				},
			],
			onVerifyResource: async (resourceId: string, _tierId: string) => {
				// Accept "default" for general API access (tier-scoped)
				if (resourceId === "default") {
					return true;
				}

				// In a real app, check your database for specific resources
				const validResources = ["photo-1", "photo-2", "photo-3", "album-1"];
				return validResources.includes(resourceId);
			},
			onIssueToken: async (params) => {
				// Generate JWT using the opt-in AccessTokenIssuer utility
				const ttl = params.tierId === "single-photo" ? 3600 : 86400;
				return tokenIssuer.sign(
					{
						sub: params.requestId,
						jti: params.challengeId,
						resourceId: params.resourceId,
						tierId: params.tierId,
						txHash: params.txHash,
					},
					ttl,
				);
			},
			onPaymentReceived: async (grant) => {
				console.log(`[Payment] Received payment for ${grant.resourceId} (${grant.tierId})`);
				console.log(`  TX: ${grant.explorerUrl}`);
			},
			resourceEndpointTemplate: `${PUBLIC_URL}/api/photos/{resourceId}`,
		},
		adapter,
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
	console.log(`  A2A endpoint: ${PUBLIC_URL}/agent`);
	console.log(`  Network: ${NETWORK}`);
	console.log(`  Wallet: ${WALLET}\n`);
});
