import { decodeEventLog, formatUnits } from "viem";
import { publicClient, config, USDC_ABI, USDC_DECIMALS } from "./_shared";

export type TransferDetail = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  formatted: string;
};

export type VerifyResult = {
  status: "success" | "reverted";
  txHash: `0x${string}`;
  blockNumber: bigint;
  gasUsed: bigint;
  transfer: TransferDetail | null;
  network: string;
  explorerUrl: string;
};

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Waits for a transaction to be confirmed on-chain, then decodes the USDC
 * Transfer event from its logs and returns structured verification data.
 * Network is determined by the NETWORK env var (testnet | mainnet).
 *
 * @param txHash - A 0x-prefixed 64-character transaction hash.
 * @throws If the tx hash format is invalid.
 *
 * @example
 * const result = await verifyTransaction("0xabc...");
 * console.log(result.status);            // "success"
 * console.log(result.transfer?.formatted); // "1 USDC"
 */
export default async function verifyTransaction(txHash: string): Promise<VerifyResult> {
  if (!TX_HASH_RE.test(txHash)) {
    throw new Error(`Invalid transaction hash: "${txHash}"`);
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  const usdcLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === config.usdc.toLowerCase(),
  );

  let transfer: TransferDetail | null = null;

  if (usdcLog) {
    try {
      const decoded = decodeEventLog({
        abi: USDC_ABI,
        data: usdcLog.data,
        topics: usdcLog.topics,
        eventName: "Transfer",
      });

      transfer = {
        from: decoded.args.from,
        to: decoded.args.to,
        value: decoded.args.value,
        formatted: `${formatUnits(decoded.args.value, USDC_DECIMALS)} USDC`,
      };
    } catch {
      // Log found but couldn't decode — non-fatal, return null transfer
    }
  }

  return {
    status: receipt.status,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    transfer,
    network: config.label,
    explorerUrl: `${config.explorer}/tx/${txHash}`,
  };
}
