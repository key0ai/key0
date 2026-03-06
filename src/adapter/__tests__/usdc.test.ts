import { describe, expect, test } from "bun:test";
import { USDC_DECIMALS } from "../../types/index.js";
import { parseDollarToUsdcMicro, USDC_TRANSFER_EVENT_SIGNATURE } from "../usdc.js";

describe("USDC constants", () => {
	test("USDC_DECIMALS is 6", () => {
		expect(USDC_DECIMALS).toBe(6);
	});

	test("USDC_TRANSFER_EVENT_SIGNATURE is correct keccak256", () => {
		expect(USDC_TRANSFER_EVENT_SIGNATURE).toBe(
			"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
		);
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

	test("$0.000001 → 1n (smallest USDC unit)", () => {
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

	test("pads single decimal digit", () => {
		expect(parseDollarToUsdcMicro("$0.1")).toBe(100000n);
	});

	test("handles no dollar sign gracefully", () => {
		expect(parseDollarToUsdcMicro("5.00")).toBe(5000000n);
	});

	test("handles whitespace around amount", () => {
		expect(parseDollarToUsdcMicro("$ 2.50")).toBe(2500000n);
	});
});
