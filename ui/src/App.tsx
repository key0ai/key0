import { useEffect, useState } from "react";
import { Field, Input, Select } from "./components/Field";
import { OutputPanel } from "./components/OutputPanel";
import { ProductEditor } from "./components/ProductEditor";
import { Section } from "./components/Section";
import { type Config, defaultConfig } from "./types";

type ServerStatus = "loading" | "setup" | "running" | "standalone";

export default function App() {
	const [config, setConfig] = useState<Config>(defaultConfig);
	const [serverStatus, setServerStatus] = useState<ServerStatus>("loading");
	const [setupProtected, setSetupProtected] = useState(false);
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
				if (data.setupProtected) setSetupProtected(true);
				if (data.config) {
					setConfig((prev) => ({
						...prev,
						walletAddress: data.config.walletAddress ?? "",
						issueTokenApi: data.config.issueTokenApi ?? "",
						network: data.config.network ?? "testnet",
						redisUrl: data.config.redisUrl ?? "redis://redis:6379",
						port: data.config.port ?? "3000",
						basePath: data.config.basePath ?? "/a2a",
						agentName: data.config.agentName ?? "AgentGate Server",
						agentDescription: data.config.agentDescription ?? "Payment-gated A2A endpoint",
						agentUrl: data.config.agentUrl ?? "",
						providerName: data.config.providerName ?? "",
						providerUrl: data.config.providerUrl ?? "",
						challengeTtlSeconds: data.config.challengeTtlSeconds ?? "900",
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
		config.redisUrl.length > 0 &&
		config.products.length > 0 &&
		config.products.every((p) => p.tierId && p.label && p.amount);

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
							<h1 className="text-base font-semibold text-neutral-100">AgentGate</h1>
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
								hint="AgentGate POSTs here after payment is verified"
							>
								<Input
									value={config.issueTokenApi}
									onChange={(e) => set("issueTokenApi", e.target.value)}
									placeholder="https://api.example.com/issue-token"
								/>
							</Field>

							<Field label="API Secret" hint="Sent as Authorization: Bearer header to your API">
								<Input
									type="password"
									value={config.issueTokenApiSecret}
									onChange={(e) => set("issueTokenApiSecret", e.target.value)}
									placeholder="Optional shared secret"
								/>
							</Field>
						</Section>

						<div className="border-t border-neutral-800/50" />

						<Section icon="T" title="Product Tiers" description="Define pricing tiers for your API">
							<ProductEditor products={config.products} onChange={(p) => set("products", p)} />
						</Section>

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
									placeholder="AgentGate Server"
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
							description="Port, Redis, and challenge settings"
							defaultOpen={false}
						>
							<div className="grid grid-cols-2 gap-3">
								<Field label="Port">
									<Input
										type="number"
										value={config.port}
										onChange={(e) => set("port", e.target.value)}
									/>
								</Field>
								<Field label="Base Path">
									<Input
										value={config.basePath}
										onChange={(e) => set("basePath", e.target.value)}
										placeholder="/a2a"
									/>
								</Field>
							</div>
							<Field label="Redis URL" required>
								<Input
									value={config.redisUrl}
									onChange={(e) => set("redisUrl", e.target.value)}
									placeholder="redis://redis:6379"
								/>
							</Field>
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
								{setupProtected ? (
									<div className="rounded-lg px-4 py-3 text-sm bg-amber-500/10 text-amber-400 border border-amber-500/20">
										Setup API is locked. Set{" "}
										<code className="font-mono text-xs bg-neutral-800 px-1 py-0.5 rounded">
											SETUP_SECRET
										</code>{" "}
										env var to enable reconfiguration.
									</div>
								) : (
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
								)}
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
