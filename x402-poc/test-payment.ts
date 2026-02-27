/**
 * x402 Payment Test — Base Sepolia Testnet
 *
 * Reads wallet credentials from .env:
 *   WALLET_A_KEY     — sender private key  (required)
 *   WALLET_B_ADDRESS — receiver address    (required)
 *   SEND_AMOUNT      — USDC amount, e.g. "1"  (optional, default "1")
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const USDC_DECIMALS = 6;

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

function separator(label: string) {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function usdc(raw: bigint) { return `${formatUnits(raw, USDC_DECIMALS)} USDC`; }
function eth(raw: bigint)  { return `${formatUnits(raw, 18)} ETH`; }

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         x402 Payment Test — Base Sepolia Testnet        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ── Load from .env ─────────────────────────────────────────────────────────
  separator("Step 1 · Wallets");

  const keyA     = process.env.WALLET_A_KEY as `0x${string}` | undefined;
  const addressB = process.env.WALLET_B_ADDRESS as `0x${string}` | undefined;

  if (!keyA)     { console.error("  WALLET_A_KEY is required in .env");     process.exit(1); }
  if (!addressB) { console.error("  WALLET_B_ADDRESS is required in .env"); process.exit(1); }

  const sendAmount = process.env.SEND_AMOUNT ?? "1";
  const accountA = privateKeyToAccount(keyA);

  console.log("\n  Wallet A  (sender)");
  console.log(`    address : ${accountA.address}`);
  console.log("\n  Wallet B  (receiver)");
  console.log(`    address : ${addressB}`);
  console.log(`\n  Amount   : ${sendAmount} USDC`);

  // ── Connect ────────────────────────────────────────────────────────────────
  separator("Step 2 · Connect to Base Sepolia");

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  const walletClientA = createWalletClient({
    account: accountA,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  const chainId = await publicClient.getChainId();
  console.log(`\n  Chain ID : ${chainId}  (Base Sepolia = 84532)`);
  console.log(`  Explorer : https://sepolia.basescan.org`);

  // ── Balances before ────────────────────────────────────────────────────────
  separator("Step 3 · Initial Balances");

  const [usdcA_before, usdcB_before, ethA_before] = await Promise.all([
    publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [accountA.address] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [addressB] }),
    publicClient.getBalance({ address: accountA.address }),
  ]);

  console.log(`\n  Wallet A  USDC: ${usdc(usdcA_before)}  ETH: ${eth(ethA_before)}`);
  console.log(`  Wallet B  USDC: ${usdc(usdcB_before)}`);

  if (usdcA_before === 0n) {
    console.log("\n  ✗ Wallet A has no USDC.");
    console.log(`    USDC faucet → https://faucet.circle.com  (Base Sepolia)`);
    console.log(`    Deposit to  → ${accountA.address}`);
    process.exit(0);
  }
  if (ethA_before === 0n) {
    console.log("\n  ✗ Wallet A has no ETH for gas.");
    console.log(`    ETH faucet → https://www.alchemy.com/faucets/base-sepolia`);
    console.log(`    Deposit to → ${accountA.address}`);
    process.exit(0);
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  separator("Step 4 · Send USDC  (A → B)");

  const amount = parseUnits(sendAmount, USDC_DECIMALS);
  console.log(`\n  Sending ${sendAmount} USDC  (${amount} micro-USDC)`);

  const txHash = await walletClientA.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [addressB, amount],
  });

  console.log(`\n  tx hash  : ${txHash}`);
  console.log(`  explorer : https://sepolia.basescan.org/tx/${txHash}`);

  // ── Receipt ────────────────────────────────────────────────────────────────
  separator("Step 5 · Transaction Receipt");

  console.log("\n  Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log("\n  " + JSON.stringify({
    status:          receipt.status,
    blockNumber:     receipt.blockNumber.toString(),
    transactionHash: receipt.transactionHash,
    from:            receipt.from,
    gasUsed:         receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
  }, null, 4).replace(/\n/g, "\n  "));

  // ── Verify Transfer event ──────────────────────────────────────────────────
  separator("Step 6 · On-Chain Verification");

  const transferLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER_TOPIC,
  );

  if (!transferLog) { console.error("  ✗ No USDC Transfer event found."); process.exit(1); }

  const decoded = decodeEventLog({ abi: ERC20_ABI, data: transferLog.data, topics: transferLog.topics, eventName: "Transfer" });

  console.log("\n  Transfer event:");
  console.log(`    from  : ${decoded.args.from}`);
  console.log(`    to    : ${decoded.args.to}`);
  console.log(`    value : ${usdc(decoded.args.value)}`);

  const checks = {
    status_success:      receipt.status === "success",
    usdc_contract_match: transferLog.address.toLowerCase() === USDC_ADDRESS.toLowerCase(),
    recipient_match:     decoded.args.to.toLowerCase() === addressB.toLowerCase(),
    sender_match:        decoded.args.from.toLowerCase() === accountA.address.toLowerCase(),
    amount_match:        decoded.args.value === amount,
  };

  console.log("\n  Checks:");
  for (const [k, v] of Object.entries(checks)) console.log(`    ${v ? "✓" : "✗"}  ${k}`);
  console.log(`\n  Result: ${Object.values(checks).every(Boolean) ? "✓ VERIFIED" : "✗ FAILED"}`);

  // ── Balances after ─────────────────────────────────────────────────────────
  separator("Step 7 · Final Balances");

  const [usdcA_after, usdcB_after, ethA_after] = await Promise.all([
    publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [accountA.address] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [addressB] }),
    publicClient.getBalance({ address: accountA.address }),
  ]);

  console.log(`\n  Wallet A  USDC: ${usdc(usdcA_after)}  (was ${usdc(usdcA_before)}, -${usdc(usdcA_before - usdcA_after)})`);
  console.log(`            ETH:  ${eth(ethA_after)}  (was ${eth(ethA_before)}, gas: ${eth(ethA_before - ethA_after)})`);
  console.log(`  Wallet B  USDC: ${usdc(usdcB_after)}  (was ${usdc(usdcB_before)}, +${usdc(usdcB_after - usdcB_before)})`);

  console.log(`\n  Wallet A → https://sepolia.basescan.org/address/${accountA.address}`);
  console.log(`  Wallet B → https://sepolia.basescan.org/address/${addressB}`);
  console.log(`  Tx       → https://sepolia.basescan.org/tx/${txHash}`);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                      Done ✓                             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

main().catch((e) => { console.error("\n[Fatal]", e.message); process.exit(1); });
