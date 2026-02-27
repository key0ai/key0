import { privateKeyToAccount } from "viem/accounts";
import { assertPrivateKey } from "./_shared";

/**
 * Loads a viem account object from an existing private key.
 * Use this to sign transactions with a key you already hold.
 *
 * @param privateKey - A 0x-prefixed 64-character hex private key.
 * @throws If the private key format is invalid.
 *
 * @example
 * const account = getAccount("0xabc123...");
 * console.log(account.address); // 0x...
 */
export default function getAccount(privateKey: string) {
  assertPrivateKey(privateKey, "privateKey");
  return privateKeyToAccount(privateKey as `0x${string}`);
}
