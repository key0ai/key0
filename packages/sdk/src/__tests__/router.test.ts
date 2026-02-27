import { describe, expect, test } from "bun:test";
import {
  AgentGateError,
  type A2ATaskSendRequest,
  type ChallengePayload,
  type IPaymentAdapter,
  type IssueChallengeParams,
  type SellerConfig,
  type VerificationResult,
  type VerifyProofParams,
} from "@agentgate/types";
import {
  AccessTokenIssuer,
  ChallengeEngine,
  InMemoryChallengeStore,
  InMemorySeenTxStore,
} from "@agentgate/core";
import { AgentGateRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Mock Adapter
// ---------------------------------------------------------------------------
class MockPaymentAdapter implements IPaymentAdapter {
  readonly protocol = "mock";
  private verifyResult: VerificationResult = {
    verified: true,
    txHash: `0x${"a".repeat(64)}` as `0x${string}`,
    confirmedAmount: 100000n,
    confirmedChainId: 84532,
    confirmedAt: new Date(),
    blockNumber: 1000n,
  };

  async issueChallenge(params: IssueChallengeParams): Promise<ChallengePayload> {
    return {
      challengeId: crypto.randomUUID(),
      protocol: this.protocol,
      raw: {},
      expiresAt: params.expiresAt,
    };
  }

  async verifyProof(_params: VerifyProofParams): Promise<VerificationResult> {
    return this.verifyResult;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(): SellerConfig {
  return {
    agentName: "Test Agent",
    agentDescription: "Test",
    agentUrl: "https://agent.example.com",
    providerName: "Provider",
    providerUrl: "https://provider.example.com",
    walletAddress: WALLET,
    network: "testnet",
    products: [
      { tierId: "single", label: "Single Photo", amount: "$0.10", resourceType: "photo" },
    ],
    accessTokenSecret: SECRET,
    challengeTTLSeconds: 900,
    onVerifyResource: async () => true,
  };
}

function makeRouter() {
  const config = makeConfig();
  const adapter = new MockPaymentAdapter();
  const store = new InMemoryChallengeStore();
  const seenTxStore = new InMemorySeenTxStore();
  const tokenIssuer = new AccessTokenIssuer(SECRET);

  const engine = new ChallengeEngine({
    config,
    store,
    seenTxStore,
    adapter,
    tokenIssuer,
  });

  return new AgentGateRouter({ engine, config });
}

function makeA2ARequest(data: Record<string, unknown>): A2ATaskSendRequest {
  return {
    jsonrpc: "2.0",
    id: "rpc-1",
    method: "tasks/send",
    params: {
      id: "task-1",
      message: {
        role: "user",
        parts: [
          {
            type: "data",
            data,
            mimeType: "application/json",
          },
        ],
      },
    },
  };
}

function makeTxHash(): `0x${string}` {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentGateRouter.handleAgentCard", () => {
  test("returns agent card with 200", async () => {
    const router = makeRouter();
    const result = await router.handleAgentCard();

    expect(result.status).toBe(200);
    const body = result.body as { name: string; skills: unknown[] };
    expect(body.name).toBe("Test Agent");
    expect(body.skills).toHaveLength(2);
  });

  test("sets cache-control header", async () => {
    const router = makeRouter();
    const result = await router.handleAgentCard();

    expect(result.headers?.["Cache-Control"]).toBe("public, max-age=300");
  });
});

describe("AgentGateRouter.handleA2ATask", () => {
  test("routes AccessRequest to requestAccess", async () => {
    const router = makeRouter();
    const request = makeA2ARequest({
      type: "AccessRequest",
      requestId: crypto.randomUUID(),
      resourceId: "photo-42",
      tierId: "single",
      clientAgentId: "agent://test",
    });

    const result = await router.handleA2ATask(request);
    expect(result.status).toBe(200);

    const body = result.body as { result: { status: { state: string } } };
    expect(body.result.status.state).toBe("completed");
  });

  test("routes PaymentProof to submitProof", async () => {
    const router = makeRouter();

    // First get a challenge
    const accessReq = makeA2ARequest({
      type: "AccessRequest",
      requestId: crypto.randomUUID(),
      resourceId: "photo-42",
      tierId: "single",
      clientAgentId: "agent://test",
    });
    const challengeResult = await router.handleA2ATask(accessReq);
    const challengeBody = challengeResult.body as {
      result: { status: { message: { parts: { data: { challengeId: string } }[] } } };
    };
    const challengeId =
      challengeBody.result.status.message.parts[0]!.data.challengeId;

    // Submit proof
    const proofReq = makeA2ARequest({
      type: "PaymentProof",
      challengeId,
      requestId: crypto.randomUUID(),
      chainId: 84532,
      txHash: makeTxHash(),
      amount: "$0.10",
      asset: "USDC",
      fromAgentId: "agent://test",
    });

    const result = await router.handleA2ATask(proofReq);
    expect(result.status).toBe(200);

    const body = result.body as { result: { status: { state: string } } };
    expect(body.result.status.state).toBe("completed");
  });

  test("returns error for unknown message type", async () => {
    const router = makeRouter();
    const request = makeA2ARequest({ type: "Unknown", foo: "bar" });

    const result = await router.handleA2ATask(request);
    expect(result.status).toBe(400);

    const body = result.body as { result: { status: { state: string } } };
    expect(body.result.status.state).toBe("failed");
  });

  test("returns error for no data part", async () => {
    const router = makeRouter();
    const request: A2ATaskSendRequest = {
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "tasks/send",
      params: {
        id: "task-1",
        message: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
    };

    const result = await router.handleA2ATask(request);
    expect(result.status).toBe(400);
  });

  test("TIER_NOT_FOUND returns failed status", async () => {
    const router = makeRouter();
    const request = makeA2ARequest({
      type: "AccessRequest",
      requestId: crypto.randomUUID(),
      resourceId: "photo-42",
      tierId: "nonexistent",
      clientAgentId: "agent://test",
    });

    const result = await router.handleA2ATask(request);
    expect(result.status).toBe(400);

    const body = result.body as { result: { status: { state: string } } };
    expect(body.result.status.state).toBe("failed");
  });

  test("detects AccessRequest by shape (without type field)", async () => {
    const router = makeRouter();
    const request = makeA2ARequest({
      requestId: crypto.randomUUID(),
      resourceId: "photo-42",
      tierId: "single",
      clientAgentId: "agent://test",
    });

    const result = await router.handleA2ATask(request);
    expect(result.status).toBe(200);
  });
});
