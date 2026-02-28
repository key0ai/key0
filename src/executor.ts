import type { Message, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import type { ChallengeEngine } from "./core/index.js";
import type { AccessRequest, PaymentProof } from "./types/index.js";

export class AgentGateExecutor implements AgentExecutor {
	constructor(private engine: ChallengeEngine) {}

	async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const { taskId, contextId, userMessage } = context;

		try {
			// Parse message payload
			const payload = this.parseMessage(userMessage);
			if (!payload) {
				const partsInfo =
					userMessage.parts?.map((p: { kind?: string }) => p.kind).join(", ") || "none";
				this.sendErrorResponse(eventBus, contextId, taskId, userMessage, {
					error: "Invalid message format",
					message: `No data part found in message. Available parts: [${partsInfo}]. Expected a part with kind="data" or a text part containing valid JSON.`,
				});
				return;
			}

			// Route by type or shape
			let resultData: unknown;
			if (payload["type"] === "AccessRequest" || this.isAccessRequest(payload)) {
				resultData = await this.engine.requestAccess(payload as unknown as AccessRequest);
			} else if (payload["type"] === "PaymentProof" || this.isPaymentProof(payload)) {
				resultData = await this.engine.submitProof(payload as unknown as PaymentProof);
			} else {
				this.sendErrorResponse(eventBus, contextId, taskId, userMessage, {
					error: "Unknown message type",
					message: `Unsupported message type: ${payload["type"]}`,
				});
				return;
			}

			// Success - publish task completion and result message
			this.publishTaskUpdate(eventBus, taskId, contextId, userMessage, "completed");
			this.sendSuccessResponse(eventBus, contextId, resultData);
		} catch (err: unknown) {
			this.sendErrorResponse(eventBus, contextId, taskId, userMessage, {
				error: "Execution error",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			eventBus.finished();
		}
	}

	async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
		// No-op for now as tasks are synchronous
	}

	/**
	 * Parse message payload from either data part or text part (JSON string)
	 */
	private parseMessage(userMessage: Message): Record<string, unknown> | null {
		// biome-ignore lint/suspicious/noExplicitAny: library type issue
		let dataPart = userMessage.parts?.find((p: any) => p.kind === "data");

		// If no data part, try to parse from text parts
		if (!dataPart && userMessage.parts) {
			// biome-ignore lint/suspicious/noExplicitAny: library type issue
			const textPart = userMessage.parts.find((p: any) => p.kind === "text");
			if (textPart) {
				try {
					// biome-ignore lint/suspicious/noExplicitAny: library type issue
					const parsed = JSON.parse((textPart as any).text);
					// Create a synthetic data part
					dataPart = { kind: "data", data: parsed };
				} catch {
					// If parsing fails, return null
					return null;
				}
			}
		}

		if (!dataPart) {
			return null;
		}

		// The data field in A2A SDK is typed as unknown or similar, cast it
		// biome-ignore lint/suspicious/noExplicitAny: library type issue
		return (dataPart as any).data as Record<string, unknown>;
	}

	/**
	 * Publish task status update
	 */
	private publishTaskUpdate(
		eventBus: ExecutionEventBus,
		taskId: string,
		contextId: string,
		userMessage: Message,
		state: "completed" | "failed",
	): void {
		const taskUpdate: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: {
				state,
				timestamp: new Date().toISOString(),
			},
			history: [userMessage],
		};
		eventBus.publish(taskUpdate);
	}

	/**
	 * Send success response with data part
	 */
	private sendSuccessResponse(
		eventBus: ExecutionEventBus,
		contextId: string,
		resultData: unknown,
	): void {
		const responseMessage: Message = {
			kind: "message",
			messageId: uuidv4(),
			role: "agent",
			contextId,
			parts: [
				{
					kind: "data",
					data: resultData as Record<string, unknown>,
				},
			],
		};
		eventBus.publish(responseMessage);
	}

	/**
	 * Send error response with structured error object (JSON string in text part)
	 */
	private sendErrorResponse(
		eventBus: ExecutionEventBus,
		contextId: string,
		taskId: string,
		userMessage: Message,
		error: { error: string; message?: string },
	): void {
		// Publish failed task
		this.publishTaskUpdate(eventBus, taskId, contextId, userMessage, "failed");

		// Send structured error message as JSON string (matching reference pattern)
		const errorMessage: Message = {
			kind: "message",
			messageId: uuidv4(),
			role: "agent",
			contextId,
			parts: [
				{
					kind: "text",
					text: JSON.stringify(error),
				},
			],
		};
		eventBus.publish(errorMessage);
	}

	private isAccessRequest(data: Record<string, unknown>): boolean {
		return (
			typeof data["requestId"] === "string" &&
			typeof data["resourceId"] === "string" &&
			typeof data["tierId"] === "string" &&
			typeof data["clientAgentId"] === "string"
		);
	}

	private isPaymentProof(data: Record<string, unknown>): boolean {
		return (
			typeof data["challengeId"] === "string" &&
			typeof data["txHash"] === "string" &&
			typeof data["chainId"] === "number"
		);
	}
}
