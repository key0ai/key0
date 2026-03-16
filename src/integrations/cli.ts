import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read the CLI template and replace placeholder constants with actual values.
 * Returns the TypeScript source ready for compilation.
 *
 * Note: resolves cli-template.ts relative to this file's __dirname.
 * Requires Bun runtime (bun build --compile is used for compilation).
 */
export function generateCliSource(name: string, url: string): string {
	const templatePath = join(__dirname, "cli-template.ts");
	let source = readFileSync(templatePath, "utf-8");

	const cleanUrl = url.replace(/\/$/, "");

	source = source.replace(
		'export const CLI_NAME = "__CLI_NAME__";',
		`export const CLI_NAME = ${JSON.stringify(name)};`,
	);
	source = source.replace(
		'export const CLI_URL = "__CLI_URL__";',
		`export const CLI_URL = ${JSON.stringify(cleanUrl)};`,
	);

	// Replace sentinel used in IS_MAIN guard after constants have been substituted
	source = source.replace(/"__CLI_NAME__"/g, JSON.stringify(name));
	source = source.replace(/"__CLI_URL__"/g, JSON.stringify(cleanUrl));

	return source;
}
