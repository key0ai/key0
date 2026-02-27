import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ExactEvmSchemeServer } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hash } from "viem";
import {
  publicClient,
  config,
  assertPrivateKey,
  assertAddress,
  parseDollarAmount,
} from "./_shared";

export type PaymentResult = {
  success: boolean;
  txHash: `0x${string}`;
  network: string;
  payer: `0x${string}`;
  receiver: `0x${string}`;
  amount: string;
  explorerUrl: string;
};

// Increment port per call to avoid collisions if called concurrently.
let portCounter = 4402;

/**
 * Makes an x402 protocol payment from one wallet to an address.
 *
 * Follows the buyer + seller quickstart from docs.x402.org.
 * Network and facilitator are determined by the NETWORK env var (testnet | mainnet).
 *
 * @param fromKey   - Private key of the paying wallet.
 * @param toAddress - Recipient EVM address (payTo in x402 terms).
 * @param amount    - Dollar amount string, e.g. "$0.01" or "0.01".
 * @throws If inputs are invalid or the payment fails.
 *
 * @example
 * const result = await makePayment("0xabc...", "0xdef...", "$0.01");
 * console.log(result.txHash);      // 0x...
 * console.log(result.explorerUrl); // https://basescan.org/tx/...
 */
export default async function makePayment(
  fromKey: string,
  toAddress: string,
  amount: string,
): Promise<PaymentResult> {
  assertPrivateKey(fromKey, "fromKey");
  assertAddress(toAddress, "toAddress");
  const dollarAmount = parseDollarAmount(amount);

  const port = portCounter++;

  // ── Seller (minimal server required by x402 protocol) ─────────────────────
  const app = express();

  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitator });

  app.use(
    paymentMiddleware(
      {
        "GET /pay": {
          accepts: [{
            scheme: "exact",
            price: dollarAmount,
            network: config.network,
            payTo: toAddress,
          }],
          description: "x402 payment",
          mimeType: "application/json",
        },
      },
      new x402ResourceServer(facilitatorClient).register(config.network, new ExactEvmSchemeServer()),
    ),
  );

  app.get("/pay", (_req, res) => res.json({ ok: true }));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.on("error", reject);
  });

  try {
    // ── Buyer (from quickstart-for-buyers) ──────────────────────────────────
    const signer = privateKeyToAccount(fromKey as `0x${string}`);

    const client = new x402Client();
    client.register("eip155:*", new ExactEvmScheme(signer));

    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    const response = await fetchWithPayment(`http://localhost:${port}/pay`, {
      method: "GET",
    });

    const httpClient = new x402HTTPClient(client);
    const receipt = httpClient.getPaymentSettleResponse(
      (name) => response.headers.get(name),
    );

    if (!receipt?.success || !receipt.transaction) {
      throw new Error("Payment did not succeed or receipt missing from response headers.");
    }

    // Wait for on-chain confirmation
    await publicClient.waitForTransactionReceipt({
      hash: receipt.transaction as Hash,
    });

    return {
      success: true,
      txHash: receipt.transaction as `0x${string}`,
      network: config.label,
      payer: signer.address,
      receiver: toAddress as `0x${string}`,
      amount: dollarAmount,
      explorerUrl: `${config.explorer}/tx/${receipt.transaction}`,
    };
  } finally {
    server.close();
  }
}
