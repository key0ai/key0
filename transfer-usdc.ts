import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const KEY0_PRIVATE_KEY =
	"0x6caafdac4ea33c285bb58072f2408f0a98214afe3e33ef4a0fa1445cea6f315c" as const;
const CLIENT_ADDRESS = "0x1cEd6e3e13177b2d39FA1B625a531E35f4EF6C54" as const;
const AMOUNT = parseUnits("100", 6); // 100 USDC

const ERC20_ABI = [
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
	{
		name: "balanceOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

const account = privateKeyToAccount(KEY0_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

console.log(`Sending 100 USDC from ${account.address} → ${CLIENT_ADDRESS}`);

const balanceBefore = await publicClient.readContract({
	address: USDC_ADDRESS,
	abi: ERC20_ABI,
	functionName: "balanceOf",
	args: [CLIENT_ADDRESS],
});
console.log(`CLIENT balance before: ${Number(balanceBefore) / 1e6} USDC`);

const hash = await walletClient.writeContract({
	address: USDC_ADDRESS,
	abi: ERC20_ABI,
	functionName: "transfer",
	args: [CLIENT_ADDRESS, AMOUNT],
});
console.log(`Tx hash: ${hash}`);
console.log("Waiting for confirmation...");

await publicClient.waitForTransactionReceipt({ hash });

const balanceAfter = await publicClient.readContract({
	address: USDC_ADDRESS,
	abi: ERC20_ABI,
	functionName: "balanceOf",
	args: [CLIENT_ADDRESS],
});
console.log(`CLIENT balance after: ${Number(balanceAfter) / 1e6} USDC`);
console.log("Done!");
