import { formatUnits } from "viem";
import { publicClient, config, USDC_ABI, USDC_DECIMALS, assertAddress } from "./_shared";

export type Balance = {
  raw: bigint;       // on-chain units (e.g. 1_000_000n = $1.00 USDC)
  formatted: string; // human-readable  (e.g. "1")
  network: string;   // which network this balance is from
};

/**
 * Returns the USDC balance of an address.
 * Network is determined by the NETWORK env var (testnet | mainnet).
 *
 * @param address - A valid EVM address.
 * @throws If the address is invalid or the RPC call fails.
 *
 * @example
 * const balance = await getBalance("0xabc...");
 * console.log(balance.formatted); // "10.5"
 * console.log(balance.network);   // "Base Sepolia (testnet)"
 */
export default async function getBalance(address: string): Promise<Balance> {
  assertAddress(address, "address");

  const raw = await publicClient.readContract({
    address: config.usdc,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });

  return {
    raw,
    formatted: formatUnits(raw, USDC_DECIMALS),
    network: config.label,
  };
}
