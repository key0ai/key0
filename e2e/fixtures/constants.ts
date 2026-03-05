/** Shared constants for e2e tests. */

export const AGENTGATE_URL = "http://localhost:3000";
export const BACKEND_URL = "http://localhost:3001";

// Base Sepolia testnet
export const CHAIN_ID = 84532;
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
export const USDC_DOMAIN = { name: "USDC", version: "2" } as const;

/** Default tier configured in the Docker server's PRODUCTS env */
export const DEFAULT_TIER_ID = "basic";
export const DEFAULT_TIER_AMOUNT_MICRO = 100_000n; // $0.10 USDC

/** Refund-fail stack constants (refund-failure.test.ts) */
export const REFUND_FAIL_AGENTGATE_URL = "http://localhost:3020";
export const REFUND_FAIL_REDIS_URL = "redis://localhost:6381";

/** Refund cron timing (matches docker-compose.e2e.yml) */
export const REFUND_INTERVAL_MS = 5000;
export const REFUND_MIN_AGE_MS = 3000;
/** Poll timeout for refund assertions: interval + min age + buffer */
export const REFUND_POLL_TIMEOUT_MS = 30_000;
