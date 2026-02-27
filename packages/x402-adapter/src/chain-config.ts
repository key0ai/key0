import type { NetworkConfig, NetworkName } from "@agentgate/types";

export const CHAIN_CONFIGS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    facilitatorUrl: "https://x402.org/facilitator",
    explorerBaseUrl: "https://sepolia.basescan.org",
  },
  mainnet: {
    name: "mainnet",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
    explorerBaseUrl: "https://basescan.org",
  },
} as const;
