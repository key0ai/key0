import { createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  publicClient,
  config,
  USDC_ABI,
  USDC_DECIMALS,
  assertPrivateKey,
  assertAddress,
  assertPositiveAmount,
} from "./_shared";

export type SendResult = {
  txHash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: string;
  blockNumber: bigint;
  gasUsed: bigint;
  network: string;
  explorerUrl: string;
};

/**
 * Sends USDC from one wallet to another via a direct ERC-20 transfer.
 * Network is determined by the NETWORK env var (testnet | mainnet).
 *
 * @param fromKey  - Private key of the sending wallet.
 * @param toAddress - Recipient EVM address.
 * @param amount   - Human-readable USDC amount, e.g. "1" for $1.00.
 * @throws If inputs are invalid, balance is insufficient, or the tx fails.
 *
 * @example
 * const result = await sendMoney("0xabc...", "0xdef...", "1");
 * console.log(result.txHash);      // 0x...
 * console.log(result.explorerUrl); // https://basescan.org/tx/...
 */
export default async function sendMoney(
  fromKey: string,
  toAddress: string,
  amount: string,
): Promise<SendResult> {
  assertPrivateKey(fromKey, "fromKey");
  assertAddress(toAddress, "toAddress");
  assertPositiveAmount(amount, "amount");

  const account = privateKeyToAccount(fromKey as `0x${string}`);
  const amountInUnits = parseUnits(amount, USDC_DECIMALS);

  // Guard: check USDC balance
  const balance = await publicClient.readContract({
    address: config.usdc,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  if (balance < amountInUnits) {
    throw new Error(
      `Insufficient USDC balance. Have ${formatUnits(balance, USDC_DECIMALS)}, need ${amount}.`,
    );
  }

  // Guard: check ETH balance for gas
  const ethBalance = await publicClient.getBalance({ address: account.address });
  if (ethBalance === 0n) {
    throw new Error("Sender has no ETH for gas fees.");
  }

  const walletClient = createWalletClient({
    account,
    chain: config.chain,
    transport: http(config.rpc),
  });

  const txHash = await walletClient.writeContract({
    address: config.usdc,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [toAddress as `0x${string}`, amountInUnits],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "reverted") {
    throw new Error(`Transaction reverted. tx: ${config.explorer}/tx/${txHash}`);
  }

  return {
    txHash,
    from: account.address,
    to: toAddress as `0x${string}`,
    amount,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    network: config.label,
    explorerUrl: `${config.explorer}/tx/${txHash}`,
  };
}
