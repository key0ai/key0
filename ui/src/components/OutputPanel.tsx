import { useEffect, useState } from "react";
import {
	generateAgentCardTerminal,
	generateDockerCompose,
	generateDockerRun,
	generateEnv,
	generateMcpTerminal,
	type TerminalBlock,
} from "../generate";
import type { Config } from "../types";

type Group = "preview" | "deploy";
type PreviewTab = "agent-card" | "mcp";
type DeployTab = "env" | "docker-run" | "docker-compose";

interface OutputPanelProps {
	config: Config;
}

/* ── Collapsible JSON block ─────────────────────────────────────────────────── */

function CollapsibleJson({ summary, text }: { summary: string; text: string }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="pl-2 mt-1">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 text-[#636363] hover:text-[#a0a0a0] transition-colors cursor-pointer"
			>
				<span
					className="inline-block transition-transform duration-200"
					style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
				>
					▶
				</span>
				<span>{summary}</span>
			</button>
			{open && (
				<pre className="mt-1 ml-4 text-[#c8c8c8] whitespace-pre-wrap break-all border-l border-[#333] pl-3">
					{text}
				</pre>
			)}
		</div>
	);
}

/* ── Terminal renderer ─────────────────────────────────────────────────────── */

function TerminalView({ blocks }: { blocks: TerminalBlock[] }) {
	return (
		<div className="font-mono text-xs leading-relaxed space-y-1">
			{blocks.map((b, i) => {
				const key = `${b.kind}-${i}`;
				switch (b.kind) {
					case "comment":
						return (
							<div key={key} className="text-[#636363] mt-4 first:mt-0">
								{b.text}
							</div>
						);
					case "command":
						return (
							<div key={key} className="mt-2 first:mt-0">
								<span className="text-[#7ec699]">$ </span>
								<span className="text-[#e0e0e0]">{b.text}</span>
							</div>
						);
					case "prompt":
						return (
							<div key={key} className="mt-4 first:mt-0">
								<span className="text-[#6cb6ff]">❯ </span>
								<span className="text-[#e0e0e0]">{b.text}</span>
							</div>
						);
					case "status":
						return (
							<div key={key} className="mt-2 whitespace-pre-wrap">
								<span className="text-[#d4a054]">⏺ </span>
								<span className="text-[#c8c8c8]">{b.text}</span>
							</div>
						);
					case "table":
						return (
							<pre key={key} className="text-[#e0e0e0] whitespace-pre pl-4 my-1">
								{b.text}
							</pre>
						);
					case "output":
						return (
							<div key={key} className="text-[#a0a0a0] whitespace-pre-wrap pl-2">
								{b.text}
							</div>
						);
					case "json":
						return (
							<pre key={key} className="text-[#c8c8c8] whitespace-pre-wrap break-all pl-2">
								{b.text}
							</pre>
						);
					case "collapsible-json":
						return <CollapsibleJson key={key} summary={b.summary ?? "{ ... }"} text={b.text} />;
					default:
						return null;
				}
			})}
		</div>
	);
}

/* ── Output Panel ──────────────────────────────────────────────────────────── */

export function OutputPanel({ config }: OutputPanelProps) {
	const [group, setGroup] = useState<Group>("preview");
	const [previewTab, setPreviewTab] = useState<PreviewTab>("agent-card");
	const [deployTab, setDeployTab] = useState<DeployTab>("env");
	const [copied, setCopied] = useState(false);

	// Hide "docker run" when compose-managed infra is detected —
	// internal hostnames only resolve inside the compose network, so
	// docker run alone can't start the bundled Redis/Postgres services.
	const hasManagedInfra =
		config.redisUrl === "redis://redis:6379" ||
		config.databaseUrl === "postgresql://key0:key0@postgres:5432/key0";

	// Auto-switch away from docker-run when user selects managed infra
	useEffect(() => {
		if (hasManagedInfra && deployTab === "docker-run") {
			setDeployTab("docker-compose");
		}
	}, [hasManagedInfra, deployTab]);

	const agentCardBlocks = generateAgentCardTerminal(config);
	const mcpBlocks = generateMcpTerminal(config);

	const previewTabs = {
		...(config.a2aEnabled ? { "agent-card": { label: "Agent Card" } } : {}),
		...(config.mcpEnabled ? { mcp: { label: "MCP" } } : {}),
	} as Partial<Record<PreviewTab, { label: string }>>;

	useEffect(() => {
		if (group !== "preview") return;
		if (previewTab === "agent-card" && !config.a2aEnabled) {
			if (config.mcpEnabled) setPreviewTab("mcp");
			else setGroup("deploy");
		}
		if (previewTab === "mcp" && !config.mcpEnabled) {
			if (config.a2aEnabled) setPreviewTab("agent-card");
			else setGroup("deploy");
		}
	}, [config.a2aEnabled, config.mcpEnabled, group, previewTab]);

	const allDeployOutputs: Record<DeployTab, { label: string; content: string; filename?: string }> =
		{
			env: { label: ".env", content: generateEnv(config), filename: ".env" },
			"docker-run": { label: "docker run", content: generateDockerRun(config) },
			"docker-compose": {
				label: "docker-compose.yml",
				content: generateDockerCompose(config),
				filename: "docker-compose.yml",
			},
		};

	// Filter out docker-run tab when managed infra is in use.
	// Cast back to Record<DeployTab,…> — safe at runtime because the useEffect
	// above switches deployTab away from "docker-run" before it can be accessed.
	const deployOutputs = (
		hasManagedInfra
			? (({ "docker-run": _omit, ...rest }) => rest)(allDeployOutputs)
			: allDeployOutputs
	) as Record<DeployTab, { label: string; content: string; filename?: string }>;

	const getActiveContent = (): string => {
		if (group === "deploy") return deployOutputs[deployTab].content;
		if (previewTab === "mcp") return mcpBlocks.map((b) => b.text).join("\n\n");
		return agentCardBlocks.map((b) => b.text).join("\n\n");
	};

	const copy = async () => {
		await navigator.clipboard.writeText(getActiveContent());
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const download = () => {
		const filename = group === "deploy" ? deployOutputs[deployTab].filename : undefined;
		if (!filename) return;
		const blob = new Blob([getActiveContent()], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	const hasFilename = group === "deploy" && deployOutputs[deployTab].filename !== undefined;

	const groupBtn = (g: Group, label: string) => (
		<button
			type="button"
			onClick={() => {
				setGroup(g);
				setCopied(false);
			}}
			className={`px-4 py-2 text-xs font-semibold transition-all duration-300 ease-out ${
				group === g
					? "text-foreground border-b-2 border-foreground"
					: "text-muted hover:text-foreground border-b-2 border-transparent"
			}`}
		>
			{label}
		</button>
	);

	const tabEntries =
		group === "preview"
			? (Object.entries(previewTabs) as [PreviewTab, { label: string }][])
			: (Object.entries(deployOutputs) as [DeployTab, { label: string }][]);

	const activeTabKey = group === "preview" ? previewTab : deployTab;

	const setActiveTab = (key: string) => {
		setCopied(false);
		if (group === "preview") setPreviewTab(key as PreviewTab);
		else setDeployTab(key as DeployTab);
	};

	const isPreview = group === "preview";

	return (
		<div className="flex h-full flex-col rounded-card bg-surface shadow-neu">
			{/* Group selector */}
			<div className="flex items-center gap-0 px-4 pt-3">
				{groupBtn("preview", "Experience")}
				{groupBtn("deploy", "Deploy")}
			</div>

			{/* Tab bar */}
			<div className="flex items-center gap-1 px-4 pt-3">
				{tabEntries.map(([key, val]) => (
					<button
						type="button"
						key={key}
						onClick={() => setActiveTab(key)}
						className={`rounded-button px-4 py-2 text-xs font-medium transition-all duration-300 ease-out ${
							activeTabKey === key
								? "bg-surface shadow-neu-inset text-foreground"
								: "bg-surface shadow-neu-sm text-muted hover:-translate-y-px hover:shadow-neu hover:text-foreground"
						}`}
					>
						{val.label}
					</button>
				))}

				<div className="ml-auto flex items-center gap-2">
					<button
						type="button"
						onClick={copy}
						className="rounded-button px-3 py-1.5 text-xs font-medium text-muted shadow-neu-sm transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu hover:text-foreground active:translate-y-[0.5px] active:shadow-neu-inset"
					>
						{copied ? "Copied!" : "Copy"}
					</button>
					{hasFilename && (
						<button
							type="button"
							onClick={download}
							className="rounded-button px-3 py-1.5 text-xs font-medium text-muted shadow-neu-sm transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu hover:text-foreground active:translate-y-[0.5px] active:shadow-neu-inset"
						>
							Download
						</button>
					)}
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 p-4">
				{isPreview ? (
					<div className="h-full overflow-auto rounded-inner bg-[#1a1a1a] p-4">
						<TerminalView blocks={previewTab === "agent-card" ? agentCardBlocks : mcpBlocks} />
					</div>
				) : (
					<div className="h-full overflow-auto rounded-inner bg-surface shadow-neu-inset p-4">
						<pre className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words font-mono">
							{deployOutputs[deployTab].content}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
