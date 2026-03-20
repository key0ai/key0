import { listCatalogRoutes } from "../core/route-catalog.js";
import type { SellerConfig } from "../types/index.js";

type OnboardingOptions = {
	a2aEnabled: boolean;
	mcpEnabled: boolean;
	llmsEnabled: boolean;
	skillsMdEnabled: boolean;
};

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function summarizeCatalog(config: SellerConfig): string[] {
	const parts: string[] = [];
	const plans = config.plans ?? [];
	const routes = collectRouteSummaries(config);
	if (plans.length > 0)
		parts.push(`${plans.length} subscription plan${plans.length === 1 ? "" : "s"}`);
	if (routes.length > 0) parts.push(`${routes.length} route${routes.length === 1 ? "" : "s"}`);
	return parts;
}

type RouteSummary = {
	id: string;
	method: string;
	path: string;
	price?: string;
	description?: string;
};

function collectRouteSummaries(config: SellerConfig): RouteSummary[] {
	const routeSummaries: RouteSummary[] = [];

	for (const route of listCatalogRoutes(config)) {
		routeSummaries.push({
			id: route.routeId,
			method: route.method,
			path: route.path,
			...(route.unitAmount ? { price: route.unitAmount } : {}),
			...(route.description ? { description: route.description } : {}),
		});
	}

	return routeSummaries;
}

export function buildLlmsTxt(config: SellerConfig, options: OnboardingOptions): string {
	const baseUrl = normalizeBaseUrl(config.agentUrl);
	const routeSummaries = collectRouteSummaries(config);
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

	if (routeSummaries.length > 0) {
		lines.push("", "## Pay-Per-Call Routes");
		lines.push(
			"- Routes are listed in GET /discover alongside plans.",
			"- Call the route directly to initiate payment; paid routes return 402 first, then the backend response directly.",
			"- Free routes can be advertised in discovery without payment requirements.",
		);
	}

	lines.push("", "## Protocols");
	lines.push(`- HTTP x402: enabled`);
	lines.push(`- A2A: ${options.a2aEnabled ? "enabled" : "disabled"}`);
	lines.push(`- MCP: ${options.mcpEnabled ? "enabled" : "disabled"}`);

	return `${lines.join("\n")}\n`;
}

export function buildSkillsMd(config: SellerConfig, options: OnboardingOptions): string {
	const baseUrl = normalizeBaseUrl(config.agentUrl);
	const routeSummaries = collectRouteSummaries(config);
	const planLines = (config.plans ?? []).map((plan) => {
		const price = plan.unitAmount ?? "$0";
		return `- \`${plan.planId}\` — ${price}${plan.description ? ` — ${plan.description}` : ""}`;
	});
	const routeLines = routeSummaries.map((route) => {
		const price = route.price ? route.price : "free";
		return `- \`${route.method} ${route.path}\` — ${price}${route.description ? ` — ${route.description}` : ""}`;
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
			"2. Call the route directly (for example `GET /api/weather/london`).",
			"3. Paid routes return 402 first; retry the same request with `PAYMENT-SIGNATURE` after payment.",
			"4. Key0 returns the backend response directly.",
		);
	}

	return `${lines.join("\n")}\n`;
}
