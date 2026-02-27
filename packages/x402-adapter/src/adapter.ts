import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type {
  ChallengePayload,
  IPaymentAdapter,
  IssueChallengeParams,
  NetworkConfig,
  NetworkName,
  VerificationResult,
  VerifyProofParams,
} from "@agentgate/types";
import { CHAIN_CONFIGS } from "./chain-config.js";
import { verifyTransfer } from "./verify-transfer.js";

export type X402AdapterConfig = {
  readonly network: NetworkName;
  readonly rpcUrl?: string | undefined; // override default RPC
};

export class X402Adapter implements IPaymentAdapter {
  readonly protocol = "x402" as const;
  private readonly networkConfig: NetworkConfig;
  private readonly client: PublicClient;

  constructor(config: X402AdapterConfig) {
    this.networkConfig = {
      ...CHAIN_CONFIGS[config.network],
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    };

    const chain = config.network === "mainnet" ? base : baseSepolia;
    this.client = createPublicClient({
      chain,
      transport: http(this.networkConfig.rpcUrl),
    }) as PublicClient;
  }

  async issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload> {
    // x402 challenge issuance is purely local — no on-chain call needed.
    const challengeId = crypto.randomUUID();

    return {
      challengeId,
      protocol: this.protocol,
      raw: {
        type: "X402Challenge",
        chainId: this.networkConfig.chainId,
        asset: "USDC",
        usdcAddress: this.networkConfig.usdcAddress,
        facilitatorUrl: this.networkConfig.facilitatorUrl,
      },
      expiresAt: params.expiresAt,
    };
  }

  async verifyProof(params: VerifyProofParams): Promise<VerificationResult> {
    const { proof, expected } = params;

    // Chain mismatch is caught at the engine level, but double-check here
    if (proof.chainId !== expected.chainId) {
      return {
        verified: false,
        error: `Chain mismatch: proof=${proof.chainId}, expected=${expected.chainId}`,
        errorCode: "CHAIN_MISMATCH",
      };
    }

    return verifyTransfer({
      txHash: proof.txHash,
      expectedTo: expected.destination,
      expectedAmountRaw: expected.amountRaw,
      expectedChainId: expected.chainId,
      challengeExpiresAt: expected.expiresAt,
      networkConfig: this.networkConfig,
      client: this.client,
    });
  }

  getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }
}
