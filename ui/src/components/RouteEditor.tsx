import type { Route, RouteParam } from "../types.js";
import { Field, Input, Select } from "./Field";

interface RouteEditorProps {
	routes: Route[];
	onChange: (routes: Route[]) => void;
}

function deriveRouteId(method: string, path: string): string {
	return `${method.toLowerCase()}-${path
		.replace(/\//g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")}`;
}

/** Extract :param names from an Express-style path */
function extractPathParams(path: string): string[] {
	return [...path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1] ?? "");
}

function emptyParam(location: RouteParam["in"]): RouteParam {
	return { name: "", in: location, description: "", required: true, type: "string" };
}

const emptyRoute = (): Route => ({
	routeId: "",
	method: "GET",
	path: "",
	unitAmount: "",
	description: "",
	params: [],
});

export function RouteEditor({ routes, onChange }: RouteEditorProps) {
	const updateRoute = (i: number, field: keyof Route, value: unknown) => {
		const updated = routes.map((r, idx) => {
			if (idx !== i) return r;
			const next = { ...r, [field]: value };
			if (field === "method" || field === "path") {
				next.routeId = deriveRouteId(
					field === "method" ? (value as string) : r.method,
					field === "path" ? (value as string) : r.path,
				);
				// Sync path params: merge auto-detected params with existing non-path params
				if (field === "path") {
					const pathParamNames = extractPathParams(value as string);
					const nonPathParams = (r.params ?? []).filter((p) => p.in !== "path");
					const pathParams: RouteParam[] = pathParamNames.map((name) => {
						const existing = (r.params ?? []).find((p) => p.in === "path" && p.name === name);
						return (
							existing ?? { name, in: "path", description: "", required: true, type: "string" }
						);
					});
					next.params = [...pathParams, ...nonPathParams];
				}
			}
			return next;
		});
		onChange(updated);
	};

	const updateParam = (
		routeIdx: number,
		paramIdx: number,
		field: keyof RouteParam,
		value: unknown,
	) => {
		const route = routes[routeIdx];
		if (!route) return;
		const params = (route.params ?? []).map((p, i) =>
			i === paramIdx ? { ...p, [field]: value } : p,
		);
		onChange(routes.map((r, i) => (i === routeIdx ? { ...r, params } : r)));
	};

	const addParam = (routeIdx: number, location: RouteParam["in"]) => {
		const route = routes[routeIdx];
		if (!route) return;
		const params = [...(route.params ?? []), emptyParam(location)];
		onChange(routes.map((r, i) => (i === routeIdx ? { ...r, params } : r)));
	};

	const removeParam = (routeIdx: number, paramIdx: number) => {
		const route = routes[routeIdx];
		if (!route) return;
		const params = (route.params ?? []).filter((_, i) => i !== paramIdx);
		onChange(routes.map((r, i) => (i === routeIdx ? { ...r, params } : r)));
	};

	const add = () => onChange([...routes, emptyRoute()]);
	const remove = (i: number) => onChange(routes.filter((_, idx) => idx !== i));

	return (
		<div className="space-y-4">
			{routes.map((route, i) => {
				const pathParams = (route.params ?? []).filter((p) => p.in === "path");
				const otherParams = (route.params ?? []).filter((p) => p.in !== "path");
				const supportsBody = ["POST", "PUT", "PATCH"].includes(route.method);

				return (
					<div key={i} className="relative rounded-inner bg-surface shadow-neu-inset p-4 space-y-3">
						{/* Header */}
						<div className="flex items-center justify-between">
							<span className="text-xs font-bold font-display text-muted uppercase tracking-wider">
								Route {i + 1}
							</span>
							{routes.length > 1 && (
								<button
									type="button"
									onClick={() => remove(i)}
									className="text-muted hover:text-accent transition-colors"
									title="Remove route"
								>
									<svg
										className="h-4 w-4"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										strokeWidth={2}
										aria-hidden="true"
									>
										<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							)}
						</div>

						{/* Row 1: Method + Path */}
						<div className="grid grid-cols-2 gap-3">
							<Field label="Method" required>
								<Select
									value={route.method}
									onChange={(e) => updateRoute(i, "method", e.target.value)}
								>
									<option value="GET">GET</option>
									<option value="POST">POST</option>
									<option value="PUT">PUT</option>
									<option value="DELETE">DELETE</option>
									<option value="PATCH">PATCH</option>
								</Select>
							</Field>
							<Field label="Path" required hint="e.g. /api/weather/:city">
								<Input
									value={route.path}
									onChange={(e) => updateRoute(i, "path", e.target.value)}
									placeholder="/api/weather/:city"
								/>
							</Field>
						</div>

						{/* Row 2: Price */}
						<Field label="Price (USDC)" hint="Leave empty for free">
							<div className="flex">
								<span className="inline-flex items-center rounded-l-input bg-surface px-3 text-sm font-medium text-muted shadow-neu-inset">
									$
								</span>
								<input
									inputMode="decimal"
									value={route.unitAmount}
									onChange={(e) => {
										const raw = e.target.value;
										const sanitized = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
										updateRoute(i, "unitAmount", sanitized);
									}}
									placeholder="free"
									className="w-full rounded-r-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none"
								/>
							</div>
						</Field>

						{/* Row 3: Description */}
						<Field label="Description" hint="Describe this route (optional)">
							<textarea
								value={route.description || ""}
								onChange={(e) => updateRoute(i, "description", e.target.value)}
								placeholder="Returns weather data for the given city"
								rows={2}
								className="w-full rounded-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none resize-y"
							/>
						</Field>

						{/* Parameters */}
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<span className="text-xs font-semibold text-muted uppercase tracking-wider">
									Parameters
								</span>
							</div>

							{/* Auto-detected path params */}
							{pathParams.length > 0 && (
								<div className="space-y-2">
									{pathParams.map((param) => (
										<div
											key={`path-${param.name}`}
											className="rounded-inner bg-surface shadow-neu-inset p-3 space-y-2"
										>
											<div className="flex items-center gap-2">
												<span className="text-xs font-mono font-semibold text-foreground">
													:{param.name}
												</span>
												<span className="rounded px-1.5 py-0.5 text-xs bg-accent/10 text-accent font-medium">
													path
												</span>
												<span className="text-xs text-muted">auto-detected</span>
											</div>
											<Input
												value={param.description}
												onChange={(e) =>
													updateParam(
														i,
														(route.params ?? []).findIndex(
															(p) => p.in === "path" && p.name === param.name,
														),
														"description",
														e.target.value,
													)
												}
												placeholder={`Describe :${param.name}`}
											/>
										</div>
									))}
								</div>
							)}

							{/* User-defined query/body params */}
							{otherParams.map((param, pi) => {
								const nonPathInOrder = (route.params ?? [])
									.map((p, idx) => ({ p, idx }))
									.filter(({ p }) => p.in !== "path");
								const realIdx = nonPathInOrder[pi]?.idx ?? -1;

								return (
									<div
										key={`${param.in}-${pi}`}
										className="rounded-inner bg-surface shadow-neu-inset p-3 space-y-2"
									>
										<div className="flex items-center gap-2">
											<span className="rounded px-1.5 py-0.5 text-xs bg-surface shadow-neu text-muted font-medium">
												{param.in}
											</span>
											<button
												type="button"
												onClick={() => removeParam(i, realIdx)}
												className="ml-auto text-muted hover:text-accent transition-colors"
											>
												<svg
													className="h-3.5 w-3.5"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
													strokeWidth={2}
													aria-hidden="true"
												>
													<path
														strokeLinecap="round"
														strokeLinejoin="round"
														d="M6 18L18 6M6 6l12 12"
													/>
												</svg>
											</button>
										</div>
										<div className="grid grid-cols-2 gap-2">
											<Input
												value={param.name}
												onChange={(e) => updateParam(i, realIdx, "name", e.target.value)}
												placeholder="param name"
											/>
											<Select
												value={param.type}
												onChange={(e) => updateParam(i, realIdx, "type", e.target.value)}
											>
												<option value="string">string</option>
												<option value="number">number</option>
												<option value="boolean">boolean</option>
												<option value="object">object</option>
											</Select>
										</div>
										<Input
											value={param.description}
											onChange={(e) => updateParam(i, realIdx, "description", e.target.value)}
											placeholder="Description (optional)"
										/>
										<label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
											<input
												type="checkbox"
												checked={param.required}
												onChange={(e) => updateParam(i, realIdx, "required", e.target.checked)}
												className="accent-accent"
											/>
											Required
										</label>
									</div>
								);
							})}

							{/* Add param buttons */}
							<div className="flex gap-2 flex-wrap">
								<button
									type="button"
									onClick={() => addParam(i, "query")}
									className="flex items-center gap-1 rounded-button bg-surface px-3 py-1.5 text-xs font-medium text-muted shadow-neu transition-all hover:-translate-y-px hover:shadow-neu-hover hover:text-foreground"
								>
									<svg
										className="h-3 w-3"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										strokeWidth={2}
										aria-hidden="true"
									>
										<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
									</svg>
									Query param
								</button>
								{supportsBody && (
									<button
										type="button"
										onClick={() => addParam(i, "body")}
										className="flex items-center gap-1 rounded-button bg-surface px-3 py-1.5 text-xs font-medium text-muted shadow-neu transition-all hover:-translate-y-px hover:shadow-neu-hover hover:text-foreground"
									>
										<svg
											className="h-3 w-3"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											strokeWidth={2}
											aria-hidden="true"
										>
											<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
										</svg>
										Body param
									</button>
								)}
							</div>
						</div>
					</div>
				);
			})}

			<button
				type="button"
				onClick={add}
				className="flex items-center gap-2 rounded-button bg-surface px-4 py-2.5 text-sm font-medium text-muted shadow-neu transition-all duration-300 ease-out hover:-translate-y-px hover:shadow-neu-hover hover:text-foreground active:translate-y-[0.5px] active:shadow-neu-inset"
			>
				<svg
					className="h-4 w-4"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
				</svg>
				Add Route
			</button>
		</div>
	);
}
