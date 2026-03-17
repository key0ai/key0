/**
 * Pre-flight wallet balance check and top-up.
 *
 * Checks USDC and ETH balances for all test wallets.  If the KEY0 wallet USDC
 * balance is below the minimum required to run the full suite, it transfers
 * USDC from the CLIENT wallet to cover the deficit.
 *
 * Run before the e2e test suite to prevent REFUND_FAILED failures caused by an
 * empty KEY0 wallet.
 *
 * Exit codes:
 *   0  All balances OK (or top-up succeeded)
 *   1  A balance is critically low and could not be topped up — abort CI
 */

import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { USDC_ADDRESS } from "./fixtures/constants.ts";

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Minimum USDC the KEY0 wallet must hold before the suite runs.
 * Covers: refund-success ($0.01) + refund-batch (3×$0.01 = $0.03) + buffer.
 */
const KEY0_MIN_USDC = parseUnits("0.10", 6); // $0.10

/**
 * Amount to transfer to KEY0 wallet if it falls below the minimum.
 * Enough for ~10 full suite runs.
 */
const KEY0_TOPUP_USDC = parseUnits("0.50", 6); // $0.50

/**
 * Minimum USDC the CLIENT wallet must hold to make purchases.
 * Suite purchases: ~$0.80 per run (happy-path, double-spend, concurrent, etc.)
 */
const CLIENT_MIN_USDC = parseUnits("1.00", 6); // $1.00

/** Minimum ETH (wei) for gas — warns if below but doesn't abort. */
const MIN_ETH_WEI = parseUnits("0.002", 18); // 0.002 ETH

// ─── Minimal ERC-20 ABI ───────────────────────────────────────────────────────

const ERC20_ABI = [
	{
		name: "balanceOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		name: "transfer",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`Missing required env var: ${name}`);
	return val;
}

function fmt(raw: bigint): string {
	return `$${formatUnits(raw, 6)} USDC`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const rpcUrl = process.env["ALCHEMY_BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";

const clientKey = requireEnv("CLIENT_WALLET_PRIVATE_KEY") as `0x${string}`;
const key0Key = requireEnv("KEY0_WALLET_KEY") as `0x${string}`;

const clientAccount = privateKeyToAccount(clientKey);
const key0Account = privateKeyToAccount(key0Key);
const gasWalletAddress = requireEnv("GAS_WALLET_ADDRESS") as `0x${string}`;
const key0Address = key0Account.address;

const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const clientWallet = createWalletClient({ chain: baseSepolia, transport, account: clientAccount });

async function getUsdc(address: `0x${string}`): Promise<bigint> {
	return publicClient.readContract({
		address: USDC_ADDRESS,
		abi: ERC20_ABI,
		functionName: "balanceOf",
		args: [address],
	});
}

async function getEth(address: `0x${string}`): Promise<bigint> {
	return publicClient.getBalance({ address });
}

console.log("─── Pre-flight wallet check ───────────────────────────────");

// Read all balances in parallel
const [clientUsdc, clientEth, key0Usdc, key0Eth, gasEth] = await Promise.all([
	getUsdc(clientAccount.address),
	getEth(clientAccount.address),
	getUsdc(key0Address),
	getEth(key0Address),
	getEth(gasWalletAddress),
]);

console.log(
	`CLIENT  ${clientAccount.address}  USDC: ${fmt(clientUsdc)}  ETH: ${formatUnits(clientEth, 18)}`,
);
console.log(`KEY0    ${key0Address}  USDC: ${fmt(key0Usdc)}  ETH: ${formatUnits(key0Eth, 18)}`);
console.log(`GAS     ${gasWalletAddress}  ETH: ${formatUnits(gasEth, 18)}`);
console.log("───────────────────────────────────────────────────────────");

let failed = false;

// ── ETH gas warnings ─────────────────────────────────────────────────────────
for (const [name, bal] of [
	["CLIENT", clientEth],
	["KEY0", key0Eth],
	["GAS", gasEth],
] as const) {
	if (bal < MIN_ETH_WEI) {
		console.warn(`⚠  ${name} ETH balance low (${formatUnits(bal, 18)} ETH) — may fail on gas`);
	}
}

// ── CLIENT USDC check ────────────────────────────────────────────────────────
if (clientUsdc < CLIENT_MIN_USDC) {
	console.error(
		`✗  CLIENT USDC too low (${fmt(clientUsdc)}, need ${fmt(CLIENT_MIN_USDC)}) — top up via https://faucet.circle.com`,
	);
	failed = true;
}

// ── KEY0 USDC top-up ─────────────────────────────────────────────────────────
if (key0Usdc < KEY0_MIN_USDC) {
	const topUp = KEY0_TOPUP_USDC - key0Usdc;
	console.log(
		`⬆  KEY0 USDC low (${fmt(key0Usdc)}), topping up ${fmt(topUp)} from CLIENT wallet...`,
	);

	if (clientUsdc < topUp) {
		console.error(
			`✗  CLIENT wallet doesn't have enough USDC to top up KEY0 (have ${fmt(clientUsdc)}, need ${fmt(topUp)})`,
		);
		failed = true;
	} else {
		try {
			const hash = await clientWallet.writeContract({
				address: USDC_ADDRESS,
				abi: ERC20_ABI,
				functionName: "transfer",
				args: [key0Address, topUp],
			});
			console.log(`   tx: ${hash}`);
			const receipt = await publicClient.waitForTransactionReceipt({ hash });
			if (receipt.status !== "success") throw new Error("transfer reverted");
			const newBal = await getUsdc(key0Address);
			console.log(`✓  KEY0 USDC after top-up: ${fmt(newBal)}`);
		} catch (err) {
			console.error(`✗  Top-up failed: ${err instanceof Error ? err.message : String(err)}`);
			failed = true;
		}
	}
} else {
	console.log(`✓  KEY0 USDC OK (${fmt(key0Usdc)})`);
}

console.log("───────────────────────────────────────────────────────────");

if (failed) {
	console.error("Pre-flight failed — aborting test run.");
	process.exit(1);
}

console.log("Pre-flight passed.");
