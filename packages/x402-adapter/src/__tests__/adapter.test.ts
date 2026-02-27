import { describe, expect, test } from "bun:test";
import type { IssueChallengeParams, VerifyProofParams } from "@agentgate/types";
import { X402Adapter } from "../adapter.js";
import { CHAIN_CONFIGS } from "../chain-config.js";

describe("X402Adapter", () => {
  test("protocol is x402", () => {
    const adapter = new X402Adapter({ network: "testnet" });
    expect(adapter.protocol).toBe("x402");
  });

  test("getNetworkConfig returns testnet config", () => {
    const adapter = new X402Adapter({ network: "testnet" });
    const config = adapter.getNetworkConfig();
    expect(config.chainId).toBe(84532);
    expect(config.name).toBe("testnet");
  });

  test("getNetworkConfig returns mainnet config", () => {
    const adapter = new X402Adapter({ network: "mainnet" });
    const config = adapter.getNetworkConfig();
    expect(config.chainId).toBe(8453);
    expect(config.name).toBe("mainnet");
  });

  test("custom rpcUrl overrides default", () => {
    const adapter = new X402Adapter({
      network: "testnet",
      rpcUrl: "https://custom-rpc.example.com",
    });
    const config = adapter.getNetworkConfig();
    expect(config.rpcUrl).toBe("https://custom-rpc.example.com");
  });

  test("issueChallenge returns valid payload", async () => {
    const adapter = new X402Adapter({ network: "testnet" });
    const expiresAt = new Date(Date.now() + 900_000);
    const params: IssueChallengeParams = {
      requestId: crypto.randomUUID(),
      resourceId: "photo-42",
      tierId: "single",
      amount: "$0.10",
      destination: `0x${"ab".repeat(20)}` as `0x${string}`,
      expiresAt,
      metadata: {},
    };

    const payload = await adapter.issueChallenge(params);
    expect(payload.challengeId).toBeTypeOf("string");
    expect(payload.challengeId.length).toBeGreaterThan(0);
    expect(payload.protocol).toBe("x402");
    expect(payload.expiresAt).toBe(expiresAt);
    expect((payload.raw as Record<string, unknown>)["chainId"]).toBe(84532);
    expect((payload.raw as Record<string, unknown>)["asset"]).toBe("USDC");
  });

  test("verifyProof returns CHAIN_MISMATCH for wrong chain", async () => {
    const adapter = new X402Adapter({ network: "testnet" });
    const params: VerifyProofParams = {
      challengeId: crypto.randomUUID(),
      proof: {
        txHash: `0x${"aa".repeat(32)}` as `0x${string}`,
        chainId: 8453, // mainnet, but adapter is testnet
        amount: "$0.10",
        asset: "USDC",
      },
      expected: {
        destination: `0x${"ab".repeat(20)}` as `0x${string}`,
        amountRaw: 100000n,
        chainId: 84532,
        expiresAt: new Date(Date.now() + 900_000),
      },
    };

    const result = await adapter.verifyProof(params);
    expect(result.verified).toBe(false);
    expect(result.errorCode).toBe("CHAIN_MISMATCH");
  });
});
