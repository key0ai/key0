import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { NetworkConfig } from "../types/index.js";
import { USDC_ABI } from "./usdc.js";

export type SendUsdcParams = {
	readonly to: `0x${string}`;
	readonly amountRaw: bigint;
	readonly privateKey: `0x${string}`;
	readonly networkConfig: NetworkConfig;
};

/**
 * Send USDC on-chain using a seller's private key.
 * Waits for transaction confirmation before returning.
 * Used internally by processRefunds to return funds to payers.
 */
export async function sendUsdc(params: SendUsdcParams): Promise<`0x${string}`> {
	const { to, amountRaw, privateKey, networkConfig } = params;

	const account = privateKeyToAccount(privateKey);
	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;

	const walletClient = createWalletClient({
		account,
		chain,
		transport: http(networkConfig.rpcUrl),
	});

	const publicClient = createPublicClient({
		chain,
		transport: http(networkConfig.rpcUrl),
	});

	const txHash = await walletClient.writeContract({
		account,
		address: networkConfig.usdcAddress,
		abi: USDC_ABI,
		functionName: "transfer",
		args: [to, amountRaw],
	});

	const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

	if (receipt.status !== "success") {
		throw new Error(`Refund transaction reverted: ${txHash}`);
	}

	return txHash;
}
