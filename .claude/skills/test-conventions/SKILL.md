---
name: test-conventions
description: Exact bun:test conventions for the AgentGate SDK. Covers imports, factory helpers, injectable clock, store patterns, concurrency assertions, error assertions, and mock adapter usage.
---

# AgentGate Test Conventions

All tests use `bun:test`. Never use jest or vitest.

---

## Imports

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { MockPaymentAdapter } from "../../test-utils";
import {
	type AccessRequest,
	AgentGateError,
	type PaymentProof,
	type SellerConfig,
} from "../../types";
import { ChallengeEngine, type ChallengeEngineConfig } from "../challenge-engine.js";
import { InMemoryChallengeStore, InMemorySeenTxStore } from "../storage/memory.js";
```

---

## Factory Helper Pattern

Every test file exercising `ChallengeEngine` defines three helpers. Never inline config objects in individual tests.

```ts
const WALLET = `0x${"ab".repeat(20)}` as `0x${string}`;

function makeConfig(overrides?: Partial<SellerConfig>): SellerConfig {
	return {
		agentName: "Test Agent",
		agentDescription: "Test",
		agentUrl: "https://agent.example.com",
		providerName: "Provider",
		providerUrl: "https://provider.example.com",
		walletAddress: WALLET,
		network: "testnet",
		products: [{ tierId: "single", label: "Single Photo", amount: "$0.10", resourceType: "photo" }],
		challengeTTLSeconds: 900,
		onVerifyResource: async () => true,
		onIssueToken: async (params) => ({
			token: `tok_${params.challengeId}`,
			expiresAt: new Date(Date.now() + 3600 * 1000),
			tokenType: "Bearer",
		}),
		...overrides,
	};
}

function makeEngine(opts?: {
	config?: Partial<SellerConfig>;
	adapter?: MockPaymentAdapter;
	clock?: () => number;
	store?: InMemoryChallengeStore;
	seenTxStore?: InMemorySeenTxStore;
}) {
	const adapter = opts?.adapter ?? new MockPaymentAdapter();
	const store = opts?.store ?? new InMemoryChallengeStore();
	const seenTxStore = opts?.seenTxStore ?? new InMemorySeenTxStore();
	const config = makeConfig(opts?.config);
	const engineConfig: ChallengeEngineConfig = {
		config,
		store,
		seenTxStore,
		adapter,
		...(opts?.clock ? { clock: opts.clock } : {}),
	};
	return { engine: new ChallengeEngine(engineConfig), adapter, store, seenTxStore };
}

function makeRequest(overrides?: Partial<AccessRequest>): AccessRequest {
	return {
		requestId: crypto.randomUUID(),
		resourceId: "photo-42",
		tierId: "single",
		clientAgentId: "agent://test-client",
		...overrides,
	};
}

function makeTxHash(): `0x${string}` {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}` as `0x${string}`;
}
```

---

## Injectable Clock for Time-Travel

Never use `setTimeout` or manipulate `Date.now`. Use the `clock` parameter:

```ts
let now = Date.now();
const clock = () => now;
const { engine } = makeEngine({ clock });

// Advance past TTL
now += 901_000;

// Now test expiry behavior
```

---

## InMemoryChallengeStore Pattern

When creating a store **directly in a test** (not via `makeEngine`), always pass `cleanupIntervalMs: 0` and call `stopCleanup()` when done:

```ts
const store = new InMemoryChallengeStore({ cleanupIntervalMs: 0 });
// ... test ...
store.stopCleanup();
```

When reused across tests:
```ts
afterEach(() => { store.stopCleanup(); });
```

`makeEngine()` omits `cleanupIntervalMs: 0` intentionally — the default timer is `unref()`'d so it won't block process exit.

### `makeChallengeRecord` — for store-level tests

When testing store transitions directly (not through the engine), use this helper:

```ts
function makeChallengeRecord(overrides?: Partial<ChallengeRecord>): ChallengeRecord {
	return {
		challengeId: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		clientAgentId: "agent://test",
		resourceId: "photo-42",
		tierId: "single",
		amount: "$0.10",
		amountRaw: 100000n,
		asset: "USDC",
		chainId: 84532,
		destination: `0x${"ab".repeat(20)}` as `0x${string}`,
		state: "PENDING",
		expiresAt: new Date(Date.now() + 900_000),
		createdAt: new Date(),
		...overrides,
	};
}
```

Import `ChallengeRecord` from `../../types`.

---

## Concurrency Assertions

Use `Promise.all` + filter-Boolean. Never `Promise.race` or sequential calls:

```ts
// Two-way race
const [a, b] = await Promise.all([
	store.transition(id, "PENDING", "PAID", { txHash, paidAt: new Date() }),
	store.transition(id, "PENDING", "EXPIRED"),
]);
expect([a, b].filter(Boolean).length).toBe(1);

// Three-way race
const results = await Promise.all([
	store.transition(id, "PENDING", "PAID"),
	store.transition(id, "PENDING", "EXPIRED"),
	store.transition(id, "PENDING", "CANCELLED"),
]);
expect(results.filter(Boolean).length).toBe(1);
```

---

## Error Assertions

Always assert both `.code` and `.httpStatus` on `AgentGateError`:

```ts
const err = await engine.submitProof(proof).catch((e) => e);
expect(err).toBeInstanceOf(AgentGateError);
expect(err.code).toBe("CHALLENGE_NOT_FOUND");
expect(err.httpStatus).toBe(404);
```

---

## MockPaymentAdapter

Control verification outcomes with `setVerifyResult()`:

```ts
const adapter = new MockPaymentAdapter();
adapter.setVerifyResult({ success: true });
// or
adapter.setVerifyResult({ success: false, error: "Transfer not found" });
```

Default is `{ success: true }`.

---

## Test Organization

- One `describe` block per concept (state transitions, error paths, callbacks, concurrency)
- Happy path tests before error/edge cases within each `describe`
- Test names describe the scenario, not the function:
  - GOOD: `"returns EXPIRED error after TTL elapses"`
  - BAD: `"processRequest with expired challenge"`
