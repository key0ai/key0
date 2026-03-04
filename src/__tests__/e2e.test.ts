import { describe, expect, test } from "bun:test";
import type { Message, Task } from "@a2a-js/sdk";
import type {
	AgentExecutionEvent,
	ExecutionEventBus,
	ExecutionEventName,
	RequestContext,
} from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { createAgentGate } from "../factory.js";
import { validateToken } from "../middleware.js";
import { MockPaymentAdapter } from "../test-utils";
import type { SellerConfig } from "../types";
import { X402_METADATA_KEYS } from "../types";

const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(): SellerConfig {
	return {
		agentName: "E2E Test Agent",
		agentDescription: "E2E test",
		agentUrl: "https://agent.example.com",
		providerName: "Test Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		products: [
			{ tierId: "single", label: "Single Photo", amount: "$0.10", resourceType: "photo" },
			{ tierId: "album", label: "Full Album", amount: "$1.00", resourceType: "album" },
		],
		challengeTTLSeconds: 900,
		onVerifyResource: async (resourceId: string) => {
			return resourceId !== "nonexistent";
		},
		onIssueToken: async (params) => {
			const { AccessTokenIssuer } = await import("../core/access-token.js");
			const issuer = new AccessTokenIssuer(SECRET);
			return issuer.sign(
				{
					sub: params.requestId,
					jti: params.challengeId,
					resourceId: params.resourceId,
					tierId: params.tierId,
					txHash: params.txHash,
				},
				3600,
			);
		},
		resourceEndpointTemplate: "https://api.example.com/photos/{resourceId}",
	};
}

class MockEventBus implements ExecutionEventBus {
	public events: AgentExecutionEvent[] = [];

	publish(event: AgentExecutionEvent): void {
		this.events.push(event);
	}

	finished(): void {}

	send(message: any): void {
		this.events.push(message);
	}

	on(eventName: ExecutionEventName, listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	off(eventName: ExecutionEventName, listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	once(eventName: ExecutionEventName, listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	removeAllListeners(eventName?: ExecutionEventName): this {
		return this;
	}
}

async function runTask(executor: any, payload: any, metadata?: Record<string, unknown>) {
	const eventBus = new MockEventBus();
	const taskId = uuidv4();
	const contextId = uuidv4();

	const userMessage: any = {
		kind: "message",
		messageId: uuidv4(),
		role: "user",
		parts: [{ kind: "data", data: payload }],
		contextId,
	};
	if (metadata) {
		userMessage.metadata = metadata;
	}

	const context: RequestContext = {
		taskId,
		contextId,
		userMessage,
	};

	await executor.execute(context, eventBus);
	return eventBus.events;
}

/**
 * Extract data from a Task event's status message or artifacts.
 */
function extractChallengeData(events: any[]): any {
	const task = events.find((e: any) => e.kind === "task");
	if (task) {
		// Look in the data parts of status.message
		const dataPart = task.status?.message?.parts?.find((p: any) => p.kind === "data");
		if (dataPart) return dataPart.data;
		// Fall back to text parts
		const textPart = task.status?.message?.parts?.find((p: any) => p.kind === "text");
		if (textPart) {
			try {
				return JSON.parse(textPart.text);
			} catch {
				/* ignore */
			}
		}
	}
	// Fall back to old message format
	const message = events.find((e: any) => e.kind === "message" && e.role === "agent");
	if (message) {
		const part = message.parts[0];
		if (part.kind === "data") return part.data;
		if (part.kind === "text") return JSON.parse(part.text);
	}
	throw new Error("No data found in events");
}

function extractGrantData(events: any[]): any {
	const task = events.find((e: any) => e.kind === "task");
	if (task) {
		// Check artifacts first
		const artifact = task.artifacts?.[0];
		if (artifact) {
			const dataPart = artifact.parts?.find((p: any) => p.kind === "data");
			if (dataPart) return dataPart.data;
		}
		// Fall back to status.message data parts
		const dataPart = task.status?.message?.parts?.find((p: any) => p.kind === "data");
		if (dataPart) return dataPart.data;
	}
	throw new Error("No grant data found in events");
}

function extractTaskState(events: any[]): string {
	const task = events.find((e: any) => e.kind === "task");
	return task?.status?.state ?? "unknown";
}

function extractMetadata(events: any[]): Record<string, unknown> {
	const task = events.find((e: any) => e.kind === "task");
	return task?.status?.message?.metadata ?? {};
}

function makeTxHash(): `0x${string}` {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as `0x${string}`;
}

describe("E2E: Full AgentGate lifecycle (x402 Extension)", () => {
	test("1. AccessRequest → input-required Task with x402 metadata → PaymentProof → completed Task", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor, agentCard } = createAgentGate({ config, adapter });

		// Agent card check
		expect(agentCard.name).toBe("E2E Test Agent");
		expect(agentCard.skills).toHaveLength(2);
		expect(agentCard.skills[0]!.pricing).toHaveLength(1);

		// Verify x402 extension is declared
		expect(agentCard.capabilities.extensions).toBeDefined();
		expect(agentCard.capabilities.extensions!.length).toBeGreaterThan(0);
		expect(agentCard.capabilities.extensions![0]!.uri).toContain("x402");
		expect(agentCard.capabilities.extensions![0]!.required).toBe(true);

		// Step 1: Request access
		const requestId = uuidv4();
		const events1 = await runTask(executor, {
			type: "AccessRequest",
			requestId,
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});

		// Verify Task with input-required state
		expect(extractTaskState(events1)).toBe("input-required");

		// Verify x402 metadata (v2 format)
		const metadata1 = extractMetadata(events1);
		expect(metadata1[X402_METADATA_KEYS.STATUS]).toBe("payment-required");
		expect(metadata1[X402_METADATA_KEYS.REQUIRED]).toBeDefined();
		const paymentRequired = metadata1[X402_METADATA_KEYS.REQUIRED] as any;
		expect(paymentRequired.x402Version).toBe(2);
		expect(paymentRequired.resource).toBeDefined();
		expect(paymentRequired.accepts).toHaveLength(1);
		expect(paymentRequired.accepts[0].scheme).toBe("exact");
		expect(paymentRequired.accepts[0].network).toBe("eip155:84532"); // CAIP-2 format
		expect(paymentRequired.accepts[0].payTo).toBe(WALLET);

		// Also verify the challenge data is in the data part
		const challenge = extractChallengeData(events1);
		expect(challenge["type"]).toBe("X402Challenge");
		expect(challenge["amount"]).toBe("$0.10");
		expect(challenge["chainId"]).toBe(84532);
		expect(challenge["destination"]).toBe(WALLET);

		// Step 2: Submit proof via data part (backward compat)
		const txHash = makeTxHash();
		const events2 = await runTask(executor, {
			type: "PaymentProof",
			challengeId: challenge["challengeId"],
			requestId,
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://e2e-test",
		});

		// Verify Task with completed state
		expect(extractTaskState(events2)).toBe("completed");

		// Verify x402 metadata
		const metadata2 = extractMetadata(events2);
		expect(metadata2[X402_METADATA_KEYS.STATUS]).toBe("payment-completed");
		expect(metadata2[X402_METADATA_KEYS.RECEIPTS]).toBeDefined();
		const receipts = metadata2[X402_METADATA_KEYS.RECEIPTS] as any[];
		expect(receipts).toHaveLength(1);
		expect(receipts[0].success).toBe(true);
		expect(receipts[0].transaction).toBe(txHash);
		expect(receipts[0].network).toBe("base-sepolia");

		// Verify grant in artifacts
		const grant = extractGrantData(events2);
		expect(grant["type"]).toBe("AccessGrant");
		expect(grant["tokenType"]).toBe("Bearer");
		expect(grant["txHash"]).toBe(txHash);
		expect(grant["resourceEndpoint"]).toBe("https://api.example.com/photos/photo-42");

		// Validate token
		const payload = await validateToken(`Bearer ${grant["accessToken"]}`, { secret: SECRET });
		expect(payload.sub).toBe(requestId);
		expect(payload.resourceId).toBe("photo-42");
		expect(payload.tierId).toBe("single");
		expect(payload.txHash).toBe(txHash);
	});

	test("2. x402 metadata payment submission flow", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createAgentGate({ config, adapter });

		// Step 1: Request access
		const requestId = uuidv4();
		const events1 = await runTask(executor, {
			type: "AccessRequest",
			requestId,
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});

		const challenge = extractChallengeData(events1);
		const txHash = makeTxHash();

		// Step 2: Submit proof via x402 metadata (new flow, v2 format)
		const events2 = await runTask(
			executor,
			{}, // empty payload — proof is in metadata
			{
				[X402_METADATA_KEYS.STATUS]: "payment-submitted",
				[X402_METADATA_KEYS.PAYLOAD]: {
					x402Version: 2,
					network: "eip155:84532", // CAIP-2 format
					scheme: "exact",
					payload: {
						txHash,
						challengeId: challenge["challengeId"],
						requestId,
						amount: "$0.10",
						asset: "USDC",
						from: "agent://e2e-test",
						chainId: 84532,
					},
				},
			},
		);

		expect(extractTaskState(events2)).toBe("completed");
		const metadata2 = extractMetadata(events2);
		expect(metadata2[X402_METADATA_KEYS.STATUS]).toBe("payment-completed");

		const grant = extractGrantData(events2);
		expect(grant["type"]).toBe("AccessGrant");
		expect(grant["txHash"]).toBe(txHash);
	});

	test("3. Idempotent access request returns same challenge", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createAgentGate({ config, adapter });

		const requestId = uuidv4();
		const reqData = {
			type: "AccessRequest",
			requestId,
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		};

		const e1 = await runTask(executor, reqData);
		const e2 = await runTask(executor, reqData);

		const c1 = extractChallengeData(e1);
		const c2 = extractChallengeData(e2);
		expect(c1["challengeId"]).toBe(c2["challengeId"]);
	});

	test("4. Resource not found returns failed task", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createAgentGate({ config, adapter });

		const events = await runTask(executor, {
			type: "AccessRequest",
			requestId: uuidv4(),
			resourceId: "nonexistent",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});

		expect(extractTaskState(events)).toBe("failed");
		const task = events.find((e: any) => e.kind === "task");
		expect(task).toBeDefined();
		const textPart = (task as any).status.message.parts.find((p: any) => p.kind === "text");
		expect(textPart.text).toContain("not found");
	});

	test("5. Double-spend prevention", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createAgentGate({ config, adapter });
		const txHash = makeTxHash();

		// First cycle
		const e1 = await runTask(executor, {
			type: "AccessRequest",
			requestId: uuidv4(),
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});
		const c1 = extractChallengeData(e1);

		await runTask(executor, {
			type: "PaymentProof",
			challengeId: c1["challengeId"],
			requestId: uuidv4(),
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://e2e-test",
		});

		// Second cycle, new challenge
		const e2 = await runTask(executor, {
			type: "AccessRequest",
			requestId: uuidv4(),
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});
		const c2 = extractChallengeData(e2);

		// Reuse txHash
		const doubleSpendEvents = await runTask(executor, {
			type: "PaymentProof",
			challengeId: c2["challengeId"],
			requestId: uuidv4(),
			chainId: 84532,
			txHash,
			amount: "$0.10",
			asset: "USDC",
			fromAgentId: "agent://e2e-test",
		});

		expect(extractTaskState(doubleSpendEvents)).toBe("failed");
		const task = doubleSpendEvents.find((e: any) => e.kind === "task");
		const textPart = (task as any).status.message.parts.find((p: any) => p.kind === "text");
		expect(textPart.text).toContain("already been redeemed");
	});

	test("6. Default resourceId when not provided", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createAgentGate({ config, adapter });

		const events = await runTask(executor, {
			type: "AccessRequest",
			requestId: uuidv4(),
			tierId: "single",
		});

		expect(extractTaskState(events)).toBe("input-required");
		const challenge = extractChallengeData(events);
		expect(challenge["type"]).toBe("X402Challenge");
	});
});
