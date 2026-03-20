import type { SellerConfig } from "../types/index.js";
import { validateAddress, validateDollarAmount } from "./validation.js";

/**
 * Validate a SellerConfig at startup — fail fast on misconfiguration.
 * Throws descriptive errors for each invalid field.
 */
export function validateSellerConfig(config: SellerConfig): void {
	if (!config.agentName || config.agentName.trim().length === 0) {
		throw new Error("SellerConfig: agentName must not be empty");
	}

	if (!config.agentUrl || config.agentUrl.trim().length === 0) {
		throw new Error("SellerConfig: agentUrl must not be empty");
	}

	if (!config.providerName || config.providerName.trim().length === 0) {
		throw new Error("SellerConfig: providerName must not be empty");
	}

	// Validate wallet address format
	try {
		validateAddress(config.walletAddress);
	} catch {
		throw new Error(
			`SellerConfig: walletAddress "${config.walletAddress}" is not a valid 0x-prefixed 40-char hex address`,
		);
	}

	// Validate network
	if (config.network !== "mainnet" && config.network !== "testnet") {
		throw new Error(
			`SellerConfig: network must be "mainnet" or "testnet", got "${config.network}"`,
		);
	}

	const hasPlans = (config.plans?.length ?? 0) > 0;
	const hasRoutes = (config.routes?.length ?? 0) > 0;

	// Plans require fetchResourceCredentials
	const hasSubscriptionPlans = (config.plans ?? []).some((p) => !p.free);
	if (hasSubscriptionPlans && typeof config.fetchResourceCredentials !== "function") {
		throw new Error("fetchResourceCredentials is required when plans are configured");
	}

	// Developer mode — warn but don't throw
	if (!hasPlans && !hasRoutes) {
		console.warn("[key0] Warning: no plans or routes configured");
	}

	// Validate each plan
	if (hasPlans) {
		const planIds = new Set<string>();
		for (const plan of config.plans!) {
			if (!plan.planId || plan.planId.trim().length === 0) {
				throw new Error("SellerConfig: each plan must have a non-empty planId");
			}

			if (planIds.has(plan.planId)) {
				throw new Error(`SellerConfig: duplicate planId "${plan.planId}"`);
			}
			planIds.add(plan.planId);

			if (!plan.free) {
				if (!plan.unitAmount) {
					throw new Error(
						`SellerConfig: plan "${plan.planId}" must have a unitAmount (or set free: true)`,
					);
				}
				try {
					validateDollarAmount(plan.unitAmount, `plans[${plan.planId}].unitAmount`);
				} catch {
					throw new Error(
						`SellerConfig: plan "${plan.planId}" has invalid unitAmount "${plan.unitAmount}" (expected format: "$X.XX")`,
					);
				}
			}

			const rawPlan = plan as Record<string, unknown>;
			if ("mode" in rawPlan) {
				throw new Error(
					`SellerConfig: plan "${plan.planId}" uses removed mode field. Pay-per-call must be defined with top-level routes.`,
				);
			}
			if ("routes" in rawPlan) {
				throw new Error(
					`SellerConfig: plan "${plan.planId}" uses removed plans[].routes. Pay-per-call must be defined with top-level routes.`,
				);
			}
			if ("proxyPath" in rawPlan || "proxyQuery" in rawPlan || "proxyMethod" in rawPlan) {
				throw new Error(
					`SellerConfig: plan "${plan.planId}" uses removed proxyPath-based pay-per-call config. Define callable endpoints with top-level routes instead.`,
				);
			}
		}
	}

	// Validate each route
	if (hasRoutes) {
		const routeIds = new Set<string>();
		const planIds = new Set((config.plans ?? []).map((plan) => plan.planId));
		for (const route of config.routes!) {
			if (!route.routeId?.trim()) throw new Error("each route must have a routeId");
			if (!route.path?.startsWith("/"))
				throw new Error(`route "${route.routeId}": path must start with "/"`);
			if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(route.method)) {
				throw new Error(`route "${route.routeId}": invalid method "${route.method}"`);
			}
			if (route.unitAmount) {
				try {
					validateDollarAmount(route.unitAmount, `routes[${route.routeId}].unitAmount`);
				} catch {
					throw new Error(
						`route "${route.routeId}": invalid unitAmount "${route.unitAmount}" (expected format: "$X.XX")`,
					);
				}
			}
			if (routeIds.has(route.routeId)) throw new Error(`duplicate routeId: "${route.routeId}"`);
			if (planIds.has(route.routeId)) {
				throw new Error(
					`route "${route.routeId}": routeId must not overlap an existing planId`,
				);
			}
			routeIds.add(route.routeId);
		}
		if (config.proxyTo && !config.proxyTo.proxySecret) {
			console.warn(
				"[key0] Warning: proxyTo.proxySecret not set — backend cannot verify Key0 origin",
			);
		}
	}
}
