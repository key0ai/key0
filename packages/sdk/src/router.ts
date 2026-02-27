import { ChallengeEngine, buildAgentCard } from "@agentgate/core";
import {
  AgentGateError,
  type A2AMessagePart,
  type A2ATaskSendRequest,
  type A2ATaskStatus,
  type AccessRequest,
  type AgentCard,
  type PaymentProof,
  type SellerConfig,
} from "@agentgate/types";

export type AgentGateRouterDeps = {
  readonly engine: ChallengeEngine;
  readonly config: SellerConfig;
};

export type RouteResult = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

export class AgentGateRouter {
  private readonly engine: ChallengeEngine;
  private readonly agentCard: AgentCard;

  constructor(deps: AgentGateRouterDeps) {
    this.engine = deps.engine;
    this.agentCard = buildAgentCard(deps.config);
  }

  async handleAgentCard(): Promise<RouteResult> {
    return {
      status: 200,
      body: this.agentCard,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    };
  }

  async handleA2ATask(request: A2ATaskSendRequest): Promise<RouteResult> {
    const taskId = request.params.id;
    const parts = request.params.message.parts;

    // Extract the data part
    const dataPart = parts.find(
      (p: A2AMessagePart): p is Extract<A2AMessagePart, { type: "data" }> => p.type === "data",
    );

    if (!dataPart) {
      return {
        status: 400,
        body: this.errorResponse(request.id, taskId, "No data part in message"),
      };
    }

    const payload = dataPart.data;

    try {
      // Route by type field
      if (payload["type"] === "AccessRequest" || this.isAccessRequest(payload)) {
        const challenge = await this.engine.requestAccess(payload as unknown as AccessRequest);
        return {
          status: 200,
          body: this.taskResponse(request.id, taskId, "completed", challenge),
        };
      }

      if (payload["type"] === "PaymentProof" || this.isPaymentProof(payload)) {
        const grant = await this.engine.submitProof(payload as unknown as PaymentProof);
        return {
          status: 200,
          body: this.taskResponse(request.id, taskId, "completed", grant),
        };
      }

      return {
        status: 400,
        body: this.errorResponse(request.id, taskId, "Unknown message type"),
      };
    } catch (err: unknown) {
      if (err instanceof AgentGateError) {
        // PROOF_ALREADY_REDEEMED with grant is a "success" response
        if (err.code === "PROOF_ALREADY_REDEEMED" && err.details?.["grant"]) {
          return {
            status: 200,
            body: this.taskResponse(request.id, taskId, "completed", err.details["grant"]),
          };
        }

        return {
          status: err.httpStatus,
          body: this.errorTaskResponse(request.id, taskId, err),
        };
      }

      return {
        status: 500,
        body: this.errorResponse(request.id, taskId, "Internal error"),
      };
    }
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

  private taskResponse(
    rpcId: string | number,
    taskId: string,
    state: A2ATaskStatus,
    data: unknown,
  ) {
    return {
      jsonrpc: "2.0" as const,
      id: rpcId,
      result: {
        id: taskId,
        status: {
          state,
          message: {
            role: "agent" as const,
            parts: [
              {
                type: "data" as const,
                data,
                mimeType: "application/json" as const,
              },
            ],
          },
        },
      },
    };
  }

  private errorResponse(rpcId: string | number, taskId: string, message: string) {
    return {
      jsonrpc: "2.0" as const,
      id: rpcId,
      result: {
        id: taskId,
        status: {
          state: "failed" as const,
          message: {
            role: "agent" as const,
            parts: [{ type: "text" as const, text: message }],
          },
        },
      },
    };
  }

  private errorTaskResponse(
    rpcId: string | number,
    taskId: string,
    err: AgentGateError,
  ) {
    return {
      jsonrpc: "2.0" as const,
      id: rpcId,
      result: {
        id: taskId,
        status: {
          state: "failed" as const,
          message: {
            role: "agent" as const,
            parts: [
              {
                type: "data" as const,
                data: err.toJSON(),
                mimeType: "application/json" as const,
              },
            ],
          },
        },
      },
    };
  }
}
