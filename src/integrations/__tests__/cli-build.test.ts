import { describe, expect, test } from "bun:test";
import { generateCliSource } from "../cli.js";

describe("generateCliSource", () => {
	test("replaces __CLI_NAME__ and __CLI_URL__ placeholders", () => {
		const source = generateCliSource("mycli", "https://api.example.com");
		expect(source).toContain('"mycli"');
		expect(source).toContain('"https://api.example.com"');
		expect(source).not.toContain("__CLI_NAME__");
		expect(source).not.toContain("__CLI_URL__");
	});

	test("preserves all other code unchanged", () => {
		const source = generateCliSource("testcli", "https://test.com");
		expect(source).toContain("parseCli");
		expect(source).toContain("runDiscover");
		expect(source).toContain("runRequest");
		expect(source).toContain("runMain");
	});

	test("trims trailing slash from URL", () => {
		const source = generateCliSource("mycli", "https://api.example.com/");
		expect(source).toContain('"https://api.example.com"');
		expect(source).not.toContain('"https://api.example.com/"');
	});
});
