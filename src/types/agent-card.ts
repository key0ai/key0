export type PaymentProtocol = "x402" | "stripe" | "lightning";

/**
 * A2A AgentSkill with Key0 extensions.
 *
 * Standard A2A fields: id, name, description, tags, examples, inputModes, outputModes, security.
 * Key0 extensions: endpoint, inputSchema, workflow — these provide machine-readable
 * metadata for automated agent clients.
 */
export type AgentSkill = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly examples?: readonly string[];
	readonly inputModes?: readonly string[];
	readonly outputModes?: readonly string[];
	readonly security?: Record<string, string[]>;
	/** @key0 Direct endpoint URL and HTTP method for this skill. */
	readonly endpoint?: { readonly url: string; readonly method: "GET" | "POST" };
	/** @key0 JSON Schema for the skill's input parameters. */
	readonly inputSchema?: Record<string, unknown>;
	/** @key0 Step-by-step workflow instructions for automated clients. */
	readonly workflow?: readonly string[];
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
