import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
	ChallengeEngine,
	InMemoryChallengeStore,
	InMemorySeenTxStore,
	buildAgentCard,
} from "./core/index.js";
import { AgentGateExecutor } from "./executor.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
	/** When true, also creates an MCP server with payment tools (get_pricing, request_access, submit_proof). */
	readonly mcp?: boolean | undefined;
};

export type AgentGateInstance = {
	requestHandler: DefaultRequestHandler;
	agentCard: AgentCard;
	engine: ChallengeEngine;
	executor: AgentGateExecutor;
	/** Present when `mcp: true` was set in config. Connect a transport to start serving. */
	mcpServer?: McpServer | undefined;
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

	let mcpServer: McpServer | undefined;
	if (opts.mcp) {
		// Dynamic import to keep @modelcontextprotocol/sdk optional
		const { buildMcpServer } = require("./mcp/server.js") as typeof import("./mcp/server.js");
		mcpServer = buildMcpServer(engine, opts.config);
	}

	if (process.env["NODE_ENV"] !== "test") {
		const basePath = opts.config.basePath ?? "/a2a";
		console.log(`\n[AgentGate] ${opts.config.agentName}`);
		console.log(`  Agent card:  /.well-known/agent.json`);
		console.log(`  A2A:         ${basePath}/jsonrpc`);
		if (mcpServer) {
			console.log(`  MCP:         /mcp  (tools: get_pricing, request_access, submit_proof)`);
		}
		console.log(`  Network:     ${opts.config.network}`);
		console.log(`  Wallet:      ${opts.config.walletAddress}\n`);
	}

	return { requestHandler, agentCard, engine, executor, mcpServer };
}
