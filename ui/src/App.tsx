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
						agentUrl: data.config.agentUrl ?? "",
						providerName: data.config.providerName ?? "",
						providerUrl: data.config.providerUrl ?? "",
						challengeTtlSeconds: data.config.challengeTtlSeconds ?? "900",
						mcpEnabled: data.config.mcpEnabled ?? true,
						backendAuthStrategy: data.config.backendAuthStrategy ?? "none",
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
		config.providerName.length > 0 &&
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
		<div className="min-h-screen bg-surface">
			{/* Header */}
			<header className="sticky top-0 z-10 bg-surface">
				<div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="h-10 w-10 rounded-inner bg-surface shadow-neu-inset-deep flex items-center justify-center">
							<svg
								className="h-5 w-5 text-foreground"
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
							<h1 className="font-display text-base font-bold text-foreground">Key0</h1>
							<p className="text-xs text-muted">Setup</p>
						</div>
					</div>
					<div className="flex items-center gap-3">
						{serverStatus === "running" && (
							<span className="rounded-button px-3 py-1.5 text-xs font-medium bg-surface shadow-neu-sm text-accent-secondary">
								Running
							</span>
						)}
						{serverStatus === "setup" && (
							<span className="rounded-button px-3 py-1.5 text-xs font-medium bg-surface shadow-neu-sm text-muted">
								Not Configured
							</span>
						)}
						<span
							className={`rounded-button px-3 py-1.5 text-xs font-medium transition-all duration-300 ${isValid ? "bg-surface shadow-neu-sm text-accent-secondary" : "bg-surface shadow-neu-inset text-muted"}`}
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
						{/* 1. Company */}
						<Section
							icon="C"
							title="Company"
							description="Your company identity for agent discovery"
						>
							<div className="grid grid-cols-2 gap-3">
								<Field label="Company Name" required>
									<Input
										value={config.providerName}
										onChange={(e) => set("providerName", e.target.value)}
										placeholder="Acme Inc."
									/>
								</Field>
								<Field label="Company URL">
									<Input
										value={config.providerUrl}
										onChange={(e) => set("providerUrl", e.target.value)}
										placeholder="https://acme.com"
									/>
								</Field>
							</div>
						</Section>

						<div className="border-t border-foreground/10" />

						{/* 2. Pricing Plans */}
						<Section icon="$" title="Pricing Plans" description="Define pricing plans for your API">
							<PlanEditor plans={config.plans} onChange={(p) => set("plans", p)} />
						</Section>

						<div className="border-t border-foreground/10" />

						{/* 3. Token Issuance */}
						<Section
							icon="T"
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
										set("backendAuthStrategy", e.target.value as "none" | "shared-secret" | "jwt")
									}
								>
									<option value="none">None (no auth)</option>
									<option value="shared-secret">Shared Secret (Bearer token)</option>
									<option value="jwt">JWT (signed token)</option>
								</Select>
							</Field>

							{config.backendAuthStrategy !== "none" && (
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
							)}
						</Section>

						<div className="border-t border-foreground/10" />

						{/* 4. Wallet & Network (includes gas wallet) */}
						<Section
							icon="W"
							title="Wallet & Network"
							description="Configure your payment destination and settlement"
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

						{/* MCP toggle */}
						<div className="flex items-center justify-between rounded-button bg-surface shadow-neu px-5 py-4">
							<div>
								<span className="text-sm font-medium text-foreground">Enable MCP</span>
								<p className="text-xs text-muted">
									Expose discover_plans and request_access as MCP tools
								</p>
							</div>
							<button
								type="button"
								onClick={() => set("mcpEnabled", !config.mcpEnabled)}
								className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-all duration-300 ${
									config.mcpEnabled ? "shadow-neu-inset bg-accent" : "shadow-neu-inset bg-surface"
								}`}
							>
								<span
									className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-surface-raised shadow-neu-sm transition-all duration-300 mt-1 ${
										config.mcpEnabled ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>

						<div className="border-t border-foreground/10" />

						{/* 5. Server & Storage */}
						<Section
							icon="S"
							title="Server & Storage"
							description="Port, storage backend, and challenge settings"
							defaultOpen={false}
						>
							<Field label="Public URL" hint="Where agents can reach this server">
								<Input
									value={config.agentUrl}
									onChange={(e) => set("agentUrl", e.target.value)}
									placeholder="http://localhost:3000"
								/>
							</Field>

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

						<div className="border-t border-foreground/10" />

						{/* 6. Refund Cron */}
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
									<p className="text-xs text-muted">
										Scans every{" "}
										<span className="text-foreground font-medium">
											{Number(config.refundIntervalMs) >= 60000
												? `${(Number(config.refundIntervalMs) / 60000).toFixed(1).replace(/\.0$/, "")} min`
												: `${(Number(config.refundIntervalMs) / 1000).toFixed(1).replace(/\.0$/, "")}s`}
										</span>{" "}
										— refunds stuck payments older than{" "}
										<span className="text-foreground font-medium">
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
										className={`mb-4 rounded-button px-4 py-3 text-sm ${
											saveMessage.type === "success"
												? "bg-surface shadow-neu-inset text-accent-secondary"
												: "bg-surface shadow-neu-inset text-foreground"
										}`}
									>
										{saveMessage.text}
									</div>
								)}
								<button
									type="button"
									onClick={handleSaveAndLaunch}
									disabled={!isValid || saving}
									className={`w-full rounded-button px-6 py-3.5 text-sm font-semibold font-body transition-all duration-300 ease-out min-h-[44px] ${
										isValid && !saving
											? "bg-accent text-white shadow-neu hover:-translate-y-px hover:shadow-neu-hover active:translate-y-[0.5px] active:shadow-neu-inset"
											: "bg-surface shadow-neu-inset text-muted cursor-not-allowed"
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
					<div className="lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)]">
						<OutputPanel config={config} />
					</div>
				</div>
			</div>
		</div>
	);
}
