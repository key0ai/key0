import type { AgentCard, AgentExtension, AgentSkill, SellerConfig } from "../types/index.js";
import { CHAIN_CONFIGS, CHAIN_ID_TO_NETWORK, X402_EXTENSION_URI } from "../types/index.js";

export function buildAgentCard(config: SellerConfig): AgentCard {
	const networkConfig = CHAIN_CONFIGS[config.network];
	const networkName =
		CHAIN_ID_TO_NETWORK[networkConfig.chainId] ?? `chain-${networkConfig.chainId}`;

	const baseUrl = config.agentUrl.replace(/\/$/, "");

	const planIds = (config.plans ?? []).map((p) => p.planId);

	// Core A2A skills (discovery + subscription purchase)
	// Additional per-request skills are appended below for each gated route.
	const skills: AgentSkill[] = [
		{
			id: "discover",
			name: "Discover",
			description: [
				`Browse available plans and pricing for ${config.agentName}.`,
				`Returns the product catalog with plan IDs, prices (USDC on ${networkName}), wallet address, and chain ID.`,
				`GET to ${baseUrl}/discover to discover plans.`,
			].join(" "),
			tags: ["discovery", "catalog", "x402"],
			examples: [`GET ${baseUrl}/discover`],
			endpoint: { url: `${baseUrl}/discover`, method: "GET" },
		},
		{
			id: "access",
			name: "Access",
			description: [
				`Purchase access to a ${config.agentName} product plan via x402 payment on ${networkName}.`,
				`First call discover to get available plans.`,
				`Then POST to ${baseUrl}/x402/access with planId and requestId to initiate purchase.`,
				`Server responds with x402 payment challenge.`,
				`Complete payment on-chain and include PAYMENT-SIGNATURE header to receive access token.`,
			].join(" "),
			tags: ["payment", "x402", "purchase"],
			examples: [
				`POST ${baseUrl}/x402/access with { planId: "<plan-id>", requestId: "<uuid>", resourceId: "default" }`,
				`Receive 402 with payment challenge`,
				`Pay USDC on-chain, retry same request with PAYMENT-SIGNATURE header`,
				`Receive 200 with access token`,
			],
			endpoint: { url: `${baseUrl}/x402/access`, method: "POST" },
			inputSchema: {
				type: "object",
				required: ["planId", "requestId"],
				properties: {
					planId: { type: "string", enum: planIds },
					requestId: { type: "string", format: "uuid" },
				},
			},
			workflow: [
				"POST body with planId + requestId to endpoint.url — expect 402",
				"Extract payment requirements from 402 response body",
				`Sign and broadcast USDC transfer on ${networkName}`,
				"Retry same POST with PAYMENT-SIGNATURE header containing the transaction hash",
				"Receive 200 with accessToken",
			],
		},
	];

	// Per-request skills: one skill per route in config.routes.
	for (const route of config.routes ?? []) {
		const skillId = `ppr-${route.routeId}-${route.method.toLowerCase()}-${route.path.replace(/\//g, "-").replace(/[: ]/g, "")}`;

		// Build path param properties from auto-detected :param names
		const pathParamNames = [...route.path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1] ?? "");
		const explicitParams = route.params ?? [];

		// Path param schema: auto-detected names, enriched with any descriptions from explicit params
		const pathParamProperties: Record<string, { type: string; description?: string }> = {};
		for (const name of pathParamNames) {
			const explicit = explicitParams.find((p) => p.in === "path" && p.name === name);
			pathParamProperties[name] = {
				type: explicit?.type ?? "string",
				...(explicit?.description ? { description: explicit.description } : {}),
			};
		}

		// Query param schema
		const queryParams = explicitParams.filter((p) => p.in === "query");
		const queryParamProperties: Record<string, { type: string; description?: string }> = {};
		const requiredQueryParams: string[] = [];
		for (const qp of queryParams) {
			queryParamProperties[qp.name] = {
				type: qp.type ?? "string",
				...(qp.description ? { description: qp.description } : {}),
			};
			if (qp.required) requiredQueryParams.push(qp.name);
		}

		// Body param schema
		const bodyParams = explicitParams.filter((p) => p.in === "body");
		const bodyParamProperties: Record<string, { type: string; description?: string }> = {};
		const requiredBodyParams: string[] = [];
		for (const bp of bodyParams) {
			bodyParamProperties[bp.name] = {
				type: bp.type ?? "string",
				...(bp.description ? { description: bp.description } : {}),
			};
			if (bp.required) requiredBodyParams.push(bp.name);
		}

		// Build concrete example path (replace :param with <param>)
		const examplePath = route.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "<$1>");

		// Resource schema: path + optional query/body
		const resourceProperties: Record<string, unknown> = {
			method: { type: "string", const: route.method },
			path: {
				type: "string",
				description: `Path pattern: ${route.path}. Example: ${examplePath}`,
				...(pathParamNames.length > 0
					? { pathParams: { type: "object", required: pathParamNames, properties: pathParamProperties } }
					: {}),
			},
		};
		if (queryParams.length > 0) {
			resourceProperties["query"] = {
				type: "object",
				...(requiredQueryParams.length > 0 ? { required: requiredQueryParams } : {}),
				properties: queryParamProperties,
			};
		}
		if (bodyParams.length > 0) {
			resourceProperties["body"] = {
				type: "object",
				...(requiredBodyParams.length > 0 ? { required: requiredBodyParams } : {}),
				properties: bodyParamProperties,
			};
		}

		skills.push({
			id: skillId,
			name: `${route.method} ${route.path}`,
			description:
				route.description ??
				(route.unitAmount
					? `Pay-per-call: ${route.unitAmount} USDC per request.`
					: `Free endpoint: ${route.method} ${route.path}`),
			tags: route.unitAmount ? ["pay-per-call", "x402"] : ["free"],
			endpoint: { url: `${baseUrl}/x402/access`, method: "POST" },
			inputSchema: {
				type: "object",
				required: ["routeId", "resource"],
				properties: {
					routeId: { type: "string", const: route.routeId },
					resource: {
						type: "object",
						required: ["method", "path"],
						properties: resourceProperties,
					},
				},
			},
			workflow: route.unitAmount
				? [
						`POST { routeId: "${route.routeId}", resource: { method: "${route.method}", path: "${examplePath}"${queryParams.length > 0 ? ", query: {...}" : ""}${bodyParams.length > 0 ? ", body: {...}" : ""} } }`,
						"Receive 402 with payment requirements",
						`Pay ${route.unitAmount} USDC on-chain`,
						"Retry with PAYMENT-SIGNATURE header",
						"Receive 200 with ResourceResponse containing the API response",
					]
				: [
						`POST { routeId: "${route.routeId}", resource: { method: "${route.method}", path: "${examplePath}" } }`,
						"Free route — no payment required",
						"Receive 200 with ResourceResponse",
					],
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
					description: safeRoute.description ?? defaultDescription,
					tags: ["pay-per-request", "x402", plan.planId],
					endpoint: { url: `${baseUrl}/x402/access`, method: "POST" },
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
					workflow: [
						`POST { planId: "${plan.planId}", resource: { method: "${safeRoute.method}", path: "<actual path>" } }`,
						"Receive 402 with payment requirements",
						`Pay ${plan.unitAmount} USDC on-chain`,
						"Retry with PAYMENT-SIGNATURE header",
						"Receive 200 with ResourceResponse",
					],
				} satisfies AgentSkill);
			} else {
				// Embedded mode: client calls the route directly with PAYMENT-SIGNATURE
				skills.push({
					id: skillId,
					name: `${safeRoute.method} ${safeRoute.path}`,
					description: safeRoute.description ?? defaultDescription,
					tags: ["pay-per-request", "x402", plan.planId],
					endpoint: {
						url: `${baseUrl}${safeRoute.path}`,
						method: safeRoute.method as "GET" | "POST",
					},
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
