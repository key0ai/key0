/**
 * Client agent demonstrating the full AgentGate payment flow on Base Sepolia testnet:
 *
 *   1. Discover the seller's agent card
 *   2. Request access (receive payment challenge)
 *   3. Pay USDC on-chain (real testnet transaction)
 *   4. Submit payment proof with txHash
 *   5. Use the access token to call the protected API
 *
 * Prerequisites:
 *   - Copy .env.example to .env and add your private key
 *   - Your wallet needs testnet USDC on Base Sepolia (get from https://faucet.circle.com/)
 *   - Start the seller: cd ../express-seller && bun run start
 *
 * Usage:
 *   bun run start
 */

import type { AccessGrant, AgentCard, NetworkName, X402Challenge } from "@riklr/agentgate";
import { CHAIN_CONFIGS, USDC_ABI, parseDollarToUsdcMicro } from "@riklr/agentgate";
import { http, createPublicClient, createWalletClient, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const SELLER_URL = process.env["SELLER_URL"] ?? "http://localhost:3000";
const PRIVATE_KEY = process.env["WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;
const NETWORK = (process.env["AGENTGATE_NETWORK"] ?? "testnet") as NetworkName;

if (!PRIVATE_KEY) {
	console.error("ERROR: WALLET_PRIVATE_KEY is required in .env");
	console.error("Copy .env.example to .env and add your private key.");
	process.exit(1);
}

const chain = NETWORK === "mainnet" ? base : baseSepolia;
const chainConfig = CHAIN_CONFIGS[NETWORK];
const account = privateKeyToAccount(PRIVATE_KEY);

const walletClient = createWalletClient({
	chain,
	transport: http(chainConfig.rpcUrl),
	account,
});

const publicClient = createPublicClient({
	chain,
	transport: http(chainConfig.rpcUrl),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getUsdcBalance(address: `0x${string}`): Promise<string> {
	const raw = await publicClient.readContract({
		address: chainConfig.usdcAddress,
		abi: USDC_ABI,
		functionName: "balanceOf",
		args: [address],
	});
	return formatUnits(raw, 6);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== AgentGate Client Agent ===\n");
	console.log(`  Network:  ${NETWORK} (${chain.name})`);
	console.log(`  Wallet:   ${account.address}`);
	console.log(`  Seller:   ${SELLER_URL}`);

	const balance = await getUsdcBalance(account.address);
	console.log(`  Balance:  ${balance} USDC\n`);

	if (Number.parseFloat(balance) === 0) {
		console.error(
			"ERROR: Your wallet has 0 USDC. Get testnet USDC from https://faucet.circle.com/",
		);
		process.exit(1);
	}

	// -----------------------------------------------------------------------
	// Step 1: Discover the agent card
	// -----------------------------------------------------------------------
	console.log("1. Discovering agent card...");
	const cardRes = await fetch(`${SELLER_URL}/.well-known/agent.json`);
	if (!cardRes.ok) {
		console.error(`   Failed to fetch agent card: ${cardRes.status}`);
		process.exit(1);
	}

	const card: AgentCard = await cardRes.json();
	console.log(`   Agent: ${card.name}`);
	console.log(`   Skills: ${card.skills.map((s) => s.id).join(", ")}`);

	const requestSkill = card.skills.find((s) => s.id === "request-access");
	if (!requestSkill?.pricing?.[0]) {
		console.error("   No pricing found on request-access skill");
		process.exit(1);
	}

	const tier = requestSkill.pricing[0];
	console.log(`   Tier: ${tier.label} — ${tier.amount} USDC on chain ${tier.chainId}\n`);

	// -----------------------------------------------------------------------
	// Step 2: Request access
	// -----------------------------------------------------------------------
	console.log("2. Requesting access...");
	const requestId = crypto.randomUUID();
	const basePath = "/a2a/jsonrpc";

	const accessRes = await fetch(`${SELLER_URL}${basePath}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "1",
			method: "tasks/send",
			params: {
				id: "task-1",
				message: {
					role: "user",
					parts: [
						{
							type: "data",
							data: {
								type: "AccessRequest",
								requestId,
								resourceId: "photo-1",
								tierId: tier.tierId,
								clientAgentId: `agent://${account.address}`,
							},
							mimeType: "application/json",
						},
					],
				},
			},
		}),
	});

	const accessBody = await accessRes.json();

	if (accessBody.result?.status?.state === "failed") {
		console.error(`   Access request failed: ${JSON.stringify(accessBody.result.status.message)}`);
		process.exit(1);
	}

	const challenge: X402Challenge = accessBody.result.status.message.parts[0].data;
	console.log(`   Challenge ID: ${challenge.challengeId}`);
	console.log(`   Amount: ${challenge.amount} USDC`);
	console.log(`   Chain: ${challenge.chainId}`);
	console.log(`   Destination: ${challenge.destination}`);
	console.log(`   Expires: ${challenge.expiresAt}\n`);

	// -----------------------------------------------------------------------
	// Step 3: Pay USDC on-chain
	// -----------------------------------------------------------------------
	console.log("3. Paying USDC on-chain...");
	const amountRaw = parseDollarToUsdcMicro(challenge.amount);
	console.log(
		`   Sending ${challenge.amount} (${amountRaw} micro-units) to ${challenge.destination}`,
	);

	const txHash = await walletClient.writeContract({
		address: chainConfig.usdcAddress,
		abi: USDC_ABI,
		functionName: "transfer",
		args: [challenge.destination, amountRaw],
	});
	console.log(`   TX sent: ${txHash}`);
	console.log(`   Explorer: ${chainConfig.explorerBaseUrl}/tx/${txHash}`);
	console.log("   Waiting for confirmation...");

	const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
	console.log(`   Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})\n`);

	// -----------------------------------------------------------------------
	// Step 4: Submit payment proof
	// -----------------------------------------------------------------------
	console.log("4. Submitting payment proof...");
	const proofRes = await fetch(`${SELLER_URL}${basePath}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "2",
			method: "tasks/send",
			params: {
				id: "task-2",
				message: {
					role: "user",
					parts: [
						{
							type: "data",
							data: {
								type: "PaymentProof",
								challengeId: challenge.challengeId,
								requestId,
								chainId: challenge.chainId,
								txHash,
								amount: challenge.amount,
								asset: "USDC",
								fromAgentId: `agent://${account.address}`,
							},
							mimeType: "application/json",
						},
					],
				},
			},
		}),
	});

	const proofBody = await proofRes.json();

	if (proofBody.result?.status?.state === "failed") {
		console.error(
			`   Proof verification failed: ${JSON.stringify(proofBody.result.status.message)}`,
		);
		process.exit(1);
	}

	const grant: AccessGrant = proofBody.result.status.message.parts[0].data;
	console.log("   Access granted!");
	console.log(`   Token type: ${grant.tokenType}`);
	console.log(`   Expires: ${grant.expiresAt}`);
	console.log(`   Resource: ${grant.resourceEndpoint}`);
	console.log(`   TX: ${grant.explorerUrl}\n`);

	// -----------------------------------------------------------------------
	// Step 5: Use the access token
	// -----------------------------------------------------------------------
	console.log("5. Calling protected API...");
	const apiRes = await fetch(grant.resourceEndpoint, {
		headers: {
			Authorization: `${grant.tokenType} ${grant.accessToken}`,
		},
	});

	if (apiRes.ok) {
		const data = await apiRes.json();
		console.log(`   Response: ${JSON.stringify(data, null, 2)}\n`);
	} else {
		const err = await apiRes.json();
		console.log(`   Error: ${JSON.stringify(err)}\n`);
	}

	// -----------------------------------------------------------------------
	// Done
	// -----------------------------------------------------------------------
	const finalBalance = await getUsdcBalance(account.address);
	console.log(`  Final balance: ${finalBalance} USDC`);
	console.log("\n=== Flow complete ===");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
