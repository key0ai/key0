// These constants are replaced by buildCli() at build time.
// When running tests, they have placeholder values.
export const CLI_NAME = "__CLI_NAME__";
export const CLI_URL = "__CLI_URL__";

export type ParsedArgs =
	| { command: "discover" }
	| { command: "request"; plan: string; resource?: string; paymentSignature?: string }
	| { command: "help" }
	| { command: "version" }
	| { command: "error"; message: string };

export interface CliResult {
	exitCode: number;
	output: Record<string, unknown>;
}

export async function runDiscover(baseUrl: string): Promise<CliResult> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/discovery`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, output: { error: msg, code: "NETWORK_ERROR" } };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			exitCode: 1,
			output: { error: "Response was not valid JSON", code: "INVALID_RESPONSE" },
		};
	}

	return { exitCode: 0, output: body as Record<string, unknown> };
}

export async function runRequest(
	baseUrl: string,
	plan: string,
	resource?: string,
	paymentSignature?: string,
): Promise<CliResult> {
	const bodyObj: Record<string, unknown> = { planId: plan };
	if (resource !== undefined) {
		bodyObj["resourceId"] = resource;
	}

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (paymentSignature !== undefined) {
		headers["payment-signature"] = paymentSignature;
	}

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/x402/access`, {
			method: "POST",
			headers,
			body: JSON.stringify(bodyObj),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, output: { error: msg, code: "NETWORK_ERROR" } };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			exitCode: 1,
			output: { error: "Response was not valid JSON", code: "INVALID_RESPONSE" },
		};
	}

	if (response.status === 402) {
		return { exitCode: 42, output: body as Record<string, unknown> };
	}

	if (response.status === 200) {
		return { exitCode: 0, output: body as Record<string, unknown> };
	}

	return { exitCode: 1, output: body as Record<string, unknown> };
}

export async function runMain(args: string[], name: string, url: string): Promise<CliResult> {
	const parsed = parseCli(args);

	switch (parsed.command) {
		case "help":
			return {
				exitCode: 0,
				output: {
					name,
					url,
					commands: {
						discover: "List available plans (GET /discovery)",
						request: "Request access or submit payment (POST /x402/access)",
					},
					flags: {
						"--plan": "Plan ID (required for request)",
						"--resource": "Resource ID (optional, defaults to 'default')",
						"--payment-signature": "Base64-encoded x402 payment payload from payments-mcp",
					},
				},
			};

		case "version":
			return {
				exitCode: 0,
				output: { name, version: "1.0.0", url },
			};

		case "error":
			return {
				exitCode: 1,
				output: { error: parsed.message, code: "INVALID_REQUEST" },
			};

		case "discover":
			return runDiscover(url);

		case "request":
			return runRequest(url, parsed.plan, parsed.resource, parsed.paymentSignature);
	}
}

// Binary entry point — only runs in compiled binary (not during tests)
const IS_MAIN = typeof process !== "undefined" && CLI_NAME !== "__CLI_NAME__";

if (IS_MAIN) {
	const args = process.argv.slice(2);
	runMain(args, CLI_NAME, CLI_URL).then((result) => {
		const stream =
			result.exitCode === 0 || result.exitCode === 42 ? process.stdout : process.stderr;
		stream.write(`${JSON.stringify(result.output, null, 2)}\n`);
		process.exit(result.exitCode);
	});
}

export function parseCli(args: string[]): ParsedArgs {
	if (args.length === 0) {
		return { command: "help" };
	}

	const first = args[0];

	if (first === "--help" || first === "-h") {
		return { command: "help" };
	}

	if (first === "--version" || first === "-v") {
		return { command: "version" };
	}

	if (first === "discover") {
		return { command: "discover" };
	}

	if (first === "request") {
		const rest = args.slice(1);
		let plan: string | undefined;
		let resource: string | undefined;
		let paymentSignature: string | undefined;

		for (let i = 0; i < rest.length; i++) {
			const flag = rest[i];
			const value = rest[i + 1];

			if (flag === "--plan") {
				plan = value;
				if (value !== undefined) i++;
			} else if (flag === "--resource") {
				resource = value;
				if (value !== undefined) i++;
			} else if (flag === "--payment-signature") {
				paymentSignature = value;
				if (value !== undefined) i++;
			}
		}

		if (plan === undefined) {
			return { command: "error", message: "Missing required flag: --plan" };
		}

		return {
			command: "request" as const,
			plan,
			...(resource !== undefined && { resource }),
			...(paymentSignature !== undefined && { paymentSignature }),
		};
	}

	return { command: "error", message: `Unknown command: "${first}"` };
}
