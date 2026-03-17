/**
 * Pre-flight wallet balance check and top-up.
 *
 * Checks USDC and ETH balances for all test wallets.  Tops up any wallet
 * whose USDC balance falls below the minimum required to run the full suite:
 *
 *   CLIENT wallet — must have ≥ $1.00 USDC to fund all test purchases.
 *   KEY0 wallet   — must have ≥ $0.10 USDC for refund tests (cron sends USDC
 *                   FROM KEY0 back to the payer).
 *   GAS wallet    — must have ≥ $0.20 USDC because concurrent-purchases.test.ts
 *                   uses the GAS wallet as a second buyer (makeGasE2eClient).
 *                   Without USDC the transferWithAuthorization reverts, leaving
 *                   clientA's settlement in-flight which blocks the gas wallet
 *                   lock and cascades into refund failures.
 *
 * Run before the e2e test suite to prevent spurious failures caused by
 * depleted wallets.
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
 * Minimum USDC the GAS wallet must hold to participate as a buyer in
 * concurrent-purchases.test.ts (makeGasE2eClient — second concurrent buyer).
 * One purchase costs $0.10; we keep a small buffer.
 */
const GAS_MIN_USDC = parseUnits("0.20", 6); // $0.20

/**
 * Amount to transfer to GAS wallet if it falls below the minimum.
 */
const GAS_TOPUP_USDC = parseUnits("0.50", 6); // $0.50

/**
 * Minimum USDC the CLIENT wallet must hold to make purchases.
 * Suite purchases: ~$0.80 per run (happy-path, double-spend, concurrent, etc.)
 * This check runs BEFORE any top-ups so the threshold must account for
 * potential transfers to KEY0 and GAS wallets.
 */
const CLIENT_MIN_USDC = parseUnits("2.00", 6); // $2.00 (covers top-ups + suite)

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
const gasWalletAddress = requireEnv("GAS_WALLET_ADDRESS") as `0x${string}`;

const clientAccount = privateKeyToAccount(clientKey);
const key0Account = privateKeyToAccount(key0Key);
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

async function topUp(
	label: string,
	destination: `0x${string}`,
	currentBalance: bigint,
	targetBalance: bigint,
): Promise<boolean> {
	const topUpAmount = targetBalance - currentBalance;
	console.log(
		`⬆  ${label} USDC low (${fmt(currentBalance)}), topping up ${fmt(topUpAmount)} from CLIENT wallet...`,
	);

	const currentClientUsdc = await getUsdc(clientAccount.address);
	if (currentClientUsdc < topUpAmount) {
		console.error(
			`✗  CLIENT wallet doesn't have enough USDC to top up ${label} (have ${fmt(currentClientUsdc)}, need ${fmt(topUpAmount)})`,
		);
		return false;
	}

	try {
		const hash = await clientWallet.writeContract({
			address: USDC_ADDRESS,
			abi: ERC20_ABI,
			functionName: "transfer",
			args: [destination, topUpAmount],
		});
		console.log(`   tx: ${hash}`);
		const receipt = await publicClient.waitForTransactionReceipt({ hash });
		if (receipt.status !== "success") throw new Error("transfer reverted");
		const newBal = await getUsdc(destination);
		console.log(`✓  ${label} USDC after top-up: ${fmt(newBal)}`);
		return true;
	} catch (err) {
		console.error(`✗  Top-up failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

console.log("─── Pre-flight wallet check ───────────────────────────────");

// Read all balances in parallel
const [clientUsdc, clientEth, key0Usdc, key0Eth, gasUsdc, gasEth] = await Promise.all([
	getUsdc(clientAccount.address),
	getEth(clientAccount.address),
	getUsdc(key0Address),
	getEth(key0Address),
	getUsdc(gasWalletAddress),
	getEth(gasWalletAddress),
]);

console.log(
	`CLIENT  ${clientAccount.address}  USDC: ${fmt(clientUsdc)}  ETH: ${formatUnits(clientEth, 18)}`,
);
console.log(`KEY0    ${key0Address}  USDC: ${fmt(key0Usdc)}  ETH: ${formatUnits(key0Eth, 18)}`);
console.log(`GAS     ${gasWalletAddress}  USDC: ${fmt(gasUsdc)}  ETH: ${formatUnits(gasEth, 18)}`);
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

// ── CLIENT USDC check (must run first — it funds all top-ups) ────────────────
if (clientUsdc < CLIENT_MIN_USDC) {
	console.error(
		`✗  CLIENT USDC too low (${fmt(clientUsdc)}, need ${fmt(CLIENT_MIN_USDC)}) — top up via https://faucet.circle.com`,
	);
	failed = true;
}

// ── KEY0 USDC top-up ─────────────────────────────────────────────────────────
if (key0Usdc < KEY0_MIN_USDC) {
	const ok = await topUp("KEY0", key0Address, key0Usdc, KEY0_TOPUP_USDC);
	if (!ok) failed = true;
} else {
	console.log(`✓  KEY0 USDC OK (${fmt(key0Usdc)})`);
}

// ── GAS USDC top-up ──────────────────────────────────────────────────────────
if (gasUsdc < GAS_MIN_USDC) {
	const ok = await topUp("GAS", gasWalletAddress, gasUsdc, GAS_TOPUP_USDC);
	if (!ok) failed = true;
} else {
	console.log(`✓  GAS USDC OK (${fmt(gasUsdc)})`);
}

console.log("───────────────────────────────────────────────────────────");

if (failed) {
	console.error("Pre-flight failed — aborting test run.");
	process.exit(1);
}

console.log("Pre-flight passed.");
