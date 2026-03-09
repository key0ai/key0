import { useState } from "react";
import { generateDockerCompose, generateDockerRun, generateEnv } from "../generate";
import type { Config } from "../types";

type Tab = "env" | "docker-run" | "docker-compose";

interface OutputPanelProps {
	config: Config;
}

export function OutputPanel({ config }: OutputPanelProps) {
	const [activeTab, setActiveTab] = useState<Tab>("env");
	const [copied, setCopied] = useState(false);

	const outputs: Record<Tab, { label: string; content: string; filename?: string }> = {
		env: { label: ".env", content: generateEnv(config), filename: ".env" },
		"docker-run": { label: "docker run", content: generateDockerRun(config) },
		"docker-compose": {
			label: "docker-compose.yml",
			content: generateDockerCompose(config),
			filename: "docker-compose.yml",
		},
	};

	const active = outputs[activeTab];

	const copy = async () => {
		await navigator.clipboard.writeText(active.content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const download = () => {
		if (!active.filename) return;
		const blob = new Blob([active.content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = active.filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex h-full flex-col rounded-xl border border-neutral-800 bg-neutral-900/50">
			{/* Tab bar */}
			<div className="flex items-center gap-1 border-b border-neutral-800 px-3 pt-3">
				{(Object.entries(outputs) as [Tab, typeof active][]).map(([key, val]) => (
					<button
						type="button"
						key={key}
						onClick={() => {
							setActiveTab(key);
							setCopied(false);
						}}
						className={`rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors ${
							activeTab === key
								? "bg-neutral-800 text-emerald-400"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						{val.label}
					</button>
				))}

				<div className="ml-auto flex items-center gap-2 pb-1">
					<button
						type="button"
						onClick={copy}
						className="rounded-md px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
					>
						{copied ? "Copied!" : "Copy"}
					</button>
					{active.filename && (
						<button
							type="button"
							onClick={download}
							className="rounded-md px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
						>
							Download
						</button>
					)}
				</div>
			</div>

			{/* Code output */}
			<div className="flex-1 overflow-auto p-4">
				<pre className="text-xs leading-relaxed text-neutral-300 whitespace-pre-wrap break-all font-mono">
					{active.content}
				</pre>
			</div>
		</div>
	);
}
