/**
 * E2eTestClient: drives the Key0 Docker payment flow.
 *
 * Payment flow (EIP-3009 off-chain authorization, gas wallet settlement):
 *   1. POST /x402/access                     → HTTP 402 with challengeId + payment requirements
 *   2. signTypedData(TransferWithAuth)        → EIP-3009 off-chain authorization signature
 *   3. POST /x402/access + PAYMENT-SIGNATURE → gas wallet executes transfer, returns AccessGrant
 *   4. GET  /api/resource/:id (Bearer)        → call protected backend API
 */

import { randomBytes } from "node:crypto";
import { formatUnits, type PublicClient, type WalletClient } from "viem";

// ─── Types ─────────────────────────────────────────────────────────────────

export type AgentCard = {
	name: string;
	description: string;
	url: string;
	skills: Array<{
		id: string;
		name?: string;
		pricing?: Array<{
			tierId: string;
			label: string;
			amount: string;
			chainId: number;
		}>;
	}>;
	capabilities: {
		extensions?: Array<{ uri: string; required?: boolean }>;
	};
};

export type ChallengeResponse = {
	challengeId: string;
	paymentRequired: {
		x402Version: number;
		accepts: Array<{
			scheme: string;
			network: string;
			asset: string;
			amount: string;
			payTo: string;
			maxTimeoutSeconds: number;
			extra?: Record<string, unknown>;
		}>;
	};
};

export type AccessGrant = {
	type: "AccessGrant";
	challengeId: string;
	requestId: string;
	accessToken: string;
	tokenType: "Bearer";
	expiresAt: string;
	resourceEndpoint: string;
	resourceId: string;
	tierId: string;
	txHash: `0x${string}`;
	explorerUrl: string;
};

export type EIP3009Auth = {
	signature: `0x${string}`;
	authorization: {
		from: string;
		to: string;
		value: string;
		validAfter: string;
		validBefore: string;
		nonce: `0x${string}`;
	};
};

// ─── EIP-3009 typed data ────────────────────────────────────────────────────

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

// ─── E2eTestClient ──────────────────────────────────────────────────────────

export class E2eTestClient {
	constructor(
		private readonly key0Url: string,
		private readonly walletClient: WalletClient,
		private readonly publicClient: PublicClient,
		private readonly usdcAddress: `0x${string}`,
		private readonly chainId: number,
		private readonly usdcDomain: { name: string; version: string },
	) {}

	get account(): `0x${string}` {
		const acc = this.walletClient.account;
		if (!acc) throw new Error("WalletClient has no account");
		return acc.address;
	}

	// ── Step 1: Request access ────────────────────────────────────────────

	async requestAccess(opts: {
		tierId: string;
		requestId: string;
		resourceId?: string;
	}): Promise<ChallengeResponse> {
		const res = await fetch(`${this.key0Url}/x402/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tierId: opts.tierId,
				requestId: opts.requestId,
				resourceId: opts.resourceId ?? "default",
				clientAgentId: `agent://${this.account}`,
			}),
		});

		if (res.status !== 402) {
			const text = await res.text();
			throw new Error(`Expected HTTP 402, got ${res.status}: ${text}`);
		}

		const body = (await res.json()) as Record<string, unknown>;
		const challengeId = body["challengeId"] as string;

		// Decode PAYMENT-REQUIRED header
		const header = res.headers.get("payment-required");
		if (!header) throw new Error("Missing PAYMENT-REQUIRED header");
		const paymentRequired = JSON.parse(
			Buffer.from(header, "base64").toString("utf-8"),
		) as ChallengeResponse["paymentRequired"];

		return { challengeId, paymentRequired };
	}

	// ── Step 2: Sign EIP-3009 authorization ──────────────────────────────

	async signEIP3009(opts: {
		destination: `0x${string}`;
		/** Amount in token micro-units (e.g., 100000n for $0.10 USDC) */
		amountRaw: bigint;
		/** Override validBefore (seconds). Defaults to now + 300s */
		validBeforeOverride?: bigint;
	}): Promise<EIP3009Auth> {
		const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
		const validAfter = 0n;
		const validBefore = opts.validBeforeOverride ?? BigInt(Math.floor(Date.now() / 1000) + 300);

		const signature = await this.walletClient.signTypedData({
			account: this.walletClient.account!,
			domain: {
				name: this.usdcDomain.name,
				version: this.usdcDomain.version,
				chainId: this.chainId,
				verifyingContract: this.usdcAddress,
			},
			types: TRANSFER_WITH_AUTHORIZATION_TYPES,
			primaryType: "TransferWithAuthorization",
			message: {
				from: this.account,
				to: opts.destination,
				value: opts.amountRaw,
				validAfter,
				validBefore,
				nonce,
			},
		});

		return {
			signature,
			authorization: {
				from: this.account,
				to: opts.destination,
				value: opts.amountRaw.toString(),
				validAfter: validAfter.toString(),
				validBefore: validBefore.toString(),
				nonce,
			},
		};
	}

	// ── Step 3: Submit payment ────────────────────────────────────────────

	async submitPayment(opts: {
		tierId: string;
		requestId: string;
		resourceId?: string;
		auth: EIP3009Auth;
		paymentRequired: ChallengeResponse["paymentRequired"];
	}): Promise<{ grant?: AccessGrant; error?: Record<string, unknown>; status: number }> {
		const requirements = opts.paymentRequired.accepts[0];
		if (!requirements) throw new Error("No accepted payment requirements");

		const paymentPayload = {
			x402Version: 2,
			network: `eip155:${this.chainId}`,
			scheme: "exact",
			payload: {
				signature: opts.auth.signature,
				authorization: opts.auth.authorization,
				from: this.account,
			},
			accepted: requirements,
		};

		const paymentSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

		const res = await fetch(`${this.key0Url}/x402/access`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"payment-signature": paymentSignature,
			},
			body: JSON.stringify({
				tierId: opts.tierId,
				requestId: opts.requestId,
				resourceId: opts.resourceId ?? "default",
				clientAgentId: `agent://${this.account}`,
			}),
		});

		const body = await res.json();
		if (res.ok) {
			return { grant: body as AccessGrant, status: res.status };
		}
		return { error: body as Record<string, unknown>, status: res.status };
	}

	// ── Convenience: full purchase ────────────────────────────────────────

	async purchaseAccess(opts: { tierId: string; requestId?: string; resourceId?: string }): Promise<{
		requestId: string;
		challengeId: string;
		grant: AccessGrant;
	}> {
		const requestId = opts.requestId ?? crypto.randomUUID();
		const { challengeId, paymentRequired } = await this.requestAccess({
			tierId: opts.tierId,
			requestId,
			...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
		});

		const requirements = paymentRequired.accepts[0];
		if (!requirements) throw new Error("No payment requirements");
		const amountRaw = BigInt(requirements.amount);
		const destination = requirements.payTo as `0x${string}`;

		const auth = await this.signEIP3009({ destination, amountRaw });

		const result = await this.submitPayment({
			tierId: opts.tierId,
			requestId,
			...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
			auth,
			paymentRequired,
		});

		if (!result.grant) {
			throw new Error(`Payment failed: ${JSON.stringify(result.error)}`);
		}

		return { requestId, challengeId, grant: result.grant };
	}

	// ── Agent card ────────────────────────────────────────────────────────

	async fetchAgentCard(): Promise<AgentCard> {
		const res = await fetch(`${this.key0Url}/.well-known/agent.json`);
		if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
		return res.json() as Promise<AgentCard>;
	}

	// ── USDC balance ──────────────────────────────────────────────────────

	async getUsdcBalance(): Promise<bigint> {
		const BALANCE_OF_ABI = [
			{
				type: "function",
				name: "balanceOf",
				inputs: [{ name: "account", type: "address" }],
				outputs: [{ name: "", type: "uint256" }],
				stateMutability: "view",
			},
		] as const;

		return this.publicClient.readContract({
			address: this.usdcAddress,
			abi: BALANCE_OF_ABI,
			functionName: "balanceOf",
			args: [this.account],
		}) as Promise<bigint>;
	}

	getUsdcBalanceFormatted(): Promise<string> {
		return this.getUsdcBalance().then((b) => formatUnits(b, 6));
	}
}
