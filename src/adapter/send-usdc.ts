import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { NetworkConfig } from "../types/index.js";
import { USDC_ABI } from "./usdc.js";

export type SendUsdcParams = {
	readonly to: `0x${string}`;
	readonly amountRaw: bigint;
	/** Private key of the account that owns the USDC. */
	readonly privateKey: `0x${string}`;
	/**
	 * Optional gas wallet private key. When provided, the USDC owner signs an
	 * EIP-3009 transferWithAuthorization off-chain, and the gas wallet submits
	 * the transaction on-chain (paying gas). This avoids needing ETH in the
	 * USDC-holding wallet.
	 */
	readonly gasWalletPrivateKey?: `0x${string}`;
	readonly networkConfig: NetworkConfig;
};

/**
 * Send USDC on-chain, optionally using a separate gas wallet via EIP-3009.
 * Waits for transaction confirmation before returning.
 * Used internally by processRefunds to return funds to payers.
 */
export async function sendUsdc(params: SendUsdcParams): Promise<`0x${string}`> {
	const { to, amountRaw, privateKey, gasWalletPrivateKey, networkConfig } = params;

	const usdcOwnerAccount = privateKeyToAccount(privateKey);
	const chain = networkConfig.chainId === 8453 ? base : baseSepolia;

	const publicClient = createPublicClient({
		chain,
		transport: http(networkConfig.rpcUrl),
	});

	if (gasWalletPrivateKey) {
		// EIP-3009: USDC owner signs off-chain, gas wallet submits on-chain
		const gasAccount = privateKeyToAccount(gasWalletPrivateKey);
		const gasWalletClient = createWalletClient({
			account: gasAccount,
			chain,
			transport: http(networkConfig.rpcUrl),
		});

		// Build EIP-3009 typed data
		const validAfter = 0n;
		const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
		const nonce =
			`0x${crypto.getRandomValues(new Uint8Array(32)).reduce((hex, b) => hex + b.toString(16).padStart(2, "0"), "")}` as `0x${string}`;

		const domain = {
			name: networkConfig.usdcDomain.name,
			version: networkConfig.usdcDomain.version,
			chainId: networkConfig.chainId,
			verifyingContract: networkConfig.usdcAddress,
		} as const;

		const types = {
			TransferWithAuthorization: [
				{ name: "from", type: "address" },
				{ name: "to", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "validAfter", type: "uint256" },
				{ name: "validBefore", type: "uint256" },
				{ name: "nonce", type: "bytes32" },
			],
		} as const;

		const message = {
			from: usdcOwnerAccount.address,
			to,
			value: amountRaw,
			validAfter,
			validBefore,
			nonce,
		};

		// USDC owner signs off-chain — no RPC needed, pure local signing
		const signature = await usdcOwnerAccount.signTypedData({
			domain,
			types,
			primaryType: "TransferWithAuthorization",
			message,
		});

		// Parse the signature into v, r, s
		const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
		const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
		const v = Number(`0x${signature.slice(130, 132)}`);

		// Gas wallet submits on-chain
		const txHash = await gasWalletClient.writeContract({
			account: gasAccount,
			address: networkConfig.usdcAddress,
			abi: USDC_ABI,
			functionName: "transferWithAuthorization",
			args: [usdcOwnerAccount.address, to, amountRaw, validAfter, validBefore, nonce, v, r, s],
		});

		const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

		if (receipt.status !== "success") {
			throw new Error(`Refund transaction reverted: ${txHash}`);
		}

		return txHash;
	}

	// Fallback: direct transfer (USDC owner pays gas)
	const walletClient = createWalletClient({
		account: usdcOwnerAccount,
		chain,
		transport: http(networkConfig.rpcUrl),
	});

	const txHash = await walletClient.writeContract({
		account: usdcOwnerAccount,
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
