/**
 * Simple x402 Client Example
 *
 * Demonstrates the streamlined x402 HTTP payment flow:
 * 1. Discover agent card
 * 2. POST AccessRequest to /access endpoint → receive 402 with PAYMENT-REQUIRED header
 * 3. Pay USDC on-chain
 * 4. Retry same request with PAYMENT-SIGNATURE header → receive AccessGrant
 * 5. Use access token to call protected API
 *
 * Prerequisites:
 *   - Seller running on localhost:3000
 *   - Wallet with testnet USDC on Base Sepolia
 *
 * Usage:
 *   WALLET_PRIVATE_KEY=0x... bun run examples/simple-x402-client.ts
 */

import type { AccessGrant, AgentCard } from "@agentgate/sdk";
import { CHAIN_CONFIGS, USDC_ABI, parseDollarToUsdcMicro } from "@agentgate/sdk";
import { http, createPublicClient, createWalletClient, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Configuration
const SELLER_URL = process.env["SELLER_URL"] ?? "http://localhost:3000";
const PRIVATE_KEY = process.env["WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;

if (!PRIVATE_KEY) {
	console.error("ERROR: WALLET_PRIVATE_KEY is required");
	console.error("Usage: WALLET_PRIVATE_KEY=0x... bun run examples/simple-x402-client.ts");
	process.exit(1);
}

const chainConfig = CHAIN_CONFIGS["testnet"];
const account = privateKeyToAccount(PRIVATE_KEY);

const walletClient = createWalletClient({
	chain: baseSepolia,
	transport: http(chainConfig.rpcUrl),
	account,
});

const publicClient = createPublicClient({
	chain: baseSepolia,
	transport: http(chainConfig.rpcUrl),
});

async function main() {
	console.log("=== Simple x402 Client ===\n");
	console.log(`  Wallet:  ${account.address}`);
	console.log(`  Seller:  ${SELLER_URL}\n`);

	// Check USDC balance
	const balance = await publicClient.readContract({
		address: chainConfig.usdcAddress,
		abi: USDC_ABI,
		functionName: "balanceOf",
		args: [account.address],
	});
	console.log(`  Balance: ${formatUnits(balance, 6)} USDC\n`);

	if (balance === 0n) {
		console.error(
			"ERROR: Your wallet has 0 USDC. Get testnet USDC from https://faucet.circle.com/",
		);
		process.exit(1);
	}

	// -----------------------------------------------------------------------
	// Step 1: Discover agent card
	// -----------------------------------------------------------------------
	console.log("1. Discovering agent card...");
	const cardRes = await fetch(`${SELLER_URL}/.well-known/agent.json`);
	if (!cardRes.ok) {
		console.error(`   Failed: ${cardRes.status}`);
		process.exit(1);
	}

	const card: AgentCard = await cardRes.json();
	console.log(`   Agent: ${card.name}`);
	console.log(`   Skills: ${card.skills.map((s) => s.id).join(", ")}`);

	// Pick the first skill/tier
	const skill = card.skills[0];
	const pricing = skill.pricing?.[0];
	if (!pricing) {
		console.error("   No pricing found");
		process.exit(1);
	}
	console.log(`   Using: ${pricing.label} — ${pricing.amount} USDC\n`);

	// -----------------------------------------------------------------------
	// Step 2: Request access (initial call → HTTP 402)
	// -----------------------------------------------------------------------
	console.log("2. Requesting access (expecting HTTP 402)...");
	const requestId = crypto.randomUUID();
	const accessEndpoint = `${SELLER_URL}/a2a/access`;

	const initialRes = await fetch(accessEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tier: pricing.tierId,
			requestId,
			resource: "photo-1",
		}),
	});

	console.log(`   Status: ${initialRes.status} ${initialRes.statusText}`);

	if (initialRes.status !== 402) {
		console.error("   Expected HTTP 402, got:", await initialRes.text());
		process.exit(1);
	}

	// Decode PAYMENT-REQUIRED header
	const paymentRequiredHeader = initialRes.headers.get("payment-required");
	if (!paymentRequiredHeader) {
		console.error("   Missing PAYMENT-REQUIRED header");
		process.exit(1);
	}

	const paymentRequired = JSON.parse(
		Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"),
	);
	console.log("   Payment required:");
	console.log(`     Asset:  ${paymentRequired.accepts[0].asset}`);
	console.log(`     Amount: ${paymentRequired.accepts[0].amount} (${pricing.amount})`);
	console.log(`     PayTo:  ${paymentRequired.accepts[0].payTo}\n`);

	// -----------------------------------------------------------------------
	// Step 3: Pay USDC on-chain
	// -----------------------------------------------------------------------
	console.log("3. Paying USDC on-chain...");
	const amountRaw = parseDollarToUsdcMicro(pricing.amount);
	console.log(
		`   Sending ${pricing.amount} (${amountRaw} micro-units) to ${paymentRequired.accepts[0].payTo}`,
	);

	const txHash = await walletClient.writeContract({
		address: chainConfig.usdcAddress,
		abi: USDC_ABI,
		functionName: "transfer",
		args: [paymentRequired.accepts[0].payTo as `0x${string}`, amountRaw],
	});
	console.log(`   TX: ${txHash}`);
	console.log(`   Explorer: ${chainConfig.explorerBaseUrl}/tx/${txHash}`);
	console.log("   Waiting for confirmation...");

	const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
	console.log(`   Confirmed in block ${receipt.blockNumber}\n`);

	// -----------------------------------------------------------------------
	// Step 4: Retry with payment signature (HTTP 200)
	// -----------------------------------------------------------------------
	console.log("4. Retrying with payment proof...");

	// Build x402 payment payload
	const paymentPayload = {
		x402Version: 2,
		network: `eip155:${chainConfig.chainId}`,
		scheme: "exact",
		payload: {
			txHash,
			amount: paymentRequired.accepts[0].amount,
			asset: "USDC",
			from: account.address,
		},
		accepted: paymentRequired.accepts[0],
	};

	const paymentSignatureHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

	const finalRes = await fetch(accessEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"PAYMENT-SIGNATURE": paymentSignatureHeader,
		},
		body: JSON.stringify({
			tier: pricing.tierId,
			requestId,
			resource: "photo-1",
		}),
	});

	console.log(`   Status: ${finalRes.status} ${finalRes.statusText}`);

	if (!finalRes.ok) {
		console.error("   Error:", await finalRes.text());
		process.exit(1);
	}

	const grant: AccessGrant = await finalRes.json();
	console.log("   Access granted!");
	console.log(`     Token:     ${grant.accessToken.substring(0, 20)}...`);
	console.log(`     Expires:   ${grant.expiresAt}`);
	console.log(`     Resource:  ${grant.resourceEndpoint}`);
	console.log(`     TX:        ${grant.explorerUrl}\n`);

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
		console.error(`   Error: ${await apiRes.text()}\n`);
	}

	console.log("=== Flow complete ===");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
