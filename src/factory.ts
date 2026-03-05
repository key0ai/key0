import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { ChallengeEngine, buildAgentCard } from "./core/index.js";
import { AgentGateExecutor } from "./executor.js";
import type {
	AgentCard,
	IChallengeStore,
	IPaymentAdapter,
	ISeenTxStore,
	SellerConfig,
} from "./types/index.js";

export type AgentGateConfig = {
	readonly config: SellerConfig;
	readonly adapter: IPaymentAdapter;
	readonly store: IChallengeStore;
	readonly seenTxStore: ISeenTxStore;
};

export type AgentGateInstance = {
	requestHandler: DefaultRequestHandler;
	agentCard: AgentCard;
	engine: ChallengeEngine;
	executor: AgentGateExecutor;
};

export function createAgentGate(opts: AgentGateConfig): AgentGateInstance {
	if (!opts.store) {
		throw new Error(
			"[AgentGate] store is required. Use RedisChallengeStore for production.\n" +
				"  import { RedisChallengeStore } from '@riklr/agentgate';\n" +
				"  const store = new RedisChallengeStore({ redis });",
		);
	}
	if (!opts.seenTxStore) {
		throw new Error(
			"[AgentGate] seenTxStore is required. Use RedisSeenTxStore for production.\n" +
				"  import { RedisSeenTxStore } from '@riklr/agentgate';\n" +
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

	const executor = new AgentGateExecutor(engine, opts.config);
	const agentCard = buildAgentCard(opts.config);

	const requestHandler = new DefaultRequestHandler(
		agentCard as any,
		new InMemoryTaskStore(),
		executor,
	);

	return { requestHandler, agentCard, engine, executor };
}
