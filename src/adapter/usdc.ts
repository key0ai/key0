import { USDC_DECIMALS } from "../types/index.js";

export const USDC_TRANSFER_EVENT_SIGNATURE =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

// Minimal ABI: only Transfer event + balanceOf for balance checks
export const USDC_ABI = [
	{
		type: "event",
		name: "Transfer",
		inputs: [
			{ name: "from", type: "address", indexed: true },
			{ name: "to", type: "address", indexed: true },
			{ name: "value", type: "uint256", indexed: false },
		],
	},
	{
		type: "function",
		name: "balanceOf",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "transfer",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "transferWithAuthorization",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;

/**
 * Convert a "$X.XX" string to USDC micro-units (bigint).
 * "$0.10" → 100000n
 * "$1.00" → 1000000n
 */
export function parseDollarToUsdcMicro(amount: string): bigint {
	const cleaned = amount.replace("$", "").trim();
	const parts = cleaned.split(".");
	const whole = BigInt(parts[0] ?? "0");
	const fracStr = (parts[1] ?? "").padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
	const frac = BigInt(fracStr);
	return whole * BigInt(10 ** USDC_DECIMALS) + frac;
}
