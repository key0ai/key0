import { describe, expect, test } from "bun:test";
import type { Message, Task } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus, ExecutionEventName, RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { createAgentGate } from "../factory.js";
import { validateToken } from "../middleware.js";
import { MockPaymentAdapter } from "../test-utils";
import type { SellerConfig } from "../types";

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
			// Use AccessTokenIssuer for testing (opt-in pattern)
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

async function runTask(
	executor: { execute: (context: RequestContext, eventBus: ExecutionEventBus) => Promise<void> },
	payload: Record<string, unknown>,
) {
	const eventBus = new MockEventBus();
	const taskId = uuidv4();
	const contextId = uuidv4();

	const userMessage: Message = {
		kind: "message",
		messageId: uuidv4(),
		role: "user",
		parts: [{ kind: "data", data: payload }],
		contextId,
	};

	const context: RequestContext = {
		taskId,
		contextId,
		userMessage,
	};

	await executor.execute(context, eventBus);
	return eventBus.events;
}

function extractData(events: AgentExecutionEvent[]): Record<string, unknown> {
	const message = events.find((e) => e.kind === "message" && "role" in e && e.role === "agent");
	if (!message) throw new Error("No agent message found");
	// biome-ignore lint/suspicious/noExplicitAny: event parts are typed loosely by the SDK
	return ((message as any).parts as Array<{ data: Record<string, unknown> }>)[0]?.data ?? {};
}

function makeTxHash(): `0x${string}` {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as `0x${string}`;
}

describe("E2E: Full AgentGate lifecycle (Executor)", () => {
	test("1. Agent card → AccessRequest → Challenge → Proof → Grant → Token validation", async () => {
		const adapter = new MockPaymentAdapter();
		const config = makeConfig();
		const { executor, agentCard } = createAgentGate({ config, adapter });

		// Agent card check
		expect(agentCard.name).toBe("E2E Test Agent");
		expect(agentCard.skills).toHaveLength(2);
		expect(agentCard.skills[0]!.pricing).toHaveLength(2);

		// Request access
		const requestId = uuidv4();
		const events1 = await runTask(executor, {
			type: "AccessRequest",
			requestId,
			resourceId: "photo-42",
			tierId: "single",
			clientAgentId: "agent://e2e-test",
		});

		const challenge = extractData(events1);
		expect(challenge["type"]).toBe("X402Challenge");
		expect(challenge["amount"]).toBe("$0.10");
		expect(challenge["chainId"]).toBe(84532);
		expect(challenge["destination"]).toBe(WALLET);

		// Submit proof
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

		const grant = extractData(events2);
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

	test("2. Idempotent access request returns same challenge", async () => {
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

		const c1 = extractData(e1);
		const c2 = extractData(e2);
		expect(c1["challengeId"]).toBe(c2["challengeId"]);
	});

	test("3. Resource not found returns error", async () => {
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

		// Expect error message or failed task
		const failedTask = events.find((e) => e.kind === "task" && e.status.state === "failed");
		expect(failedTask).toBeDefined();

		const errorMsg = events.find((e) => e.kind === "message" && e.parts[0]?.kind === "text");
		expect(errorMsg).toBeDefined();
		// In a real scenario we'd check the error message content, but here we just check failure
	});

	test("4. Double-spend prevention", async () => {
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
		const c1 = extractData(e1);

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
		const c2 = extractData(e2);

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

		const failedTask = doubleSpendEvents.find(
			(e) => e.kind === "task" && e.status.state === "failed",
		);
		expect(failedTask).toBeDefined();
		const errorMsg = doubleSpendEvents.find((e) => e.kind === "message");
		// biome-ignore lint/suspicious/noExplicitAny: SDK Message parts have loose text typing
		expect(((errorMsg as any)?.parts as Array<{ text?: string }>)[0]?.text).toContain("already been redeemed");
		// Or whatever error message core returns (AgentGateError messages are usually descriptive)
	});
});
