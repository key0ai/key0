import type { Message, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { ChallengeEngine } from "./core/index.js";
import type { AccessGrant, AccessRequest, NetworkConfig, SellerConfig, X402PaymentPayload } from "./types/index.js";
import { AgentGateError, X402_METADATA_KEYS, CHAIN_CONFIGS } from "./types/index.js";
import { settlePayment } from "./integrations/settlement.js";
import { v4 as uuidv4 } from "uuid";

export class AgentGateExecutor implements AgentExecutor {
	private readonly config: SellerConfig;
	private readonly networkConfig: NetworkConfig;

	constructor(private engine: ChallengeEngine, config: SellerConfig) {
		this.config = config;
		this.networkConfig = CHAIN_CONFIGS[config.network];
	}

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
					`No data part found in message. Available parts: [${partsInfo}]. Expected a part with kind="data" containing type="AccessRequest", or x402 payment metadata.`,
				);
				return;
			}

			// ----- Route by type -----
			if (payload["type"] === "AccessRequest" || this.isAccessRequest(payload)) {
				await this.handleAccessRequest(payload as unknown as AccessRequest, taskId, contextId, eventBus);
			} else {
				this.sendErrorTask(
					eventBus,
					taskId,
					contextId,
					"failed",
					"Unknown message type",
					`Unsupported message type: "${payload["type"]}". Expected type="AccessRequest" with tierId and requestId.`,
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
	// Handler: x402 Payment Payload (via message.metadata)
	// Emits intermediate A2A task states: submitted → verified → completed
	// ===================================================================

	private async handleX402PaymentSubmission(
		payload: X402PaymentPayload,
		taskId: string,
		contextId: string,
		eventBus: ExecutionEventBus,
	): Promise<void> {
		// 1. Extract challengeId + context from the echoed payment requirements
		const extra = (payload.accepted?.extra ?? {}) as Record<string, unknown>;
		const challengeId = extra["challengeId"] as string | undefined;

		if (!challengeId) {
			throw new AgentGateError(
				"INVALID_REQUEST",
				"Payment payload missing challengeId in accepted.extra. Include the full accepted requirements echoed from the payment-required response.",
				400,
			);
		}

		// 2. Look up the challenge record to get tierId, resourceId, requestId
		const record = await this.engine.getChallengeRecord(challengeId);
		if (!record) {
			throw new AgentGateError(
				"CHALLENGE_NOT_FOUND",
				`Challenge "${challengeId}" not found or has expired. Please start a new AccessRequest.`,
				404,
			);
		}

		const { tierId, resourceId, requestId } = record;

		// 3. Emit payment-submitted (working state)
		this.publishWorkingTask(
			eventBus,
			taskId,
			contextId,
			"payment-submitted",
			"Payment received. Verifying on-chain...",
		);

		// 4. Settle the payment via shared settlement layer
		let txHash: `0x${string}`;
		let payer: string | undefined;

		try {
			const result = await settlePayment(payload, this.config, this.networkConfig);
			txHash = result.txHash;
			payer = result.payer;
		} catch (err: unknown) {
			// Emit payment-failed and re-throw so outer catch sends the error task
			this.publishWorkingTask(
				eventBus,
				taskId,
				contextId,
				"payment-failed",
				err instanceof AgentGateError ? err.message : "Payment settlement failed",
			);
			throw err;
		}

		// 5. Emit payment-verified (working state)
		this.publishWorkingTask(
			eventBus,
			taskId,
			contextId,
			"payment-verified",
			`Payment verified (tx: ${txHash}). Issuing access token...`,
		);

		// 6. Issue access grant via the engine
		const grant: AccessGrant = await this.engine.processHttpPayment(
			requestId,
			tierId,
			resourceId,
			txHash,
			payer as `0x${string}` | undefined,
		);

		// 7. Build receipt
		const receipt = this.engine.buildX402Receipt(record, grant);

		// 8. Emit payment-completed (final completed state)
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
	// Helpers
	// ===================================================================

	/**
	 * Extract x402 payment payload from message metadata.
	 * A2A clients submit payment by sending message.metadata["x402.payment.status"] = "payment-submitted"
	 * with the full X402PaymentPayload in message.metadata["x402.payment.payload"].
	 */
	private extractX402PaymentPayload(userMessage: Message): X402PaymentPayload | null {
		const metadata = userMessage.metadata;
		if (!metadata) return null;

		const status = metadata[X402_METADATA_KEYS.STATUS];
		if (status !== "payment-submitted") return null;

		const payload = metadata[X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload | undefined;
		// Valid payload must have an EIP-3009 signature
		if (!payload?.payload?.signature) return null;

		return payload;
	}

	/**
	 * Parse message payload from either data part or text part (JSON string).
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
					dataPart = { kind: "data", data: parsed };
				} catch {
					return null;
				}
			}
		}

		if (!dataPart) {
			return null;
		}

		// biome-ignore lint/suspicious/noExplicitAny: library type issue
		return (dataPart as any).data as Record<string, unknown>;
	}

	/**
	 * Publish a working task with an x402 payment status.
	 * Used for intermediate states during payment processing.
	 */
	private publishWorkingTask(
		eventBus: ExecutionEventBus,
		taskId: string,
		contextId: string,
		status: string,
		text: string,
	): void {
		const task: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: {
				state: "working",
				timestamp: new Date().toISOString(),
				message: {
					kind: "message",
					messageId: uuidv4(),
					role: "agent",
					parts: [{ kind: "text", text }],
					metadata: {
						[X402_METADATA_KEYS.STATUS]: status,
					},
				} as any,
			},
		};
		eventBus.publish(task);
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

		const parts: Array<{ kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> }> = [
			{ kind: "text", text: errorMessage },
		];
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
}
