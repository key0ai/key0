import { describe, expect, test } from "bun:test";
import { CHAIN_CONFIGS } from "../chain-config.js";

describe("CHAIN_CONFIGS", () => {
  test("testnet has correct chainId", () => {
    expect(CHAIN_CONFIGS.testnet.chainId).toBe(84532);
  });

  test("mainnet has correct chainId", () => {
    expect(CHAIN_CONFIGS.mainnet.chainId).toBe(8453);
  });

  test("testnet has Base Sepolia RPC", () => {
    expect(CHAIN_CONFIGS.testnet.rpcUrl).toBe("https://sepolia.base.org");
  });

  test("mainnet has Base RPC", () => {
    expect(CHAIN_CONFIGS.mainnet.rpcUrl).toBe("https://mainnet.base.org");
  });

  test("testnet USDC address is correct", () => {
    expect(CHAIN_CONFIGS.testnet.usdcAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  test("mainnet USDC address is correct", () => {
    expect(CHAIN_CONFIGS.mainnet.usdcAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("testnet explorer URL", () => {
    expect(CHAIN_CONFIGS.testnet.explorerBaseUrl).toBe("https://sepolia.basescan.org");
  });

  test("mainnet explorer URL", () => {
    expect(CHAIN_CONFIGS.mainnet.explorerBaseUrl).toBe("https://basescan.org");
  });
});
