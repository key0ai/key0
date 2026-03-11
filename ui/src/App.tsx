import { useEffect, useState } from "react";
import { Field, Input, Select } from "./components/Field";
import { OutputPanel } from "./components/OutputPanel";
import { PlanEditor } from "./components/PlanEditor";
import { Section } from "./components/Section";
import { type Config, defaultConfig } from "./types";

type ServerStatus = "loading" | "setup" | "running" | "standalone";

export default function App() {
	const [config, setConfig] = useState<Config>(defaultConfig);
	const [serverStatus, setServerStatus] = useState<ServerStatus>("loading");
	const [saving, setSaving] = useState(false);
	const [saveMessage, setSaveMessage] = useState<{
		type: "success" | "error";
		text: string;
	} | null>(null);

	// Check if we're running inside Docker (API available) or standalone
	useEffect(() => {
		fetch("/api/setup/status")
			.then((r) => r.json())
			.then((data) => {
				setServerStatus(data.configured ? "running" : "setup");
				if (data.config) {
					setConfig((prev) => ({
						...prev,
						walletAddress: data.config.walletAddress ?? "",
						issueTokenApi: data.config.issueTokenApi ?? "",
						network: data.config.network ?? "testnet",
						storageBackend: data.config.storageBackend ?? "redis",
						redisUrl: data.config.redisUrl ?? "redis://redis:6379",
						databaseUrl: data.config.databaseUrl ?? "",
						port: data.config.port ?? "3000",
						basePath: data.config.basePath ?? "/a2a",
						agentName: data.config.agentName ?? "Key0 Server",
						agentDescription: data.config.agentDescription ?? "Payment-gated A2A endpoint",
						agentUrl: data.config.agentUrl ?? "",
						providerName: data.config.providerName ?? "",
						providerUrl: data.config.providerUrl ?? "",
						challengeTtlSeconds: data.config.challengeTtlSeconds ?? "900",
						mcpEnabled: data.config.mcpEnabled ?? false,
						backendAuthStrategy: data.config.backendAuthStrategy ?? "shared-secret",
						issueTokenApiSecret: data.config.issueTokenApiSecret ?? "",
						gasWalletPrivateKey: data.config.gasWalletPrivateKey ?? "",
						walletPrivateKey: data.config.walletPrivateKey ?? "",
						refundIntervalMs: data.config.refundIntervalMs ?? "60000",
						refundMinAgeMs: data.config.refundMinAgeMs ?? "300000",
					}));
				}
			})
			.catch(() => {
				// No server API — standalone mode (just a config generator)
				setServerStatus("standalone");
			});
	}, []);

	const set = <K extends keyof Config>(key: K, value: Config[K]) =>
		setConfig((prev) => ({ ...prev, [key]: value }));

	const isValid =
		config.walletAddress.startsWith("0x") &&
		config.walletAddress.length === 42 &&
		config.issueTokenApi.length > 0 &&
		(config.storageBackend === "redis"
			? config.redisUrl.length > 0
			: config.databaseUrl.length > 0) &&
		config.plans.length > 0 &&
		config.plans.every((p) => p.planId && p.unitAmount);

	const isDockerMode = serverStatus === "setup" || serverStatus === "running";

	const handleSaveAndLaunch = async () => {
		if (!isValid) return;
		setSaving(true);
		setSaveMessage(null);

		try {
			const res = await fetch("/api/setup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			const data = await res.json();

			if (res.ok) {
				setSaveMessage({ type: "success", text: "Configuration saved! Server is restarting..." });
				// Poll until server comes back
				setTimeout(() => pollForRestart(), 2000);
			} else {
				setSaveMessage({ type: "error", text: data.error || "Failed to save configuration" });
			}
		} catch {
			setSaveMessage({ type: "error", text: "Could not reach the server" });
		} finally {
			setSaving(false);
		}
	};

	const pollForRestart = () => {
		const check = () => {
			fetch("/api/setup/status")
				.then((r) => r.json())
				.then((data) => {
					if (data.configured) {
						setSaveMessage({ type: "success", text: "Server is running with new configuration!" });
						setServerStatus("running");
					} else {
						setTimeout(check, 1000);
					}
				})
				.catch(() => setTimeout(check, 1000));
		};
		check();
	};

	return (
		<div className="min-h-screen">
			{/* Header */}
			<header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm sticky top-0 z-10">
				<div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
							<svg
								className="h-4 w-4 text-emerald-400"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={2}
								aria-hidden="true"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
								/>
							</svg>
						</div>
						<div>
							<h1 className="text-base font-semibold text-neutral-100">Key0</h1>
							<p className="text-xs text-neutral-500">Standalone Setup</p>
						</div>
					</div>
					<div className="flex items-center gap-3">
						{serverStatus === "running" && (
							<span className="rounded-full px-3 py-1 text-xs font-medium bg-emerald-500/10 text-emerald-400">
								Running
							</span>
						)}
						{serverStatus === "setup" && (
							<span className="rounded-full px-3 py-1 text-xs font-medium bg-amber-500/10 text-amber-400">
								Not Configured
							</span>
						)}
						<span
							className={`rounded-full px-3 py-1 text-xs font-medium ${isValid ? "bg-emerald-500/10 text-emerald-400" : "bg-neutral-800 text-neutral-500"}`}
						>
							{isValid ? "Ready" : "Incomplete"}
						</span>
					</div>
				</div>
			</header>

			<div className="mx-auto max-w-7xl px-6 py-8">
				<div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
					{/* Left: Config Form */}
					<div className="space-y-6">
						<Section
							icon="W"
							title="Wallet & Network"
							description="Configure your payment destination"
						>
							<Field label="Wallet Address" required hint="Your USDC-receiving wallet (0x...)">
								<Input
									value={config.walletAddress}
									onChange={(e) => set("walletAddress", e.target.value)}
									placeholder="0x..."
									spellCheck={false}
								/>
							</Field>

							<Field label="Network" required>
								<Select
									value={config.network}
									onChange={(e) => set("network", e.target.value as "testnet" | "mainnet")}
								>
									<option value="testnet">Base Sepolia (Testnet)</option>
									<option value="mainnet">Base (Mainnet)</option>
								</Select>
							</Field>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section
							icon="$"
							title="Token Issuance"
							description="Your backend endpoint for issuing access tokens"
						>
							<Field
								label="Issue Token API"
								required
								hint="Key0 POSTs here after payment is verified"
							>
								<Input
									value={config.issueTokenApi}
									onChange={(e) => set("issueTokenApi", e.target.value)}
									placeholder="https://api.example.com/issue-token"
								/>
							</Field>

							<Field label="Backend Auth Strategy" hint="How Key0 authenticates with your backend">
								<Select
									value={config.backendAuthStrategy}
									onChange={(e) =>
										set("backendAuthStrategy", e.target.value as "shared-secret" | "jwt")
									}
								>
									<option value="shared-secret">Shared Secret (Bearer token)</option>
									<option value="jwt">JWT (signed token)</option>
								</Select>
							</Field>

							<Field
								label="API Secret"
								hint={
									config.backendAuthStrategy === "jwt"
										? "Secret used to sign JWT tokens sent to your API"
										: "Sent as Authorization: Bearer header to your API"
								}
							>
								<Input
									type="password"
									value={config.issueTokenApiSecret}
									onChange={(e) => set("issueTokenApiSecret", e.target.value)}
									placeholder={
										config.backendAuthStrategy === "jwt"
											? "JWT signing secret (min 32 chars)"
											: "Optional shared secret"
									}
								/>
							</Field>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section icon="T" title="Pricing Plans" description="Define pricing plans for your API">
							<PlanEditor plans={config.plans} onChange={(p) => set("plans", p)} />
						</Section>

						<div className="border-t border-neutral-800/50" />

						{/* MCP toggle */}
						<div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3">
							<div>
								<span className="text-sm font-medium text-neutral-300">Enable MCP</span>
								<p className="text-xs text-neutral-500">
									Expose discover_plans and request_access as MCP tools
								</p>
							</div>
							<button
								type="button"
								onClick={() => set("mcpEnabled", !config.mcpEnabled)}
								className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
									config.mcpEnabled ? "bg-emerald-500" : "bg-neutral-700"
								}`}
							>
								<span
									className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
										config.mcpEnabled ? "translate-x-5" : "translate-x-0"
									}`}
								/>
							</button>
						</div>

						<div className="border-t border-neutral-800/50" />

						<Section
							icon="I"
							title="Agent Identity"
							description="How your agent appears in discovery"
							defaultOpen={false}
						>
							<Field label="Agent Name">
								<Input
									value={config.agentName}
									onChange={(e) => set("agentName", e.target.value)}
									placeholder="Key0 Server"
								/>
							</Field>
							<Field label="Agent Description">
								<Input
									value={config.agentDescription}
									onChange={(e) => set("agentDescription", e.target.value)}
									placeholder="Payment-gated A2A endpoint"
								/>
							</Field>
							<Field label="Agent URL" hint="Public URL of this server">
								<Input
									value={config.agentUrl}
									onChange={(e) => set("agentUrl", e.target.value)}
									placeholder="http://localhost:3000"
								/>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field label="Provider Name">
									<Input
										value={config.providerName}
										onChange={(e) => set("providerName", e.target.value)}
										placeholder="Your Company"
									/>
								</Field>
								<Field label="Provider URL">
									<Input
										value={config.providerUrl}
										onChange={(e) => set("providerUrl", e.target.value)}
										placeholder="https://example.com"
									/>
								</Field>
							</div>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section
							icon="S"
							title="Server & Storage"
							description="Port, storage backend, and challenge settings"
							defaultOpen={false}
						>
							<Field label="Port">
								<Input
									type="number"
									value={config.port}
									onChange={(e) => set("port", e.target.value)}
								/>
							</Field>

							<Field label="Storage Backend">
								<Select
									value={config.storageBackend}
									onChange={(e) => set("storageBackend", e.target.value as "redis" | "postgres")}
								>
									<option value="redis">Redis</option>
									<option value="postgres">PostgreSQL</option>
								</Select>
							</Field>

							{config.storageBackend === "redis" && (
								<Field label="Redis URL" required>
									<Input
										value={config.redisUrl}
										onChange={(e) => set("redisUrl", e.target.value)}
										placeholder="redis://redis:6379"
									/>
								</Field>
							)}

							{config.storageBackend === "postgres" && (
								<>
									<Field label="Database URL" required hint="PostgreSQL connection string">
										<Input
											value={config.databaseUrl}
											onChange={(e) => set("databaseUrl", e.target.value)}
											placeholder="postgresql://user:pass@host:5432/db"
											spellCheck={false}
										/>
									</Field>
									<Field label="Redis URL" hint="Still required for BullMQ refund cron queue">
										<Input
											value={config.redisUrl}
											onChange={(e) => set("redisUrl", e.target.value)}
											placeholder="redis://redis:6379"
										/>
									</Field>
								</>
							)}

							<Field label="Challenge TTL (seconds)" hint="Default: 900 (15 min)">
								<Input
									type="number"
									value={config.challengeTtlSeconds}
									onChange={(e) => set("challengeTtlSeconds", e.target.value)}
								/>
							</Field>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section
							icon="G"
							title="Settlement"
							description="Gas wallet for self-contained on-chain settlement"
							defaultOpen={false}
						>
							<Field
								label="Gas Wallet Private Key"
								hint="Wallet holding ETH on Base for transaction fees. Leave blank for facilitator mode."
							>
								<Input
									type="password"
									value={config.gasWalletPrivateKey}
									onChange={(e) => set("gasWalletPrivateKey", e.target.value)}
									placeholder="0x..."
									spellCheck={false}
								/>
							</Field>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section
							icon="R"
							title="Refund Cron"
							description="Auto-refund stuck payments"
							defaultOpen={false}
						>
							<Field
								label="Wallet Private Key"
								hint="Private key of your receiving wallet — used to send USDC refunds"
							>
								<Input
									type="password"
									value={config.walletPrivateKey}
									onChange={(e) => set("walletPrivateKey", e.target.value)}
									placeholder="0x..."
									spellCheck={false}
								/>
							</Field>
							{config.walletPrivateKey && (
								<>
									<div className="grid grid-cols-2 gap-3">
										<Field label="Scan Interval (ms)" hint="Default: 60s">
											<Input
												type="number"
												value={config.refundIntervalMs}
												onChange={(e) => set("refundIntervalMs", e.target.value)}
											/>
										</Field>
										<Field label="Min Age (ms)" hint="Default: 5 min">
											<Input
												type="number"
												value={config.refundMinAgeMs}
												onChange={(e) => set("refundMinAgeMs", e.target.value)}
											/>
										</Field>
									</div>
									<p className="text-xs text-neutral-500">
										Scans every{" "}
										<span className="text-neutral-400">
											{Number(config.refundIntervalMs) >= 60000
												? `${(Number(config.refundIntervalMs) / 60000).toFixed(1).replace(/\.0$/, "")} min`
												: `${(Number(config.refundIntervalMs) / 1000).toFixed(1).replace(/\.0$/, "")}s`}
										</span>{" "}
										— refunds stuck payments older than{" "}
										<span className="text-neutral-400">
											{Number(config.refundMinAgeMs) >= 60000
												? `${(Number(config.refundMinAgeMs) / 60000).toFixed(1).replace(/\.0$/, "")} min`
												: `${(Number(config.refundMinAgeMs) / 1000).toFixed(1).replace(/\.0$/, "")}s`}
										</span>
									</p>
								</>
							)}
						</Section>

						{/* Save & Launch button (Docker mode only) */}
						{isDockerMode && (
							<div className="pt-4">
								{saveMessage && (
									<div
										className={`mb-4 rounded-lg px-4 py-3 text-sm ${
											saveMessage.type === "success"
												? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
												: "bg-red-500/10 text-red-400 border border-red-500/20"
										}`}
									>
										{saveMessage.text}
									</div>
								)}
								<button
									type="button"
									onClick={handleSaveAndLaunch}
									disabled={!isValid || saving}
									className={`w-full rounded-lg px-6 py-3 text-sm font-semibold transition-all ${
										isValid && !saving
											? "bg-emerald-500 text-white hover:bg-emerald-400 shadow-lg shadow-emerald-500/20"
											: "bg-neutral-800 text-neutral-500 cursor-not-allowed"
									}`}
								>
									{saving
										? "Saving..."
										: serverStatus === "running"
											? "Save & Restart"
											: "Save & Launch"}
								</button>
							</div>
						)}
					</div>

					{/* Right: Output Panel */}
					<div className="lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)]">
						<OutputPanel config={config} />
					</div>
				</div>
			</div>
		</div>
	);
}
