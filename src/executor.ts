import type { Artifact, Message, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import type { ChallengeEngine } from "./core/index.js";
import type { AccessRequest, PaymentProof, X402PaymentPayload } from "./types/index.js";
import { AgentGateError, NETWORK_TO_CHAIN_ID, X402_METADATA_KEYS } from "./types/index.js";

export class AgentGateExecutor implements AgentExecutor {
	constructor(private engine: ChallengeEngine) {}

	async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const { taskId, contextId, userMessage } = context;

		try {
			// ----- Check for x402 payment submission via metadata -----
			const paymentPayload = this.extractX402PaymentPayload(userMessage);
			if (paymentPayload) {
				await this.handleX402PaymentSubmission(paymentPayload, taskId, contextId, eventBus);
				return;
			}

			// ----- Parse message payload from parts (data or text) -----
			const payload = this.parseMessage(userMessage);
			if (!payload) {
				const partsInfo = userMessage.parts?.map((p: any) => p.kind).join(", ") || "none";
				this.sendErrorTask(
					eventBus,
					taskId,
					contextId,
					"failed",
					"Invalid message format",
					`No data part found in message. Available parts: [${partsInfo}]. Expected a part with kind="data" or a text part containing valid JSON, or x402 payment metadata.`,
				);
				return;
			}

			// ----- Route by type or shape -----
			if (payload["type"] === "AccessRequest" || this.isAccessRequest(payload)) {
				await this.handleAccessRequest(
					payload as unknown as AccessRequest,
					taskId,
					contextId,
					eventBus,
				);
			} else if (payload["type"] === "PaymentProof" || this.isPaymentProof(payload)) {
				await this.handlePaymentProof(
					payload as unknown as PaymentProof,
					taskId,
					contextId,
					eventBus,
				);
			} else {
				this.sendErrorTask(
					eventBus,
					taskId,
					contextId,
					"failed",
					"Unknown message type",
					`Unsupported message type: ${payload["type"]}`,
				);
			}
		} catch (err: unknown) {
			if (err instanceof AgentGateError) {
				this.sendErrorTask(
					eventBus,
					taskId,
					contextId,
					"failed",
					err.code,
					err.message,
					err.toJSON(),
				);
			} else {
				this.sendErrorTask(
					eventBus,
					taskId,
					contextId,
					"failed",
					"Execution error",
					err instanceof Error ? err.message : String(err),
				);
			}
		} finally {
			eventBus.finished();
		}
	}

	async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
		// No-op for now as tasks are synchronous
	}

	// ===================================================================
	// Handler: AccessRequest → Task with input-required + x402 metadata
	// ===================================================================

	private async handleAccessRequest(
		req: AccessRequest,
		taskId: string,
		contextId: string,
		eventBus: ExecutionEventBus,
	): Promise<void> {
		const challenge = await this.engine.requestAccess(req);

		// Get the full challenge record to build x402 metadata
		const record = await this.engine.getChallengeRecord(challenge.challengeId);
		if (!record) {
			throw new AgentGateError("INTERNAL_ERROR", "Challenge record not found after creation", 500);
		}

		const x402PaymentRequired = this.engine.buildX402PaymentRequired(record);

		// Build Task with input-required state and x402 metadata
		const task: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: {
				state: "input-required",
				timestamp: new Date().toISOString(),
				message: {
					kind: "message",
					messageId: uuidv4(),
					role: "agent",
					parts: [
						{
							kind: "text",
							text: challenge.description,
						},
						{
							kind: "data",
							data: challenge as any,
						},
					],
					metadata: {
						[X402_METADATA_KEYS.STATUS]: "payment-required",
						[X402_METADATA_KEYS.REQUIRED]: x402PaymentRequired,
					},
				},
			},
		};

		eventBus.publish(task);
	}

	// ===================================================================
	// Handler: PaymentProof (via data part) → Task with completed + receipt
	// ===================================================================

	private async handlePaymentProof(
		proof: PaymentProof,
		taskId: string,
		contextId: string,
		eventBus: ExecutionEventBus,
	): Promise<void> {
		const grant = await this.engine.submitProof(proof);

		// Get the challenge record for the receipt
		const record = await this.engine.getChallengeRecord(proof.challengeId);
		const receipt = record
			? this.engine.buildX402Receipt(record, grant)
			: { success: true, transaction: grant.txHash, network: "unknown" };

		const task: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: {
				state: "completed",
				timestamp: new Date().toISOString(),
				message: {
					kind: "message",
					messageId: uuidv4(),
					role: "agent",
					parts: [
						{
							kind: "text",
							text: "Payment successful. Access token issued.",
						},
						{
							kind: "data",
							data: grant as any,
						},
					],
					metadata: {
						[X402_METADATA_KEYS.STATUS]: "payment-completed",
						[X402_METADATA_KEYS.RECEIPTS]: [receipt],
					},
				},
			},
			artifacts: [
				{
					artifactId: uuidv4(),
					name: "access-grant",
					parts: [{ kind: "data", data: grant as any }],
				},
			],
		};

		eventBus.publish(task);
	}

	// ===================================================================
	// Handler: x402 Payment Payload (via message.metadata)
	// ===================================================================

	private async handleX402PaymentSubmission(
		payload: X402PaymentPayload,
		taskId: string,
		contextId: string,
		eventBus: ExecutionEventBus,
	): Promise<void> {
		// Convert x402 payload to internal PaymentProof format
		const extra = this.findChallengeInfoFromPayload(payload);
		if (!extra["challengeId"]) {
			throw new AgentGateError(
				"INVALID_REQUEST",
				"x402 payment payload must include challengeId in the payment requirements extra data, or as a top-level field. Please resubmit with the challengeId from the payment-required response.",
				400,
			);
		}

		const chainId = NETWORK_TO_CHAIN_ID[payload.network] ?? extra["chainId"];
		if (!chainId) {
			throw new AgentGateError(
				"INVALID_REQUEST",
				`Unknown network "${payload.network}". Expected "base-sepolia" or "base".`,
				400,
			);
		}

		const proof: PaymentProof = {
			type: "PaymentProof",
			challengeId: extra["challengeId"] as string,
			requestId: (extra["requestId"] as string) ?? "",
			chainId: chainId as number,
			txHash: payload.payload.txHash as `0x${string}`,
			amount: (extra["amount"] as string) ?? "",
			asset: (payload.payload.asset ?? extra["asset"] ?? "USDC") as "USDC",
			fromAgentId: payload.payload.from ?? "anonymous",
		};

		await this.handlePaymentProof(proof, taskId, contextId, eventBus);
	}

	// ===================================================================
	// Helpers
	// ===================================================================

	/**
	 * Extract x402 payment payload from message metadata (Standalone Flow).
	 */
	private extractX402PaymentPayload(userMessage: Message): X402PaymentPayload | null {
		const metadata = userMessage.metadata;
		if (!metadata) return null;

		const status = metadata[X402_METADATA_KEYS.STATUS];
		if (status !== "payment-submitted") return null;

		const payload = metadata[X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload | undefined;
		if (!payload?.payload?.txHash) return null;

		return payload;
	}

	/**
	 * Extract challengeId and other info from the x402 payment payload.
	 * The challengeId may be in payload.payload.challengeId or in the original
	 * payment requirements extra data.
	 */
	private findChallengeInfoFromPayload(payload: X402PaymentPayload): Record<string, unknown> {
		const inner = payload.payload as Record<string, unknown>;
		return {
			challengeId: inner["challengeId"] ?? inner["challenge_id"],
			requestId: inner["requestId"] ?? inner["request_id"] ?? "",
			amount: inner["amount"],
			asset: inner["asset"],
			chainId: inner["chainId"] ?? inner["chain_id"],
		};
	}

	/**
	 * Parse message payload from either data part or text part (JSON string).
	 */
	private parseMessage(userMessage: Message): Record<string, unknown> | null {
		let dataPart = userMessage.parts?.find((p: any) => p.kind === "data");

		// If no data part, try to parse from text parts
		if (!dataPart && userMessage.parts) {
			const textPart = userMessage.parts.find((p: any) => p.kind === "text");
			if (textPart) {
				try {
					const parsed = JSON.parse((textPart as any).text);
					dataPart = { kind: "data", data: parsed };
				} catch {
					return null;
				}
			}
		}

		if (!dataPart) {
			return null;
		}

		return (dataPart as any).data as Record<string, unknown>;
	}

	/**
	 * Send an error as a Task with a failed/rejected state.
	 */
	private sendErrorTask(
		eventBus: ExecutionEventBus,
		taskId: string,
		contextId: string,
		state: "failed" | "rejected",
		errorCode: string,
		errorMessage: string,
		errorData?: Record<string, unknown>,
	): void {
		const isPaymentError =
			errorCode.startsWith("PAYMENT_") ||
			errorCode === "TX_ALREADY_REDEEMED" ||
			errorCode === "TX_UNCONFIRMED" ||
			errorCode === "INVALID_PROOF";

		const parts: Array<
			{ kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> }
		> = [{ kind: "text", text: errorMessage }];
		if (errorData) {
			parts.push({ kind: "data", data: errorData });
		}

		const statusMessage: Record<string, unknown> = {
			kind: "message",
			messageId: uuidv4(),
			role: "agent",
			parts,
		};

		if (isPaymentError) {
			statusMessage["metadata"] = {
				[X402_METADATA_KEYS.STATUS]: "payment-failed",
				[X402_METADATA_KEYS.ERROR]: errorCode,
			};
		}

		const task: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: {
				state,
				timestamp: new Date().toISOString(),
				message: statusMessage as any,
			},
		};

		eventBus.publish(task);
	}

	private isAccessRequest(data: Record<string, unknown>): boolean {
		return typeof data["requestId"] === "string" && typeof data["tierId"] === "string";
	}

	private isPaymentProof(data: Record<string, unknown>): boolean {
		return (
			typeof data["challengeId"] === "string" &&
			typeof data["txHash"] === "string" &&
			typeof data["chainId"] === "number"
		);
	}
}
