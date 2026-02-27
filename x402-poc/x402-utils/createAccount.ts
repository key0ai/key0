import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type Account = {
  address: `0x${string}`;
  privateKey: `0x${string}`;
};

/**
 * Generates a new random EVM wallet.
 *
 * @returns An object with the wallet's address and private key.
 *
 * @example
 * const account = createAccount();
 * console.log(account.address);    // 0x...
 * console.log(account.privateKey); // 0x...
 */
export default function createAccount(): Account {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  return { address, privateKey };
}
