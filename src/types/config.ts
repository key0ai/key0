import type { AccessGrant } from "./challenge.js";

export type NetworkName = "mainnet" | "testnet";

export type TokenIssuanceResult = {
	readonly token: string;
	readonly expiresAt: Date;
	readonly tokenType?: string; // Default "Bearer"
};

export type IssueTokenParams = {
	readonly requestId: string;
	readonly challengeId: string;
	readonly resourceId: string;
	readonly tierId: string;
	readonly txHash: string;
};

export type NetworkConfig = {
	readonly name: NetworkName;
	readonly chainId: number;
	readonly rpcUrl: string;
	readonly usdcAddress: `0x${string}`;
	readonly facilitatorUrl: string;
	readonly explorerBaseUrl: string;
};

export type ProductTier = {
	readonly tierId: string;
	readonly label: string;
	readonly amount: string; // "$0.10"
	readonly resourceType: string; // "photo" | "report" | "api-call"
	readonly accessDurationSeconds?: number; // undefined = single-use
};

export type ResourceVerifier = (resourceId: string, tierId: string) => Promise<boolean>;

export type SellerConfig = {
	// Identity
	readonly agentName: string;
	readonly agentDescription: string;
	readonly agentUrl: string;
	readonly providerName: string;
	readonly providerUrl: string;
	readonly version?: string; // defaults to "1.0.0"

	// Payment
	readonly walletAddress: `0x${string}`;
	readonly network: NetworkName;

	// Product catalog
	readonly products: readonly ProductTier[];

	// Access token
	readonly accessTokenSecret: string;
	readonly accessTokenTTLSeconds?: number; // defaults to 3600

	// Challenge
	readonly challengeTTLSeconds?: number; // defaults to 900

	// Resource verification callback
	readonly onVerifyResource: ResourceVerifier;
	readonly resourceVerifyTimeoutMs?: number; // defaults to 5000

	// Lifecycle hooks (optional)
	readonly onPaymentReceived?: (grant: AccessGrant) => Promise<void>;
	readonly onChallengeExpired?: (challengeId: string) => Promise<void>;

	// Token issuance mode
	/**
	 * How access tokens are generated.
	 * - "native": AgentGate generates a JWT (default).
	 * - "remote": AgentGate calls your backend to get a custom token/key.
	 */
	readonly tokenMode?: "native" | "remote";

	/**
	 * Only used if tokenMode="remote".
	 * A callback that returns the token string from your backend.
	 */
	readonly onIssueToken?: (params: IssueTokenParams) => Promise<TokenIssuanceResult>;

	// Customization
	readonly basePath?: string; // defaults to "/a2a"
	readonly resourceEndpointTemplate?: string; // e.g. "https://api.example.com/photos/{resourceId}"
};
