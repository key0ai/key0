/**
 * Client agent demonstrating the full Key0 x402 payment flow on Base Sepolia testnet:
 *
 *   1. Discover the seller's agent card
 *   2. Discover available plans (GET /discovery → 200)
 *   3. Request a challenge    (POST /x402/access with { planId } → 402 Challenge)
 *   4. Sign EIP-3009 authorization off-chain
 *   5. Submit payment         (POST /x402/access with { planId } + PAYMENT-SIGNATURE → 200 Grant)
 *   6. Use the access token to call the protected API
 *
 * Prerequisites:
 *   - Copy .env.example to .env and add your private key
 *   - Your wallet needs testnet USDC on Base Sepolia (get from https://faucet.circle.com/)
 *   - Start the seller: cd ../express-seller && bun run start
 *
 * Usage:
 *   bun run start
 */

import type { AccessGrant, AgentCard, NetworkName } from "@key0ai/key0";
import { CHAIN_CONFIGS } from "@key0ai/key0";
import { createPublicClient, createWalletClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const SELLER_URL = process.env["SELLER_URL"] ?? "http://localhost:3000";
const PRIVATE_KEY = process.env["WALLET_PRIVATE_KEY"] as `0x${string}` | undefined;
const NETWORK = (process.env["KEY0_NETWORK"] ?? "testnet") as NetworkName;

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
		abi: [
			{
				name: "balanceOf",
				type: "function",
				stateMutability: "view",
				inputs: [{ name: "account", type: "address" }],
				outputs: [{ name: "", type: "uint256" }],
			},
		] as const,
		functionName: "balanceOf",
		args: [address],
	});
	return formatUnits(raw, 6);
}

/**
 * Sign an EIP-3009 transferWithAuthorization off-chain.
 * Returns the authorization struct + signature for the PAYMENT-SIGNATURE header.
 */
async function signEIP3009(params: {
	to: `0x${string}`;
	value: bigint;
	validAfter?: bigint;
	validBefore?: bigint;
}): Promise<{
	authorization: Record<string, string>;
	signature: `0x${string}`;
}> {
	const now = BigInt(Math.floor(Date.now() / 1000));
	const validAfter = params.validAfter ?? now - 60n;
	const validBefore = params.validBefore ?? now + 900n; // 15 min

	// Random nonce for EIP-3009
	const nonceBytes = new Uint8Array(32);
	crypto.getRandomValues(nonceBytes);
	const nonce = `0x${Array.from(nonceBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}` as `0x${string}`;

	const domain = {
		name: chainConfig.usdcDomain.name,
		version: chainConfig.usdcDomain.version,
		chainId: BigInt(chainConfig.chainId),
		verifyingContract: chainConfig.usdcAddress,
	};

	const types = {
		TransferWithAuthorization: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
		],
	};

	const message = {
		from: account.address,
		to: params.to,
		value: params.value,
		validAfter,
		validBefore,
		nonce,
	};

	const signature = await walletClient.signTypedData({
		domain,
		types,
		primaryType: "TransferWithAuthorization",
		message,
	});

	return {
		authorization: {
			from: account.address,
			to: params.to,
			value: params.value.toString(),
			validAfter: validAfter.toString(),
			validBefore: validBefore.toString(),
			nonce,
		},
		signature,
	};
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Key0 Client Agent (x402 HTTP flow) ===\n");
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

	const X402_ENDPOINT = `${SELLER_URL}/x402/access`;

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
	console.log(`   Skills: ${card.skills.map((s) => s.id).join(", ")}\n`);

	// -----------------------------------------------------------------------
	// Step 2: Discover available plans via GET /discovery
	// -----------------------------------------------------------------------
	console.log("2. Discovering plans...");
	const discoveryRes = await fetch(`${SELLER_URL}/discovery`);

	if (discoveryRes.status !== 200) {
		console.error(`   Expected HTTP 200 for discovery, got ${discoveryRes.status}`);
		process.exit(1);
	}

	const { discoveryResponse } = (await discoveryRes.json()) as {
		discoveryResponse: {
			accepts: Array<{ amount: string; payTo: string; extra?: Record<string, string> }>;
		};
	};
	if (!discoveryResponse.accepts || discoveryResponse.accepts.length === 0) {
		console.error("   No plans found in discovery response");
		process.exit(1);
	}

	// Pick the first tier
	const tierInfo = discoveryResponse.accepts[0]!;
	const planId = tierInfo.extra?.["planId"] ?? "default";
	const tierDescription = tierInfo.extra?.["description"] ?? tierInfo.amount;

	console.log(`   Available plans: ${discoveryResponse.accepts.length}`);
	console.log(`   Using: ${planId} — ${tierDescription}\n`);

	// -----------------------------------------------------------------------
	// Step 3: Request challenge (POST /x402/access with { planId } → 402)
	// -----------------------------------------------------------------------
	console.log("3. Requesting payment challenge...");
	const requestId = crypto.randomUUID();

	const challengeRes = await fetch(X402_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ planId, requestId, resourceId: "photo-1" }),
	});

	if (challengeRes.status !== 402) {
		console.error(`   Expected HTTP 402 for challenge, got ${challengeRes.status}`);
		const errBody = await challengeRes.json().catch(() => null);
		console.error("   Response:", JSON.stringify(errBody));
		process.exit(1);
	}

	// Decode payment requirements from header
	const paymentRequiredHeader = challengeRes.headers.get("payment-required");
	if (!paymentRequiredHeader) {
		console.error("   Missing payment-required header");
		process.exit(1);
	}

	const challengeBody = (await challengeRes.json()) as {
		challengeId: string;
		accepts: Array<{
			amount: string;
			payTo: string;
			maxTimeoutSeconds: number;
			extra?: Record<string, string>;
		}>;
	};
	const challengeId = challengeBody.challengeId;
	const requirements = challengeBody.accepts[0]!;

	console.log(`   Challenge ID: ${challengeId}`);
	console.log(`   Amount: ${requirements.amount} USDC (micro-units)`);
	console.log(`   Pay to: ${requirements.payTo}`);
	console.log(`   Timeout: ${requirements.maxTimeoutSeconds}s\n`);

	// -----------------------------------------------------------------------
	// Step 4: Sign EIP-3009 authorization off-chain (no on-chain TX needed!)
	// -----------------------------------------------------------------------
	console.log("4. Signing EIP-3009 authorization...");
	const { authorization, signature } = await signEIP3009({
		to: requirements.payTo as `0x${string}`,
		value: BigInt(requirements.amount),
	});
	console.log(`   Authorization signed by ${account.address}`);
	console.log(`   Signature: ${signature.slice(0, 20)}...\n`);

	// -----------------------------------------------------------------------
	// Step 5: Submit payment (POST /x402/access with PAYMENT-SIGNATURE → 200)
	// -----------------------------------------------------------------------
	console.log("5. Submitting payment...");

	// Build the PAYMENT-SIGNATURE payload per x402 spec
	const paymentPayload = {
		x402Version: 2,
		network: `eip155:${chainConfig.chainId}`,
		scheme: "exact",
		payload: {
			signature,
			authorization,
			from: account.address,
		},
		accepted: {
			...requirements,
			extra: {
				...requirements.extra,
				planId,
			},
		},
	};
	const paymentSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

	const settleRes = await fetch(X402_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"payment-signature": paymentSignature,
		},
		body: JSON.stringify({ planId, requestId, resourceId: "photo-1" }),
	});

	if (settleRes.status !== 200) {
		console.error(`   Settlement failed with status ${settleRes.status}`);
		const errBody = await settleRes.json().catch(() => null);
		console.error("   Response:", JSON.stringify(errBody));
		process.exit(1);
	}

	const grant: AccessGrant = await settleRes.json();
	console.log("   Access granted!");
	console.log(`   Token type: ${grant.tokenType}`);
	console.log(`   Expires: ${grant.expiresAt}`);
	console.log(`   Resource: ${grant.resourceEndpoint}`);
	console.log(`   TX: ${grant.explorerUrl}\n`);

	// -----------------------------------------------------------------------
	// Step 6: Use the access token
	// -----------------------------------------------------------------------
	console.log("6. Calling protected API...");
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
