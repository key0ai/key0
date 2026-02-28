import express from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  AgentCard,
  Message,
  AGENT_CARD_PATH
} from "@a2a-js/sdk";
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder
} from "@a2a-js/sdk/server/express";

import {
  RequestPhotoAccess,
  X402Challenge,
  PaymentProof,
  AccessGranted
} from "../shared/types.js";
import { CHAIN, photoAgentClient, PHOTO_AGENT_ADDRESS } from "../shared/baseConfig.js";

const PHOTO_AGENT_ID = "photo-agent-1";
const PORT = process.env.PORT || 4001;
const PUBLIC_URL = process.env.PHOTO_AGENT_PUBLIC_URL || `http://localhost:${PORT}`;

// --- Logic from your original server ---
const challenges = new Map<string, X402Challenge>();
const paidChallenges = new Set<string>();
const apiKeys = new Map<
  string,
  { key: string; ownerAgentId: string; expiresAt: string; quotaPhotos: number }
>();

// 1. Define the Agent Card
const photoAgentCard: AgentCard = {
  name: 'Photo Agent',
  description: 'I provide access to exclusive photo albums via paid access (x402).',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: `${PUBLIC_URL}/a2a/jsonrpc`,
  skills: [
    { 
      id: 'request-access', 
      name: 'Request Photo Access', 
      description: 'Request access to an album. Expects a RequestPhotoAccess JSON object.', 
      tags: ['commerce', 'photos'] 
    },
    { 
      id: 'submit-proof', 
      name: 'Submit Payment Proof', 
      description: 'Submit a transaction hash. Expects a PaymentProof JSON object.', 
      tags: ['commerce', 'payment'] 
    }
  ],
  capabilities: {
    pushNotifications: false,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  additionalInterfaces: [
    { url: `${PUBLIC_URL}/a2a/jsonrpc`, transport: 'JSONRPC' },
    { url: `${PUBLIC_URL}/a2a/rest`, transport: 'HTTP+JSON' },
  ],
};

// 2. Implement the Agent Executor
class PhotoAgentExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    // We assume the client sends the JSON payload in the first text part
    const inputJson = userMessage.parts.find(p => p.kind === 'text')?.text || "{}";
    
    let msg: any;
    try {
      msg = JSON.parse(inputJson);
    } catch (e) {
      this.sendTextResponse(eventBus, requestContext.contextId, "Error: Please send a valid JSON payload.");
      return;
    }

    console.log(`[PhotoAgent] Received A2A message type: ${msg.type}`);

    if (msg.type === "RequestPhotoAccess") {
      const challenge = await this.handleRequestPhotoAccess(msg);
      // Return the challenge as a JSON string
      this.sendTextResponse(eventBus, requestContext.contextId, JSON.stringify(challenge));
    } 
    else if (msg.type === "PaymentProof") {
      const response = await this.handlePaymentProof(msg);
      // Return the access grant or error as JSON string
      this.sendTextResponse(eventBus, requestContext.contextId, JSON.stringify(response));
    } 
    else {
      this.sendTextResponse(eventBus, requestContext.contextId, "Error: Unsupported message type.");
    }

    eventBus.finished();
  }

  // Helper to send a simple text message back
  private sendTextResponse(eventBus: ExecutionEventBus, contextId: string, text: string) {
    const response: Message = {
      kind: 'message',
      messageId: uuidv4(),
      role: 'agent',
      parts: [{ kind: 'text', text }],
      contextId: contextId,
    };
    eventBus.publish(response);
  }

  // --- Original Logic Methods ---

  async handleRequestPhotoAccess(reqMsg: RequestPhotoAccess): Promise<X402Challenge> {
    console.log(`[PhotoAgent] Processing RequestPhotoAccess (reqId=${reqMsg.requestId})...`);
    const challengeId = crypto.randomUUID();
    const amountEth = "0.001";

    const challenge: X402Challenge = {
      type: "X402Challenge",
      challengeId,
      requestId: reqMsg.requestId,
      amountEth,
      asset: "ETH",
      chainId: CHAIN.id,
      destination: PHOTO_AGENT_ADDRESS,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      description: `Access to album ${reqMsg.albumId} for up to ${reqMsg.maxPhotos} photos`
    };
    challenges.set(challengeId, challenge);
    
    console.log(`[PhotoAgent] Created Challenge: Pay ${amountEth} ETH to ${PHOTO_AGENT_ADDRESS}`);
    return challenge;
  }

  async handlePaymentProof(proof: PaymentProof): Promise<AccessGranted | { error: string }> {
    console.log(`[PhotoAgent] Verifying PaymentProof for Challenge ${proof.challengeId} (tx=${proof.txHash})...`);
    
    const challenge = challenges.get(proof.challengeId);
    if (!challenge) {
      console.error(`[PhotoAgent] Unknown Challenge ID: ${proof.challengeId}`);
      return { error: "Unknown challengeId" };
    }
    if (paidChallenges.has(proof.challengeId)) {
      console.error(`[PhotoAgent] Challenge already used!`);
      return { error: "Challenge already used" };
    }
    if (challenge.chainId !== proof.chainId) return { error: "Wrong chainId" };
    if (challenge.destination.toLowerCase() !== PHOTO_AGENT_ADDRESS.toLowerCase()) {
      return { error: "Destination mismatch" };
    }

    console.log(`[PhotoAgent] Checking Tx status on-chain...`);
    try {
      const receipt = await photoAgentClient.getTransactionReceipt({
        hash: proof.txHash as `0x${string}`
      });
      if (receipt.status !== "success") {
        console.error(`[PhotoAgent] Tx failed on-chain! Status: ${receipt.status}`);
        return { error: "Tx failed on chain" };
      }
      console.log(`[PhotoAgent] Tx Verified!`);
    } catch (err) {
      console.error(`[PhotoAgent] Error checking tx:`, err);
      return { error: "Failed to verify tx" };
    }

    paidChallenges.add(proof.challengeId);

    const apiKey = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    
    apiKeys.set(apiKey, {
      key: apiKey,
      ownerAgentId: proof.fromAgentId,
      expiresAt,
      quotaPhotos: 500
    });

    console.log(`[PhotoAgent] Issued API Key (masked): ${apiKey.substring(0, 6)}... for agent ${proof.fromAgentId}`);

    const resp: AccessGranted = {
      type: "AccessGranted",
      requestId: proof.requestId,
      apiKey,
      scopes: ["photos:read"],
      expiresAt,
      quotaPhotos: 500
    };
    return resp;
  }

  cancelTask = async (): Promise<void> => {};
}

// 3. Set up Server
const agentExecutor = new PhotoAgentExecutor();
const requestHandler = new DefaultRequestHandler(
  photoAgentCard,
  new InMemoryTaskStore(),
  agentExecutor
);

const app = express();
app.use(express.json()); // needed for existing /photos endpoint if it receives body, or for general express hygiene

// Standard A2A Endpoints
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/.well-known/agent.json', agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

// Protected Resource Endpoint (kept from original)
app.get("/photos", (req, res) => {
  const auth = req.header("authorization") || "";
  const apiKey = auth.replace(/^Bearer\s+/i, "");
  console.log(`[PhotoAgent] /photos Request with key (masked): ${apiKey.substring(0, 6)}...`);
  
  const entry = apiKeys.get(apiKey);
  if (!entry) {
    console.warn(`[PhotoAgent] Invalid API Key attempt.`);
    return res.status(401).json({ error: "Invalid apiKey" });
  }
  if (new Date(entry.expiresAt) < new Date()) {
    console.warn(`[PhotoAgent] Expired API Key attempt.`);
    return res.status(402).json({ error: "API key expired" });
  }

  const photos = [
    { id: "p1", url: "https://example.test/photo1.jpg" },
    { id: "p2", url: "https://example.test/photo2.jpg" }
  ];
  console.log(`[PhotoAgent] Serving ${photos.length} photos.`);
  res.json({ photos });
});

app.listen(PORT, () => {
  console.log(`PhotoServiceAgent listening on :${PORT}`);
});
