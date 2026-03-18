import type { Route } from "../types.js";
import { Field, Input, Select } from "./Field";

interface RouteEditorProps {
	routes: Route[];
	onChange: (routes: Route[]) => void;
}

const emptyRoute = (): Route => ({
	routeId: "",
	method: "GET",
	path: "",
	unitAmount: "",
	description: "",
});

export function RouteEditor({ routes, onChange }: RouteEditorProps) {
	const update = (i: number, field: keyof Route, value: string) =>
		onChange(routes.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));

	const add = () => onChange([...routes, emptyRoute()]);

	const remove = (i: number) => onChange(routes.filter((_, idx) => idx !== i));

	return (
		<div className="space-y-4">
			{routes.map((route, i) => (
				<div
					key={`${route.routeId || "route"}-${i}`}
					className="relative rounded-inner bg-surface shadow-neu-inset p-4 space-y-3"
				>
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
								onChange={(e) => update(i, "method", e.target.value)}
							>
								<option value="GET">GET</option>
								<option value="POST">POST</option>
								<option value="PUT">PUT</option>
								<option value="DELETE">DELETE</option>
								<option value="PATCH">PATCH</option>
							</Select>
						</Field>
						<Field label="Path" required hint="e.g. /api/user/:id">
							<Input
								value={route.path}
								onChange={(e) => update(i, "path", e.target.value)}
								placeholder="/api/user/:id"
							/>
						</Field>
					</div>

					{/* Row 2: Route ID + Price */}
					<div className="grid grid-cols-2 gap-3">
						<Field label="Route ID" required hint="Unique slug, e.g. get-user">
							<Input
								value={route.routeId}
								onChange={(e) => update(i, "routeId", e.target.value)}
								placeholder="get-user"
							/>
						</Field>
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
										update(i, "unitAmount", sanitized);
									}}
									placeholder="free"
									className="w-full rounded-r-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none"
								/>
							</div>
						</Field>
					</div>

					{/* Row 3: Description */}
					<Field label="Description" hint="Describe this route (optional)">
						<textarea
							value={route.description || ""}
							onChange={(e) => update(i, "description", e.target.value)}
							placeholder="Get user details by ID"
							rows={2}
							className="w-full rounded-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none resize-y"
						/>
					</Field>
				</div>
			))}

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
