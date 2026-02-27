/**
 * x402 payment test — Base MAINNET
 *
 * ⚠  This uses REAL USDC on Base mainnet. Real money moves.
 *
 * Reads wallet credentials from .env:
 *   WALLET_A_KEY     — sender private key  (required)
 *   WALLET_B_ADDRESS — receiver address    (required)
 *   SEND_AMOUNT      — dollar amount, e.g. "$0.01"  (optional, default "$0.01")
 */

// ─── Seller imports — quickstart-for-sellers (mainnet) ───────────────────────
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ExactEvmSchemeServer } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ─── Buyer imports — quickstart-for-buyers ───────────────────────────────────
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// ─── Balance checks ───────────────────────────────────────────────────────────
import { createPublicClient, http, formatUnits, type Hash } from "viem";
import { base } from "viem/chains";

// ─── Mainnet constants (from docs — Running on Mainnet) ───────────────────────
const NETWORK     = "eip155:8453" as const;
const FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
const USDC        = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_ABI    = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function main() {
  // ── Load from .env ─────────────────────────────────────────────────────────
  const keyA     = process.env.WALLET_A_KEY as `0x${string}` | undefined;
  const addressB = process.env.WALLET_B_ADDRESS as `0x${string}` | undefined;

  if (!keyA)     { console.error("WALLET_A_KEY is required in .env");     process.exit(1); }
  if (!addressB) { console.error("WALLET_B_ADDRESS is required in .env"); process.exit(1); }

  const sendAmount = process.env.SEND_AMOUNT ?? "$0.01";
  const accountA = privateKeyToAccount(keyA);

  console.log("\n⚠  BASE MAINNET — real USDC");
  console.log("\nWallet A  (payer)");
  console.log("  address :", accountA.address);
  console.log("\nWallet B  (receiver / payTo)");
  console.log("  address :", addressB);
  console.log("\n  Amount  :", sendAmount);

  // ── Balances before ────────────────────────────────────────────────────────
  const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

  const bal = (addr: `0x${string}`) =>
    pub.readContract({ address: USDC, abi: USDC_ABI, functionName: "balanceOf", args: [addr] });

  const [usdcA, usdcB] = await Promise.all([bal(accountA.address), bal(addressB)]);

  console.log("\n── Balances before ─────────────────────────────────────────");
  console.log("  Wallet A  USDC:", formatUnits(usdcA, 6));
  console.log("  Wallet B  USDC:", formatUnits(usdcB, 6));

  if (usdcA === 0n) {
    console.error("\n  Wallet A has no USDC on mainnet.");
    process.exit(1);
  }

  // ── Seller server ─────────────────────────────────────────────────────────
  const app = express();

  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });

  app.use(
    paymentMiddleware(
      {
        "GET /pay": {
          accepts: [{ scheme: "exact", price: sendAmount, network: NETWORK, payTo: addressB }],
          description: "x402 mainnet payment",
          mimeType: "application/json",
        },
      },
      new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmSchemeServer()),
    ),
  );

  app.get("/pay", (_req, res) => res.json({ ok: true, receiver: addressB }));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const s = app.listen(4402, () => resolve(s));
    s.on("error", reject);
  });

  console.log("\n── Server started on localhost:4402 ────────────────────────");

  // ── Buyer ─────────────────────────────────────────────────────────────────
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(accountA));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log("\n── Sending payment (Wallet A → Wallet B via x402) ──────────");
  const response = await fetchWithPayment("http://localhost:4402/pay", { method: "GET" });

  const data = await response.json();
  console.log("  Response :", JSON.stringify(data));

  const httpClient = new x402HTTPClient(client);
  const paymentResponse = response.ok
    ? httpClient.getPaymentSettleResponse((name) => response.headers.get(name))
    : null;

  console.log("\n── Payment receipt ──────────────────────────────────────────");
  console.log(JSON.stringify(paymentResponse, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  if (paymentResponse?.transaction) {
    console.log("\n  Waiting for on-chain confirmation...");
    await pub.waitForTransactionReceipt({ hash: paymentResponse.transaction as Hash });
    console.log(`  tx → https://basescan.org/tx/${paymentResponse.transaction}`);
  }

  // ── Balances after ────────────────────────────────────────────────────────
  const [usdcA2, usdcB2] = await Promise.all([bal(accountA.address), bal(addressB)]);

  console.log("\n── Balances after ───────────────────────────────────────────");
  console.log(`  Wallet A  USDC: ${formatUnits(usdcA2, 6)}  (was ${formatUnits(usdcA, 6)})`);
  console.log(`  Wallet B  USDC: ${formatUnits(usdcB2, 6)}  (was ${formatUnits(usdcB, 6)})`);
  console.log("\n  Explorer:");
  console.log(`    Wallet A → https://basescan.org/address/${accountA.address}`);
  console.log(`    Wallet B → https://basescan.org/address/${addressB}`);

  server.close();
  console.log();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
