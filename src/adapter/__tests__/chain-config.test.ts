import { describe, expect, test } from "bun:test";
import { CHAIN_CONFIGS } from "../chain-config.js";

describe("CHAIN_CONFIGS", () => {
	test("testnet config matches Base Sepolia", () => {
		expect(CHAIN_CONFIGS.testnet).toEqual({
			name: "testnet",
			chainId: 84532,
			rpcUrl: "https://sepolia.base.org",
			usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			usdcDomain: { name: "USDC", version: "2" },
			explorerBaseUrl: "https://sepolia.basescan.org",
			facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
		});
	});

	test("mainnet config matches Base", () => {
		expect(CHAIN_CONFIGS.mainnet).toEqual({
			name: "mainnet",
			chainId: 8453,
			rpcUrl: "https://mainnet.base.org",
			usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			usdcDomain: { name: "USDC", version: "2" },
			explorerBaseUrl: "https://basescan.org",
			facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
		});
	});
});
