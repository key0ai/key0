import { createPublicClient, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";

const NETWORK = process.env["AGENTGATE_NETWORK"] ?? "testnet";
const WALLET = (process.env["AGENTGATE_WALLET_ADDRESS"] ?? "") as `0x${string}`;

const USDC: Record<string, `0x${string}`> = {
	testnet: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const chain = NETWORK === "mainnet" ? base : baseSepolia;
const usdcAddress = USDC[NETWORK]!;

const client = createPublicClient({ chain, transport: http() });

const [usdc, eth] = await Promise.all([
	client.readContract({
		address: usdcAddress,
		abi: [
			{
				name: "balanceOf",
				type: "function",
				inputs: [{ name: "account", type: "address" }],
				outputs: [{ name: "", type: "uint256" }],
			},
		],
		functionName: "balanceOf",
		args: [WALLET],
	}),
	client.getBalance({ address: WALLET }),
]);

console.log(`Network : ${NETWORK} (${chain.name})`);
console.log(`Wallet  : ${WALLET}`);
console.log(`ETH     : ${formatUnits(eth, 18)} ETH`);
console.log(`USDC    : ${formatUnits(usdc as bigint, 6)} USDC`);
