import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { buildAgentCard, ChallengeEngine } from "./core/index.js";
import { Key0Executor } from "./executor.js";
import type {
	AgentCard,
	IChallengeStore,
	IPaymentAdapter,
	ISeenTxStore,
	SellerConfig,
} from "./types/index.js";

export type Key0Config = {
	readonly config: SellerConfig;
	readonly adapter: IPaymentAdapter;
	readonly store: IChallengeStore;
	readonly seenTxStore: ISeenTxStore;
};

export type Key0Instance = {
	requestHandler: DefaultRequestHandler;
	agentCard: AgentCard;
	engine: ChallengeEngine;
	executor: Key0Executor;
};

export function createKey0(opts: Key0Config): Key0Instance {
	// Warn if proxyTo is configured without proxySecret
	if (opts.config.proxyTo && !opts.config.proxyTo.proxySecret) {
		console.warn(
			"[Key0] Warning: proxyTo is configured without proxySecret. " +
				"Set KEY0_PROXY_SECRET and pass it as proxyTo.proxySecret to require " +
				"X-Key0-Internal-Token validation on your backend.",
		);
	}

	if (!opts.store) {
		throw new Error(
			"[Key0] store is required. Use RedisChallengeStore for production.\n" +
				"  import { RedisChallengeStore } from '@key0ai/key0';\n" +
				"  const store = new RedisChallengeStore({ redis });",
		);
	}
	if (!opts.seenTxStore) {
		throw new Error(
			"[Key0] seenTxStore is required. Use RedisSeenTxStore for production.\n" +
				"  import { RedisSeenTxStore } from '@key0ai/key0';\n" +
				"  const seenTxStore = new RedisSeenTxStore({ redis });",
		);
	}
	const store = opts.store;
	const seenTxStore = opts.seenTxStore;

	const engine = new ChallengeEngine({
		config: opts.config,
		store,
		seenTxStore,
		adapter: opts.adapter,
	});

	const executor = new Key0Executor(engine, opts.config);
	const agentCard = buildAgentCard(opts.config);

	const requestHandler = new DefaultRequestHandler(
		agentCard as any,
		new InMemoryTaskStore(),
		executor,
	);

	return { requestHandler, agentCard, engine, executor };
}
