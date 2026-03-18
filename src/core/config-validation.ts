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
	if (hasPlans && typeof config.fetchResourceCredentials !== "function") {
		throw new Error("fetchResourceCredentials is required when plans are configured");
	}

	// Routes require proxyTo
	if (hasRoutes && !config.proxyTo) {
		throw new Error("proxyTo is required when routes are configured");
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

			try {
				validateDollarAmount(plan.unitAmount, `plans[${plan.planId}].unitAmount`);
			} catch {
				throw new Error(
					`SellerConfig: plan "${plan.planId}" has invalid unitAmount "${plan.unitAmount}" (expected format: "$X.XX")`,
				);
			}
		}
	}

	// Validate each route
	if (hasRoutes) {
		const routeIds = new Set<string>();
		for (const route of config.routes!) {
			if (!route.routeId?.trim()) throw new Error("each route must have a routeId");
			if (!route.path?.startsWith("/"))
				throw new Error(`route "${route.routeId}": path must start with "/"`);
			if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(route.method)) {
				throw new Error(`route "${route.routeId}": invalid method "${route.method}"`);
			}
			if (route.unitAmount && !route.unitAmount.match(/^\$\d+\.\d{2}$/)) {
				throw new Error(
					`route "${route.routeId}": unitAmount must be in format "$X.XX"`,
				);
			}
			if (routeIds.has(route.routeId)) throw new Error(`duplicate routeId: "${route.routeId}"`);
			routeIds.add(route.routeId);
		}
		if (!config.proxyTo?.proxySecret) {
			console.warn("[key0] Warning: proxyTo.proxySecret not set — backend cannot verify Key0 origin");
		}
	}
}
