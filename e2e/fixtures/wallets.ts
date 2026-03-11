/**
 * Load test wallets from environment variables and create viem clients.
 */

import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { E2eTestClient } from "../helpers/client.ts";
import { KEY0_URL, CHAIN_ID, USDC_ADDRESS, USDC_DOMAIN } from "./constants.ts";

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`Missing required env var: ${name}`);
	return val;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name];
}

/** Primary test wallet (CLIENT) — signs EIP-3009 authorizations / sends payments */
export function makeClientWallet() {
	const privateKey = requireEnv("CLIENT_WALLET_PRIVATE_KEY") as `0x${string}`;
	const rpcUrl = optionalEnv("ALCHEMY_BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";

	const account = privateKeyToAccount(privateKey);
	const transport = http(rpcUrl);

	const walletClient = createWalletClient({ chain: baseSepolia, transport, account });
	const publicClient = createPublicClient({ chain: baseSepolia, transport });

	return { account, walletClient, publicClient };
}

/** Secondary wallet (GAS) — second concurrent buyer in concurrent-purchases.test.ts */
export function makeGasWallet() {
	const privateKey = requireEnv("GAS_WALLET_PRIVATE_KEY") as `0x${string}`;
	const rpcUrl = optionalEnv("ALCHEMY_BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";

	const account = privateKeyToAccount(privateKey);
	const transport = http(rpcUrl);

	const walletClient = createWalletClient({ chain: baseSepolia, transport, account });
	const publicClient = createPublicClient({ chain: baseSepolia, transport });

	return { account, walletClient, publicClient };
}

/** Create an E2eTestClient for the primary CLIENT wallet. */
export function makeClientE2eClient(key0Url = KEY0_URL): E2eTestClient {
	const { walletClient, publicClient } = makeClientWallet();
	return new E2eTestClient(
		key0Url,
		walletClient,
		publicClient as unknown as PublicClient,
		USDC_ADDRESS,
		CHAIN_ID,
		USDC_DOMAIN,
	);
}

/** Create an E2eTestClient for the GAS wallet (secondary buyer). */
export function makeGasE2eClient(key0Url = KEY0_URL): E2eTestClient {
	const { walletClient, publicClient } = makeGasWallet();
	return new E2eTestClient(
		key0Url,
		walletClient,
		publicClient as unknown as PublicClient,
		USDC_ADDRESS,
		CHAIN_ID,
		USDC_DOMAIN,
	);
}

/** KEY0_WALLET_ADDRESS — for assertions (e.g. destination address in challenges). */
export function key0WalletAddress(): `0x${string}` {
	return requireEnv("KEY0_WALLET_ADDRESS") as `0x${string}`;
}

/** CLIENT_WALLET_ADDRESS — for assertions (e.g. refund recipient). */
export function clientWalletAddress(): `0x${string}` {
	return requireEnv("CLIENT_WALLET_ADDRESS") as `0x${string}`;
}
