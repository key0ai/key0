/**
 * _shared.ts — internal config for x402-utils.
 *
 * Reads NETWORK from .env and exports the correct chain, RPC,
 * USDC address, facilitator URL, and publicClient for that network.
 *
 * NETWORK=testnet  →  Base Sepolia  (default, safe for development)
 * NETWORK=mainnet  →  Base          (real money — use carefully)
 */

import { createPublicClient, http, isAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

// ─── Network configs ──────────────────────────────────────────────────────────

const CONFIGS = {
  testnet: {
    chain: baseSepolia,
    rpc: "https://sepolia.base.org",
    network: "eip155:84532" as const,
    facilitator: "https://x402.org/facilitator",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
    explorer: "https://sepolia.basescan.org",
    label: "Base Sepolia (testnet)",
  },
  mainnet: {
    chain: base,
    rpc: "https://mainnet.base.org",
    network: "eip155:8453" as const,
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
    explorer: "https://basescan.org",
    label: "Base (mainnet)",
  },
} as const;

export type NetworkName = keyof typeof CONFIGS;

function resolveNetwork(): NetworkName {
  const raw = process.env.NETWORK?.trim().toLowerCase();
  if (raw === "mainnet") return "mainnet";
  if (raw === "testnet" || raw === undefined || raw === "") return "testnet";
  throw new Error(`Invalid NETWORK value "${process.env.NETWORK}". Must be "testnet" or "mainnet".`);
}

export const NETWORK_NAME: NetworkName = resolveNetwork();
export const config = CONFIGS[NETWORK_NAME];

// ─── USDC ─────────────────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;

export const USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// ─── Shared public client ─────────────────────────────────────────────────────

export const publicClient = createPublicClient({
  chain: config.chain,
  transport: http(config.rpc),
});

// ─── Validation helpers ───────────────────────────────────────────────────────

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function assertPrivateKey(key: string, label = "privateKey"): asserts key is `0x${string}` {
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new Error(`${label} must be a 0x-prefixed 64-character hex string.`);
  }
}

export function assertAddress(addr: string, label = "address"): asserts addr is `0x${string}` {
  if (!isAddress(addr)) {
    throw new Error(`${label} is not a valid EVM address: "${addr}"`);
  }
}

export function assertPositiveAmount(amount: string, label = "amount"): void {
  const n = Number(amount);
  if (isNaN(n) || n <= 0) {
    throw new Error(`${label} must be a positive number, got "${amount}"`);
  }
}

/** Parses an x402 dollar amount string like "$0.01" or "0.01". */
export function parseDollarAmount(amount: string): string {
  const stripped = amount.startsWith("$") ? amount.slice(1) : amount;
  assertPositiveAmount(stripped, "amount");
  return `$${stripped}`;
}
