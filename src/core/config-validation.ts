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

	// Validate plans array
	if (!config.plans || config.plans.length === 0) {
		throw new Error("SellerConfig: plans must contain at least one plan");
	}

	// Validate each plan
	const planIds = new Set<string>();
	for (const plan of config.plans) {
		if (!plan.planId || plan.planId.trim().length === 0) {
			throw new Error("SellerConfig: each plan must have a non-empty planId");
		}

		if (planIds.has(plan.planId)) {
			throw new Error(`SellerConfig: duplicate planId "${plan.planId}"`);
		}
		planIds.add(plan.planId);

		if (!plan.free) {
			try {
				validateDollarAmount(plan.unitAmount!, `plans[${plan.planId}].unitAmount`);
			} catch {
				throw new Error(
					`SellerConfig: plan "${plan.planId}" has invalid unitAmount "${plan.unitAmount}" (expected format: "$X.XX")`,
				);
			}
		}
	}

	// Only require fetchResourceCredentials if there are subscription plans
	const hasSubscriptionPlans = config.plans.some((p) => !p.free && p.mode !== "per-request");
	if (hasSubscriptionPlans && typeof config.fetchResourceCredentials !== "function") {
		throw new Error("SellerConfig: fetchResourceCredentials is required for subscription plans");
	}
}
