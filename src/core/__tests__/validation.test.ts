import { describe, expect, test } from "bun:test";
import { parseDollarToUsdcMicro } from "../../adapter/usdc.js";
import { Key0Error } from "../../types";
import {
	validateAddress,
	validateDollarAmount,
	validateNonEmpty,
	validateTxHash,
	validateUUID,
} from "../validation.js";

describe("validateUUID", () => {
	test("accepts valid UUID", () => {
		expect(() => validateUUID("550e8400-e29b-41d4-a716-446655440000", "id")).not.toThrow();
	});

	test("accepts uppercase UUID", () => {
		expect(() => validateUUID("550E8400-E29B-41D4-A716-446655440000", "id")).not.toThrow();
	});

	test("rejects empty string", () => {
		expect(() => validateUUID("", "id")).toThrow(Key0Error);
	});

	test("rejects non-UUID string", () => {
		expect(() => validateUUID("not-a-uuid", "id")).toThrow(Key0Error);
	});

	test("rejects UUID without dashes", () => {
		expect(() => validateUUID("550e8400e29b41d4a716446655440000", "id")).toThrow(Key0Error);
	});
});

describe("validateTxHash", () => {
	test("accepts valid tx hash", () => {
		const hash = `0x${"a".repeat(64)}`;
		expect(() => validateTxHash(hash)).not.toThrow();
	});

	test("accepts mixed case hex", () => {
		const hash = `0x${"aAbBcCdDeEfF".repeat(5)}abcd`;
		expect(() => validateTxHash(hash)).not.toThrow();
	});

	test("rejects without 0x prefix", () => {
		expect(() => validateTxHash("a".repeat(64))).toThrow(Key0Error);
	});

	test("rejects wrong length", () => {
		expect(() => validateTxHash(`0x${"a".repeat(63)}`)).toThrow(Key0Error);
	});

	test("rejects non-hex characters", () => {
		expect(() => validateTxHash(`0x${"g".repeat(64)}`)).toThrow(Key0Error);
	});
});

describe("validateAddress", () => {
	test("accepts valid address", () => {
		const addr = `0x${"a".repeat(40)}`;
		expect(() => validateAddress(addr)).not.toThrow();
	});

	test("rejects wrong length", () => {
		expect(() => validateAddress(`0x${"a".repeat(39)}`)).toThrow(Key0Error);
	});

	test("rejects without 0x prefix", () => {
		expect(() => validateAddress("a".repeat(40))).toThrow(Key0Error);
	});
});

describe("validateNonEmpty", () => {
	test("accepts non-empty string", () => {
		expect(() => validateNonEmpty("hello", "field")).not.toThrow();
	});

	test("rejects empty string", () => {
		expect(() => validateNonEmpty("", "field")).toThrow(Key0Error);
	});

	test("rejects whitespace-only string", () => {
		expect(() => validateNonEmpty("   ", "field")).toThrow(Key0Error);
	});
});

describe("validateDollarAmount", () => {
	test("accepts $0.10", () => {
		expect(() => validateDollarAmount("$0.10", "amount")).not.toThrow();
	});

	test("accepts $1000.50", () => {
		expect(() => validateDollarAmount("$1000.50", "amount")).not.toThrow();
	});

	test("accepts whole dollar $5", () => {
		expect(() => validateDollarAmount("$5", "amount")).not.toThrow();
	});

	test("rejects missing dollar sign", () => {
		expect(() => validateDollarAmount("0.10", "amount")).toThrow(Key0Error);
	});

	test("rejects negative amount", () => {
		expect(() => validateDollarAmount("$-1.00", "amount")).toThrow(Key0Error);
	});

	test("rejects more than 6 decimal places", () => {
		expect(() => validateDollarAmount("$0.1234567", "amount")).toThrow(Key0Error);
	});
});

describe("parseDollarToUsdcMicro", () => {
	test("$0.10 → 100000n", () => {
		expect(parseDollarToUsdcMicro("$0.10")).toBe(100000n);
	});

	test("$1.00 → 1000000n", () => {
		expect(parseDollarToUsdcMicro("$1.00")).toBe(1000000n);
	});

	test("$0 → 0n", () => {
		expect(parseDollarToUsdcMicro("$0")).toBe(0n);
	});

	test("$0.000001 → 1n", () => {
		expect(parseDollarToUsdcMicro("$0.000001")).toBe(1n);
	});

	test("$1000.50 → 1000500000n", () => {
		expect(parseDollarToUsdcMicro("$1000.50")).toBe(1000500000n);
	});

	test("$99.999999 → 99999999n", () => {
		expect(parseDollarToUsdcMicro("$99.999999")).toBe(99999999n);
	});

	test("truncates beyond 6 decimals", () => {
		expect(parseDollarToUsdcMicro("$0.1234567")).toBe(123456n);
	});

	test("pads short decimals", () => {
		expect(parseDollarToUsdcMicro("$0.1")).toBe(100000n);
	});
});
