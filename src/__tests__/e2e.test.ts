import { describe, expect, test } from "bun:test";
import type {
	AgentExecutionEvent,
	ExecutionEventBus,
	ExecutionEventName,
	RequestContext,
} from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { AccessTokenIssuer } from "../core/access-token.js";
import { createKey0 } from "../factory.js";
import { MockPaymentAdapter, TestChallengeStore, TestSeenTxStore } from "../test-utils";
import type { SellerConfig } from "../types";
import { X402_METADATA_KEYS } from "../types";

const SECRET = "a-very-long-secret-that-is-at-least-32-characters!";
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(): SellerConfig {
	const issuer = new AccessTokenIssuer(SECRET);

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
			const { token, expiresAt } = await issuer.sign(
				{
					sub: params.requestId,
					jti: params.challengeId,
					resourceId: params.resourceId,
					tierId: params.tierId,
					txHash: params.txHash,
				},
				3600,
			);

			return { token, expiresAt, tokenType: "Bearer" };
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

	on(_eventName: ExecutionEventName, _listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	off(_eventName: ExecutionEventName, _listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	once(_eventName: ExecutionEventName, _listener: (event: AgentExecutionEvent) => void): this {
		return this;
	}

	removeAllListeners(_eventName?: ExecutionEventName): this {
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

function extractTaskState(events: any[]): string {
	const task = events.find((e: any) => e.kind === "task");
	return task?.status?.state ?? "unknown";
}

function extractMetadata(events: any[]): Record<string, unknown> {
	const task = events.find((e: any) => e.kind === "task");
	return task?.status?.message?.metadata ?? {};
}

describe("E2E: Full Key0 lifecycle (x402 Extension)", () => {
	test("1. AccessRequest → input-required Task with x402 metadata", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor, agentCard } = createKey0({
			config,
			adapter,
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		});

		// Agent card check
		expect(agentCard.name).toBe("E2E Test Agent");
		expect(agentCard.skills).toHaveLength(2);
		expect(agentCard.skills[0]!.pricing).toHaveLength(1);

		// Verify x402 extension is declared
		expect(agentCard.capabilities.extensions).toBeDefined();
		expect(agentCard.capabilities.extensions!.length).toBeGreaterThan(0);
		expect(agentCard.capabilities.extensions![0]!.uri).toContain("x402");
		expect(agentCard.capabilities.extensions![0]!.required).toBe(true);

		// Request access
		const requestId = uuidv4();
		const events = await runTask(executor, {
			type: "AccessRequest",
			requestId,
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});

		// Verify Task with input-required state
		expect(extractTaskState(events)).toBe("input-required");

		// Verify x402 metadata (v2 format)
		const metadata = extractMetadata(events);
		expect(metadata[X402_METADATA_KEYS.STATUS]).toBe("payment-required");
		expect(metadata[X402_METADATA_KEYS.REQUIRED]).toBeDefined();
		const paymentRequired = metadata[X402_METADATA_KEYS.REQUIRED] as any;
		expect(paymentRequired.x402Version).toBe(2);
		expect(paymentRequired.resource).toBeDefined();
		expect(paymentRequired.accepts).toHaveLength(1);
		expect(paymentRequired.accepts[0].scheme).toBe("exact");
		expect(paymentRequired.accepts[0].network).toBe("eip155:84532"); // CAIP-2 format
		expect(paymentRequired.accepts[0].payTo).toBe(WALLET);

		// Verify the challenge data is in the data part
		const challenge = extractChallengeData(events);
		expect(challenge["type"]).toBe("X402Challenge");
		expect(challenge["amount"]).toBe("$0.10");
		expect(challenge["chainId"]).toBe(84532);
		expect(challenge["destination"]).toBe(WALLET);
	});

	test("2. Idempotent access request returns same challenge", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createKey0({
			config,
			adapter,
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		});

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

	test("3. Resource not found returns failed task", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createKey0({
			config,
			adapter,
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		});

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

	test("4. Default resourceId when not provided", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor } = createKey0({
			config,
			adapter,
			store: new TestChallengeStore(),
			seenTxStore: new TestSeenTxStore(),
		});

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
