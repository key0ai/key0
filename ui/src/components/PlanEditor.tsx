import type { Plan } from "../types";
import { Field, Input } from "./Field";

interface PlanEditorProps {
	plans: Plan[];
	onChange: (plans: Plan[]) => void;
}

export function PlanEditor({ plans, onChange }: PlanEditorProps) {
	const update = (index: number, field: keyof Plan, value: unknown) => {
		const next = [...plans];
		next[index] = { ...next[index], [field]: value };
		onChange(next);
	};

	const add = () => {
		onChange([
			...plans,
			{
				planId: "",
				unitAmount: "",
				description: "",
			},
		]);
	};

	const remove = (index: number) => {
		onChange(plans.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-4">
			{plans.map((p, i) => (
				<div key={i} className="relative rounded-inner bg-surface shadow-neu-inset p-4 space-y-3">
					{/* Header */}
					<div className="flex items-center justify-between">
						<span className="text-xs font-bold font-display text-muted uppercase tracking-wider">
							Plan {i + 1}
						</span>
						{plans.length > 1 && (
							<button
								type="button"
								onClick={() => remove(i)}
								className="text-muted hover:text-accent transition-colors"
								title="Remove plan"
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

					{/* Row 1: Plan ID + Price */}
					<div className="grid grid-cols-2 gap-3">
						<Field label="Plan ID" required hint="Unique slug, e.g. starter-monthly">
							<Input
								value={p.planId}
								onChange={(e) => update(i, "planId", e.target.value)}
								placeholder="starter-monthly"
							/>
						</Field>
						<Field label="Price (USDC)" required hint="e.g. 15.00 or 0.015">
							<div className="flex">
								<span className="inline-flex items-center rounded-l-input bg-surface px-3 text-sm font-medium text-muted shadow-neu-inset">
									$
								</span>
								<input
									inputMode="decimal"
									value={p.unitAmount.replace(/^\$/, "")}
									onChange={(e) => {
										const raw = e.target.value.replace(/^\$/, "");
										const sanitized = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
										update(i, "unitAmount", `$${sanitized}`);
									}}
									placeholder="15.00"
									className="w-full rounded-r-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none"
								/>
							</div>
						</Field>
					</div>

					{/* Row 2: Description */}
					<Field label="Description" hint="Describe what this plan includes">
						<textarea
							value={p.description || ""}
							onChange={(e) => update(i, "description", e.target.value)}
							placeholder="Best for developers running daily workflows. 1,650 requests/month, 10 concurrent agents, priority email support."
							rows={3}
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
				Add Plan
			</button>
		</div>
	);
}
