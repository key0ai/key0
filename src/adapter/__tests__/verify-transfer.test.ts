import { describe, expect, test } from "bun:test";
import type { PublicClient } from "viem";
import { encodeAbiParameters, pad } from "viem";
import { CHAIN_CONFIGS } from "../chain-config.js";
import { USDC_TRANSFER_EVENT_SIGNATURE } from "../usdc.js";
import { type VerifyTransferParams, verifyTransfer } from "../verify-transfer.js";

const TX_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const DESTINATION = `0x${"cd".repeat(20)}` as `0x${string}`;
const SENDER = `0x${"ef".repeat(20)}` as `0x${string}`;
const USDC_ADDRESS = CHAIN_CONFIGS.testnet.usdcAddress;
const AMOUNT_RAW = 100000n; // $0.10

function makeTransferLog(to: `0x${string}`, value: bigint) {
	// Transfer(address indexed from, address indexed to, uint256 value)
	// topics[0] = event signature, topics[1] = from (padded), topics[2] = to (padded)
	// data = ABI-encoded value
	const topics: [`0x${string}`, `0x${string}`, `0x${string}`] = [
		USDC_TRANSFER_EVENT_SIGNATURE,
		pad(SENDER, { size: 32 }),
		pad(to, { size: 32 }),
	];
	const data = encodeAbiParameters([{ type: "uint256" }], [value]);

	return {
		address: USDC_ADDRESS,
		topics,
		data,
		blockNumber: 1000n,
		transactionHash: TX_HASH,
		transactionIndex: 0,
		blockHash: `0x${"00".repeat(32)}` as `0x${string}`,
		logIndex: 0,
		removed: false,
	};
}

function makeMockClient(overrides: {
	receipt?: Partial<{
		status: string;
		logs: ReturnType<typeof makeTransferLog>[];
		blockNumber: bigint;
	}>;
	receiptError?: Error;
	blockTimestamp?: bigint;
}): PublicClient {
	return {
		getTransactionReceipt: async () => {
			if (overrides.receiptError) throw overrides.receiptError;
			return {
				status: overrides.receipt?.status ?? "success",
				logs: overrides.receipt?.logs ?? [],
				blockNumber: overrides.receipt?.blockNumber ?? 1000n,
			};
		},
		getBlock: async () => ({
			timestamp: overrides.blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000) - 60),
		}),
	} as unknown as PublicClient;
}

function makeParams(client: PublicClient): VerifyTransferParams {
	return {
		txHash: TX_HASH,
		expectedTo: DESTINATION,
		expectedAmountRaw: AMOUNT_RAW,
		expectedChainId: 84532,
		challengeExpiresAt: new Date(Date.now() + 900_000),
		networkConfig: CHAIN_CONFIGS.testnet,
		client,
	};
}

describe("verifyTransfer", () => {
	test("success: valid transfer to correct destination", async () => {
		const log = makeTransferLog(DESTINATION, AMOUNT_RAW);
		const client = makeMockClient({ receipt: { logs: [log] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(true);
		expect(result.txHash).toBe(TX_HASH);
		expect(result.confirmedAmount).toBe(AMOUNT_RAW);
		expect(result.confirmedChainId).toBe(84532);
	});

	test("success: overpayment is accepted", async () => {
		const log = makeTransferLog(DESTINATION, 200000n);
		const client = makeMockClient({ receipt: { logs: [log] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(true);
		expect(result.confirmedAmount).toBe(200000n);
	});

	test("TX_NOT_FOUND: receipt throws not found error", async () => {
		const client = makeMockClient({
			receiptError: new Error("Transaction could not be found"),
		});
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("TX_NOT_FOUND");
	});

	test("RPC_ERROR: receipt throws generic error", async () => {
		const client = makeMockClient({
			receiptError: new Error("Connection timeout"),
		});
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("RPC_ERROR");
	});

	test("TX_REVERTED: transaction reverted", async () => {
		const client = makeMockClient({ receipt: { status: "reverted" } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("TX_REVERTED");
		expect(result.txHash).toBe(TX_HASH);
	});

	test("WRONG_RECIPIENT: no transfer to expected address", async () => {
		const wrongDest = `0x${"11".repeat(20)}` as `0x${string}`;
		const log = makeTransferLog(wrongDest, AMOUNT_RAW);
		const client = makeMockClient({ receipt: { logs: [log] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("WRONG_RECIPIENT");
	});

	test("AMOUNT_INSUFFICIENT: underpayment", async () => {
		const log = makeTransferLog(DESTINATION, 50000n); // half the expected
		const client = makeMockClient({ receipt: { logs: [log] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("AMOUNT_INSUFFICIENT");
		expect(result.confirmedAmount).toBe(50000n);
	});

	test("TX_AFTER_EXPIRY: block timestamp after challenge expiry", async () => {
		const log = makeTransferLog(DESTINATION, AMOUNT_RAW);
		// Block timestamp far in the future
		const futureTimestamp = BigInt(Math.floor(Date.now() / 1000) + 999999);
		const client = makeMockClient({
			receipt: { logs: [log] },
			blockTimestamp: futureTimestamp,
		});
		const params = {
			...makeParams(client),
			challengeExpiresAt: new Date(Date.now() - 60_000), // already expired
		};
		const result = await verifyTransfer(params);

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("TX_AFTER_EXPIRY");
	});

	test("multiple transfers to same destination are summed", async () => {
		const log1 = makeTransferLog(DESTINATION, 60000n);
		const log2 = makeTransferLog(DESTINATION, 60000n);
		const client = makeMockClient({ receipt: { logs: [log1, log2] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(true);
		expect(result.confirmedAmount).toBe(120000n);
	});

	test("no logs at all → WRONG_RECIPIENT", async () => {
		const client = makeMockClient({ receipt: { logs: [] } });
		const result = await verifyTransfer(makeParams(client));

		expect(result.verified).toBe(false);
		expect(result.errorCode).toBe("WRONG_RECIPIENT");
	});
});
