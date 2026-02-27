import { decodeEventLog, type PublicClient } from "viem";
import type { NetworkConfig, VerificationResult } from "@agentgate/types";
import { USDC_ABI, USDC_TRANSFER_EVENT_SIGNATURE } from "./usdc.js";

export type VerifyTransferParams = {
  readonly txHash: `0x${string}`;
  readonly expectedTo: `0x${string}`;
  readonly expectedAmountRaw: bigint;
  readonly expectedChainId: number;
  readonly challengeExpiresAt: Date;
  readonly networkConfig: NetworkConfig;
  readonly client: PublicClient;
};

export async function verifyTransfer(
  params: VerifyTransferParams,
): Promise<VerificationResult> {
  const {
    txHash,
    expectedTo,
    expectedAmountRaw,
    challengeExpiresAt,
    networkConfig,
    client,
  } = params;

  // 1. Fetch transaction receipt
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Distinguish "tx not found" (pending/doesn't exist) from RPC errors
    if (message.includes("could not be found") || message.includes("not found")) {
      return {
        verified: false,
        error: "Transaction not found. It may be pending or the hash is invalid.",
        errorCode: "TX_NOT_FOUND",
      };
    }
    return {
      verified: false,
      error: `RPC error: ${message}`,
      errorCode: "RPC_ERROR",
    };
  }

  // 2. Check receipt status
  if (receipt.status === "reverted") {
    return {
      verified: false,
      txHash,
      error: "Transaction reverted on-chain.",
      errorCode: "TX_REVERTED",
    };
  }

  // 3. Find USDC Transfer event(s) to the expected destination
  const usdcAddress = networkConfig.usdcAddress.toLowerCase();
  let totalTransferred = 0n;
  const blockNumber = receipt.blockNumber;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress) continue;
    if (log.topics[0] !== USDC_TRANSFER_EVENT_SIGNATURE) continue;

    try {
      const decoded = decodeEventLog({
        abi: USDC_ABI,
        data: log.data,
        topics: log.topics as [typeof USDC_TRANSFER_EVENT_SIGNATURE, ...`0x${string}`[]],
      });

      if (decoded.eventName !== "Transfer") continue;

      const to = (decoded.args as { to: string }).to.toLowerCase();
      const value = (decoded.args as { value: bigint }).value;

      if (to === expectedTo.toLowerCase()) {
        totalTransferred += value;
      }
    } catch {
      // Skip logs that don't decode as Transfer
      continue;
    }
  }

  // 4. Check any transfer was found
  if (totalTransferred === 0n) {
    return {
      verified: false,
      txHash,
      blockNumber,
      error: `No USDC transfer to ${expectedTo} found in transaction.`,
      errorCode: "WRONG_RECIPIENT",
    };
  }

  // 5. Check amount
  if (totalTransferred < expectedAmountRaw) {
    return {
      verified: false,
      txHash,
      confirmedAmount: totalTransferred,
      blockNumber,
      error: `Transferred ${totalTransferred} but expected >= ${expectedAmountRaw} USDC micro-units.`,
      errorCode: "AMOUNT_INSUFFICIENT",
    };
  }

  // 6. Check block timestamp vs challenge expiry
  const block = await client.getBlock({ blockNumber });
  const blockTime = new Date(Number(block.timestamp) * 1000);
  if (blockTime > challengeExpiresAt) {
    return {
      verified: false,
      txHash,
      confirmedAmount: totalTransferred,
      confirmedAt: blockTime,
      blockNumber,
      error: "Payment transaction was mined after the challenge expired.",
      errorCode: "TX_AFTER_EXPIRY",
    };
  }

  // 7. Success
  return {
    verified: true,
    txHash,
    confirmedAmount: totalTransferred,
    confirmedChainId: networkConfig.chainId,
    confirmedAt: blockTime,
    blockNumber,
  };
}
