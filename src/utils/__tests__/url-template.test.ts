import { describe, expect, test } from "bun:test";
import { interpolateUrlTemplate } from "../url-template.js";

describe("interpolateUrlTemplate", () => {
	test("replaces single placeholder", () => {
		expect(interpolateUrlTemplate("/signal/{asset}", { asset: "BTC" })).toBe("/signal/BTC");
	});

	test("replaces multiple placeholders", () => {
		expect(
			interpolateUrlTemplate("/market/{asset}/interval/{period}", { asset: "ETH", period: "1d" }),
		).toBe("/market/ETH/interval/1d");
	});

	test("ignores extra params not in template", () => {
		expect(interpolateUrlTemplate("/signal/{asset}", { asset: "BTC", extra: "ignored" })).toBe(
			"/signal/BTC",
		);
	});

	test("no placeholders — returns template unchanged", () => {
		expect(interpolateUrlTemplate("/health", {})).toBe("/health");
	});

	test("throws on unknown placeholder (no matching param)", () => {
		expect(() => interpolateUrlTemplate("/signal/{asset}", {})).toThrow(
			'Missing param "asset" required by URL template "/signal/{asset}"',
		);
	});

	test("throws on path traversal: dots", () => {
		expect(() => interpolateUrlTemplate("/signal/{asset}", { asset: "../admin" })).toThrow(
			'Invalid param "asset": value "../admin" contains disallowed characters',
		);
	});

	test("throws on path traversal: forward slash", () => {
		expect(() => interpolateUrlTemplate("/signal/{asset}", { asset: "BTC/ETH" })).toThrow(
			'Invalid param "asset": value "BTC/ETH" contains disallowed characters',
		);
	});

	test("allows alphanumeric, dash, underscore", () => {
		expect(interpolateUrlTemplate("/token/{id}", { id: "TOKEN_A-1" })).toBe("/token/TOKEN_A-1");
	});
});
