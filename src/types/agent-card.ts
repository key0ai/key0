export type PaymentProtocol = "x402" | "stripe" | "lightning";

export type SkillPricing = {
	readonly tierId: string;
	readonly label: string;
	readonly amount: string; // "$0.10" — human-readable USD, settled as USDC
	readonly asset: "USDC";
	readonly chainId: number; // 8453 (Base) or 84532 (Base Sepolia)
	readonly walletAddress: `0x${string}`;
};

export type AgentSkillInputSchema = {
	readonly type: "object";
	readonly properties: Record<
		string,
		{
			readonly type: string;
			readonly description?: string;
		}
	>;
	readonly required?: readonly string[];
};

export type AgentSkill = {
	readonly id: string; // "request-access" | "submit-proof"
	readonly name: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly examples?: readonly string[]; // Example usage of the skill
	readonly inputSchema: AgentSkillInputSchema;
	readonly outputSchema: AgentSkillInputSchema;
	readonly pricing?: readonly SkillPricing[];
	readonly url?: string; // Direct HTTP POST endpoint for this skill
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
