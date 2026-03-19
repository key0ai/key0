import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCli } from "../integrations/cli.js";
import type { SellerConfig } from "../types/index.js";

export const DEFAULT_CLI_TARGETS = ["bun-linux-x64", "bun-darwin-arm64", "bun-darwin-x64"] as const;

type OnboardingOptions = {
	a2aEnabled: boolean;
	mcpEnabled: boolean;
	llmsEnabled: boolean;
	skillsMdEnabled: boolean;
	installShEnabled: boolean;
	cliDownloadsEnabled: boolean;
};

export function slugifyCliName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "key0-agent";
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function summarizeCatalog(config: SellerConfig): string[] {
	const parts: string[] = [];
	const plans = config.plans ?? [];
	const routes = config.routes ?? [];
	if (plans.length > 0)
		parts.push(`${plans.length} subscription plan${plans.length === 1 ? "" : "s"}`);
	if (routes.length > 0) parts.push(`${routes.length} route${routes.length === 1 ? "" : "s"}`);
	return parts;
}

export function buildLlmsTxt(config: SellerConfig, options: OnboardingOptions): string {
	const baseUrl = normalizeBaseUrl(config.agentUrl);
	const lines: string[] = [
		`# ${config.agentName}`,
		config.agentDescription,
		"",
		"## Canonical Endpoints",
		`- GET ${baseUrl}/discover`,
		`- POST ${baseUrl}/x402/access`,
	];

	if (options.a2aEnabled) lines.push(`- GET ${baseUrl}/.well-known/agent.json`);
	if (options.mcpEnabled) {
		lines.push(`- GET ${baseUrl}/.well-known/mcp.json`);
		lines.push(`- POST ${baseUrl}/mcp`);
	}
	if (options.skillsMdEnabled) lines.push(`- GET ${baseUrl}/skills.md`);
	if (options.llmsEnabled) lines.push(`- GET ${baseUrl}/llms.txt`);
	if (options.installShEnabled) lines.push(`- GET ${baseUrl}/install.sh`);

	const catalogSummary = summarizeCatalog(config);
	if (catalogSummary.length > 0) {
		lines.push("", "## Catalog");
		lines.push(`- ${catalogSummary.join(" and ")}`);
	}

	if ((config.plans ?? []).length > 0) {
		lines.push("", "## Subscription Plans");
		lines.push(
			"- Use GET /discover to list plan IDs, prices, wallet address, and chain metadata.",
			"- Use POST /x402/access with { planId, requestId, resourceId } to initiate purchase.",
			"- Retry the same request with PAYMENT-SIGNATURE after payment to receive access credentials.",
		);
	}

	if ((config.routes ?? []).length > 0) {
		lines.push("", "## Pay-Per-Call Routes");
		lines.push(
			"- Routes are listed in GET /discover alongside plans.",
			"- Paid routes settle via x402 and return the backend response directly.",
			"- Free routes can be advertised in discovery without payment requirements.",
		);
	}

	lines.push("", "## Protocols");
	lines.push(`- HTTP x402: enabled`);
	lines.push(`- A2A: ${options.a2aEnabled ? "enabled" : "disabled"}`);
	lines.push(`- MCP: ${options.mcpEnabled ? "enabled" : "disabled"}`);

	if (options.installShEnabled && options.cliDownloadsEnabled) {
		lines.push("", "## CLI");
		lines.push(`- Install with: curl -fsSL ${baseUrl}/install.sh | sh`);
	}

	return `${lines.join("\n")}\n`;
}

export function buildSkillsMd(config: SellerConfig, options: OnboardingOptions): string {
	const baseUrl = normalizeBaseUrl(config.agentUrl);
	const planLines = (config.plans ?? []).map((plan) => {
		const price = plan.unitAmount ?? "$0";
		return `- \`${plan.planId}\` — ${price}${plan.description ? ` — ${plan.description}` : ""}`;
	});
	const routeLines = (config.routes ?? []).map((route) => {
		const price = route.unitAmount ? route.unitAmount : "free";
		return `- \`${route.routeId}\` — \`${route.method} ${route.path}\` — ${price}${route.description ? ` — ${route.description}` : ""}`;
	});

	const lines: string[] = [
		`# ${config.agentName} Buyer Guide`,
		"",
		config.agentDescription,
		"",
		"## Start Here",
		`1. Fetch \`${baseUrl}/discover\` to inspect plans and routes.`,
		"2. Choose a subscription plan or a pay-per-call route.",
		"3. Use `POST /x402/access` for plan purchase and standalone route settlement.",
	];

	if (options.a2aEnabled) {
		lines.push(`4. A2A clients can bootstrap from \`${baseUrl}/.well-known/agent.json\`.`);
	}
	if (options.mcpEnabled) {
		lines.push(
			`5. MCP clients can connect via \`${baseUrl}/.well-known/mcp.json\` and \`${baseUrl}/mcp\`.`,
		);
	}

	if (planLines.length > 0) {
		lines.push("", "## Subscription Plans", ...planLines);
		lines.push(
			"",
			"### Subscription Flow",
			"1. `GET /discover` and select a `planId`.",
			'2. `POST /x402/access` with `{ "planId": "...", "requestId": "uuid", "resourceId": "default" }`.',
			"3. Pay using the x402 requirements from the 402 response.",
			"4. Retry with `PAYMENT-SIGNATURE` to receive credentials.",
		);
	}

	if (routeLines.length > 0) {
		lines.push("", "## Pay-Per-Call Routes", ...routeLines);
		lines.push(
			"",
			"### Route Flow",
			"1. `GET /discover` and inspect `routes`.",
			'2. For standalone gateway routes, call `POST /x402/access` with `{ "routeId": "...", "resource": { "method": "GET", "path": "/actual/path" } }`.',
			"3. Paid routes return 402 first, then a `ResourceResponse` after payment.",
		);
	}

	if (options.installShEnabled && options.cliDownloadsEnabled) {
		lines.push(
			"",
			"## CLI Install",
			`Run \`curl -fsSL ${baseUrl}/install.sh | sh\` to install the seller CLI locally.`,
		);
	}

	return `${lines.join("\n")}\n`;
}

export function buildInstallScript(config: SellerConfig): string {
	const baseUrl = normalizeBaseUrl(config.agentUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const cliName = slugifyCliName(config.agentName);
	return `#!/bin/sh
set -eu

BASE_URL="${baseUrl}"
CLI_NAME="${cliName}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS:$ARCH" in
  Darwin:arm64) TARGET="bun-darwin-arm64" ;;
  Darwin:x86_64) TARGET="bun-darwin-x64" ;;
  Linux:x86_64) TARGET="bun-linux-x64" ;;
  *)
    echo "Unsupported platform: $OS $ARCH" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
BIN_PATH="$TMP_DIR/$CLI_NAME"
URL="$BASE_URL/cli/$TARGET"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$BIN_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BIN_PATH" "$URL"
else
  echo "curl or wget is required" >&2
  exit 1
fi

chmod +x "$BIN_PATH"
"$BIN_PATH" --install
`;
}

function buildCliFingerprint(config: SellerConfig, targets: readonly string[]): string {
	const input = JSON.stringify({
		agentName: config.agentName,
		agentUrl: normalizeBaseUrl(config.agentUrl),
		targets,
	});
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function createCliArtifactManager(config: SellerConfig, cacheRoot: string) {
	const targets = [...DEFAULT_CLI_TARGETS];
	const cliName = slugifyCliName(config.agentName);
	const fingerprint = buildCliFingerprint(config, targets);
	const outputDir = join(cacheRoot, fingerprint);
	let buildPromise: Promise<void> | null = null;

	async function ensureBuilt(): Promise<void> {
		if (buildPromise) return buildPromise;
		buildPromise = (async () => {
			mkdirSync(outputDir, { recursive: true });
			await buildCli({
				name: cliName,
				url: normalizeBaseUrl(config.agentUrl),
				targets,
				outputDir,
			});
		})().finally(() => {
			buildPromise = null;
		});
		return buildPromise;
	}

	return {
		cliName,
		targets,
		async ensureBinary(target: string): Promise<string | null> {
			if (!targets.includes(target as (typeof DEFAULT_CLI_TARGETS)[number])) {
				return null;
			}

			const filePath = join(outputDir, `${cliName}-${target.replace(/^bun-/, "")}`);
			if (!existsSync(filePath)) {
				await ensureBuilt();
			}
			return existsSync(filePath) ? filePath : null;
		},
	};
}
