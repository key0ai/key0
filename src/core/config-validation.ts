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

	// Validate products array
	if (!config.products || config.products.length === 0) {
		throw new Error("SellerConfig: products must contain at least one tier");
	}

	// Validate each product tier
	const tierIds = new Set<string>();
	for (const tier of config.products) {
		if (!tier.tierId || tier.tierId.trim().length === 0) {
			throw new Error("SellerConfig: each product tier must have a non-empty tierId");
		}

		if (tierIds.has(tier.tierId)) {
			throw new Error(`SellerConfig: duplicate tierId "${tier.tierId}"`);
		}
		tierIds.add(tier.tierId);

		try {
			validateDollarAmount(tier.amount, `products[${tier.tierId}].amount`);
		} catch {
			throw new Error(
				`SellerConfig: product tier "${tier.tierId}" has invalid amount "${tier.amount}" (expected format: "$X.XX")`,
			);
		}
	}

	// Validate onVerifyResource is a function
	if (typeof config.onVerifyResource !== "function") {
		throw new Error("SellerConfig: onVerifyResource must be a function");
	}

	// Validate onIssueToken is a function
	if (typeof config.onIssueToken !== "function") {
		throw new Error("SellerConfig: onIssueToken must be a function");
	}
}
