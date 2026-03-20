import type { AgentCard, AgentExtension, AgentSkill, SellerConfig } from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	// Core A2A skills (discovery + subscription purchase)
	// Additional per-request skills are appended below for each gated route.
	const skills: AgentSkill[] = [
		{
			id: "discover",
			name: "Discover",
			description: [
				`Browse available plans and pricing for ${config.agentName}.`,
				`Returns the product catalog with plan IDs, prices (USDC on ${networkName}), wallet address, and chain ID.`,
				`Endpoint: GET ${baseUrl}/discover`,
			].join(" "),
			tags: ["discovery", "catalog", "x402"],
			examples: [`GET ${baseUrl}/discover`],
		},
		{
			id: "access",
			name: "Access",
			description: [
				`Purchase access to a ${config.agentName} product plan via x402 payment on ${networkName}.`,
				`Step 1: GET ${baseUrl}/discover to list available plans.`,
				`Step 2: POST ${baseUrl}/x402/access with { planId, requestId } — server returns 402 with payment requirements.`,
				`Step 3: Pay USDC on-chain, then retry the same POST with PAYMENT-SIGNATURE header to receive the access token.`,
			].join(" "),
			tags: ["payment", "x402", "purchase"],
			examples: [
				`POST ${baseUrl}/x402/access with { "planId": "<plan-id>", "requestId": "<uuid>", "resourceId": "default" }`,
				`Receive HTTP 402 with x402 payment requirements`,
				`Pay USDC on-chain, retry same request with PAYMENT-SIGNATURE header`,
				`Receive 200 with access token`,
			],
			inputSchema: {
				type: "object",
				required: ["planId", "requestId"],
				properties: {
					planId: { type: "string", enum: (config.plans ?? []).map((p) => p.planId) },
					requestId: { type: "string", format: "uuid" },
					resourceId: { type: "string", default: "default" },
				},
			},
		},
	];

	// Per-request skills: one skill per route in config.routes.
	for (const route of config.routes ?? []) {
		const skillId = `ppr-${route.routeId}-${route.method.toLowerCase()}-${route.path.replace(/\//g, "-").replace(/[: ]/g, "")}`;

		const explicitParams = route.params ?? [];
		const queryParams = explicitParams.filter((p) => p.in === "query");
		const bodyParams = explicitParams.filter((p) => p.in === "body");
		// Build concrete example path (replace :param with <param>)
		const examplePath = route.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "<$1>");

		const routeExamples = route.unitAmount
			? [
					`POST ${baseUrl}/x402/access with { "routeId": "${route.routeId}", "resource": { "method": "${route.method}", "path": "${examplePath}"${queryParams.length > 0 ? ', "query": {...}' : ""}${bodyParams.length > 0 ? ', "body": {...}' : ""} } }`,
					`Receive HTTP 402 with x402 payment requirements`,
					`Pay ${route.unitAmount} USDC on-chain, retry with PAYMENT-SIGNATURE header`,
					`Receive 200 with ResourceResponse`,
				]
			: [
					`POST ${baseUrl}/x402/access with { "routeId": "${route.routeId}", "resource": { "method": "${route.method}", "path": "${examplePath}" } }`,
					`Receive 200 with ResourceResponse (no payment required)`,
				];

		skills.push({
			id: skillId,
			name: `${route.method} ${route.path}`,
			description:
				route.description ??
				(route.unitAmount
					? `Pay-per-call route: ${route.unitAmount} USDC per request. POST to ${baseUrl}/x402/access with routeId "${route.routeId}".`
					: `Free endpoint: ${route.method} ${route.path}. POST to ${baseUrl}/x402/access with routeId "${route.routeId}".`),
			tags: route.unitAmount ? ["pay-per-call", "x402"] : ["free"],
			examples: routeExamples,
			inputSchema: {
				type: "object",
				required: ["routeId", "resource"],
				properties: {
					routeId: { type: "string", const: route.routeId },
					resource: {
						type: "object",
						required: ["method", "path"],
						properties: {
							method: { type: "string", const: route.method },
							path: {
								type: "string",
								description: `Path pattern: ${route.path}. Example: ${examplePath}`,
							},
							...(queryParams.length > 0 ? { query: { type: "object" } } : {}),
							...(bodyParams.length > 0 ? { body: { type: "object" } } : {}),
						},
					},
				},
			},
		});
	}

	// Per-request skills from plan.routes: one skill per route for plans with mode="per-request".
	// In embedded mode (no proxyTo), the endpoint points to the route URL directly.
	// In standalone mode (proxyTo set), the endpoint points to /x402/access with a full workflow.
	const isStandalone = !!config.proxyTo;
	for (const plan of config.plans ?? []) {
		if (plan.mode !== "per-request") continue;
		for (const route of plan.routes ?? []) {
			const safeRoute = route as { method: string; path: string; description?: string };
			const pathSlug = safeRoute.path.replace(/\//g, "-").replace(/[: ]/g, "");
			const skillId = `ppr-${plan.planId}-${safeRoute.method.toLowerCase()}${pathSlug}`;
			const defaultDescription = `Pay-per-request: ${plan.unitAmount} USDC per call. Plan: ${plan.planId}.`;
			if (isStandalone) {
				skills.push({
					id: skillId,
					name: `${safeRoute.method} ${safeRoute.path}`,
					description:
						safeRoute.description ??
						`${defaultDescription} POST to ${baseUrl}/x402/access with { planId: "${plan.planId}", resource: { method: "${safeRoute.method}", path: "<actual path>" } }.`,
					tags: ["pay-per-request", "x402", plan.planId],
					examples: [
						`POST ${baseUrl}/x402/access with { "planId": "${plan.planId}", "resource": { "method": "${safeRoute.method}", "path": "<actual path>" } }`,
						`Receive HTTP 402 with x402 payment requirements`,
						`Pay ${plan.unitAmount} USDC on-chain, retry with PAYMENT-SIGNATURE header`,
						`Receive 200 with ResourceResponse`,
					],
					inputSchema: {
						type: "object",
						required: ["planId", "resource"],
						properties: {
							planId: { type: "string", const: plan.planId },
							resource: {
								type: "object",
								required: ["method", "path"],
								properties: {
									method: { type: "string", const: safeRoute.method },
									path: { type: "string", description: `Path pattern: ${safeRoute.path}` },
								},
							},
						},
					},
				} satisfies AgentSkill);
			} else {
				// Embedded mode: client calls the route directly with PAYMENT-SIGNATURE
				skills.push({
					id: skillId,
					name: `${safeRoute.method} ${safeRoute.path}`,
					description:
						safeRoute.description ??
						`${defaultDescription} Call ${safeRoute.method} ${baseUrl}${safeRoute.path} with PAYMENT-SIGNATURE header after paying on-chain.`,
					tags: ["pay-per-request", "x402", plan.planId],
					examples: [
						`${safeRoute.method} ${baseUrl}${safeRoute.path} with PAYMENT-SIGNATURE header`,
					],
				} satisfies AgentSkill);
			}
		}
	}

	const x402Extension: AgentExtension = {
		uri: X402_EXTENSION_URI,
		description: `Supports x402 payments with USDC on ${networkName}.`,
		required: true,
	};

	return {
		name: config.agentName,
		description: config.agentDescription,
		url: `${baseUrl}/x402/access`,
		version: config.version ?? "1.0.0",
		protocolVersion: "0.3.0",
		capabilities: {
			extensions: [x402Extension],
			pushNotifications: false,
			streaming: false,
			stateTransitionHistory: false,
		},
		defaultInputModes: ["text"],
		defaultOutputModes: ["application/json"],
		skills,
		provider: {
			organization: config.providerName,
			url: config.providerUrl,
		},
	};
}
