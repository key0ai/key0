#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentGate } from "../factory.js";
import type { AgentGateConfig } from "../factory.js";

/**
 * Standalone MCP server entry point.
 *
 * Loads seller config from a file specified by AGENTGATE_CONFIG env var,
 * creates the AgentGate MCP server, and connects via stdio transport.
 *
 * Usage:
 *   AGENTGATE_CONFIG=./my-config.ts bun run src/mcp/stdio.ts
 */
async function loadConfig(): Promise<AgentGateConfig> {
	const configPath = process.env["AGENTGATE_CONFIG"];

	if (!configPath) {
		throw new Error(
			"AGENTGATE_CONFIG environment variable is required.\n" +
				"Set it to the path of your config file (e.g. ./agentgate.config.ts)\n" +
				"The file must export a default or named 'config' of type AgentGateConfig.",
		);
	}

	const resolved = configPath.startsWith("/") ? configPath : `${process.cwd()}/${configPath}`;
	const mod = await import(resolved);

	const config: AgentGateConfig | undefined = mod.default ?? mod.config;
	if (!config) {
		throw new Error(
			`Config file ${configPath} must export a default or named "config" of type AgentGateConfig.`,
		);
	}

	return config;
}

async function main() {
	const config = await loadConfig();
	const { mcpServer } = createAgentGate({ ...config, mcp: true });

	if (!mcpServer) {
		throw new Error("MCP server was not created. Ensure @modelcontextprotocol/sdk is installed.");
	}

	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);
	console.error(`[AgentGate MCP] "${config.config.agentName}" running on stdio`);
}

main().catch((err) => {
	console.error("[AgentGate MCP] Fatal error:", err);
	process.exit(1);
});
