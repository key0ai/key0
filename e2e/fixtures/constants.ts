/** Shared constants for e2e tests. */

export const KEY0_URL = "http://localhost:3000";
export const BACKEND_URL = "http://localhost:3001";

// Base Sepolia testnet
export const CHAIN_ID = 84532;
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
export const USDC_DOMAIN = { name: "USDC", version: "2" } as const;

/** Default plan configured in the Docker server's PLANS env */
export const DEFAULT_TIER_ID = "basic";
export const DEFAULT_TIER_AMOUNT_MICRO = 100_000n; // $0.10 USDC

/** PPR / gateway stack constants (docker-compose.e2e-ppr.yml) */
export const PPR_KEY0_URL = "http://localhost:3002";
export const PPR_WEATHER_ROUTE_ID = "weather-query";
export const PPR_JOKE_ROUTE_ID = "joke-of-the-day";
export const GATEWAY_KEY0_URL = PPR_KEY0_URL;
export const GATEWAY_FREE_PLAN_ID = "status";
export const GATEWAY_SIGNAL_PLAN_ID = "weather-by-city";
export const GATEWAY_PROXY_SECRET = "e2e-gateway-proxy-secret-32-chars!";

/** Refund-fail stack constants (refund-failure.test.ts) */
export const REFUND_FAIL_KEY0_URL = "http://localhost:3020";
export const REFUND_FAIL_REDIS_URL = "redis://localhost:6381";

/** Refund cron timing (matches docker-compose.e2e.yml) */
export const REFUND_INTERVAL_MS = 5000;
export const REFUND_MIN_AGE_MS = 3000;
/**
 * Poll timeout for refund assertions.
 * Refunds go through the gas wallet lock (serialised), and each on-chain
 * transferWithAuthorization on Base Sepolia can take up to 30 s.
 * The batch test writes 3 records; with serialised settlement the worst-case
 * wall-clock time is ~3 × 30 s = 90 s, plus the cron interval (5 s) and
 * min-age guard (3 s).  Use 120 s to give a comfortable margin.
 */
export const REFUND_POLL_TIMEOUT_MS = 120_000;
