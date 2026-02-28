import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
	ChallengeEngine,
	InMemoryChallengeStore,
	InMemorySeenTxStore,
	buildAgentCard,
} from "./core/index.js";
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
	readonly store?: IChallengeStore | undefined;
	readonly seenTxStore?: ISeenTxStore | undefined;
};

export type AgentGateInstance = {
	requestHandler: DefaultRequestHandler;
	agentCard: AgentCard;
	engine: ChallengeEngine;
	executor: AgentGateExecutor;
};

export function createAgentGate(opts: AgentGateConfig): AgentGateInstance {
	const store = opts.store ?? new InMemoryChallengeStore();
	const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore();

	const engine = new ChallengeEngine({
		config: opts.config,
		store,
		seenTxStore,
		adapter: opts.adapter,
	});

	const executor = new AgentGateExecutor(engine);
	const agentCard = buildAgentCard(opts.config);

	const requestHandler = new DefaultRequestHandler(
		// biome-ignore lint/suspicious/noExplicitAny: our AgentCard type has extra fields vs the SDK's strict type
		agentCard as any,
		new InMemoryTaskStore(),
		executor,
	);

	return { requestHandler, agentCard, engine, executor };
}
