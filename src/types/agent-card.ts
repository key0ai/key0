export type PaymentProtocol = "x402" | "stripe" | "lightning";

/** Standard A2A AgentSkill fields plus inputSchema for machine-readable request contracts. */
export type AgentSkill = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly examples?: readonly string[];
	readonly inputModes?: readonly string[];
	readonly outputModes?: readonly string[];
	readonly security?: Record<string, string[]>;
	/** JSON Schema describing the request body. Not part of the A2A spec but widely supported as an additive extension — standard clients ignore it. */
	readonly inputSchema?: Record<string, unknown>;
};

export type AgentInterface = {
	readonly url: string;
	readonly transport: "JSONRPC" | "HTTP+JSON" | "GRPC";
};

export type AgentExtension = {
	readonly uri: string;
	readonly description?: string;
	readonly required?: boolean;
	readonly params?: Record<string, unknown>;
};

export type AgentCard = {
	readonly name: string;
	readonly description: string;
	readonly url: string;
	readonly version: string;
	readonly protocolVersion: string;
	readonly capabilities: {
		readonly extensions?: readonly AgentExtension[];
		readonly pushNotifications?: boolean;
		readonly streaming?: boolean;
		readonly stateTransitionHistory?: boolean;
	};
	readonly defaultInputModes: readonly string[];
	readonly defaultOutputModes: readonly string[];
	readonly skills: readonly AgentSkill[];
	readonly provider?: {
		readonly organization: string;
		readonly url: string;
	};
	readonly additionalInterfaces?: readonly AgentInterface[];
};
