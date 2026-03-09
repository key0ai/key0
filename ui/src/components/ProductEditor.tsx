import type { ProductTier } from "../types";
import { Field, Input, Select } from "./Field";

interface ProductEditorProps {
	products: ProductTier[];
	onChange: (products: ProductTier[]) => void;
}

export function ProductEditor({ products, onChange }: ProductEditorProps) {
	const update = (index: number, field: keyof ProductTier, value: string | number) => {
		const next = [...products];
		next[index] = { ...next[index], [field]: value };
		onChange(next);
	};

	const add = () => {
		onChange([
			...products,
			{
				tierId: "",
				label: "",
				amount: "$0.10",
				resourceType: "api",
				accessDurationSeconds: 3600,
			},
		]);
	};

	const remove = (index: number) => {
		onChange(products.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-4">
			{products.map((p, i) => (
				<div
					key={p.tierId || i}
					className="relative rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 space-y-3"
				>
					{products.length > 1 && (
						<button
							type="button"
							onClick={() => remove(i)}
							className="absolute top-3 right-3 text-neutral-500 hover:text-red-400 transition-colors"
							title="Remove tier"
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

					<div className="grid grid-cols-2 gap-3">
						<Field label="Tier ID" required>
							<Input
								value={p.tierId}
								onChange={(e) => update(i, "tierId", e.target.value)}
								placeholder="basic"
							/>
						</Field>
						<Field label="Label" required>
							<Input
								value={p.label}
								onChange={(e) => update(i, "label", e.target.value)}
								placeholder="Basic Access"
							/>
						</Field>
					</div>

					<div className="grid grid-cols-3 gap-3">
						<Field label="Amount" required hint="e.g. $0.10">
							<Input
								value={p.amount}
								onChange={(e) => update(i, "amount", e.target.value)}
								placeholder="$0.10"
							/>
						</Field>
						<Field label="Resource Type" required>
							<Select
								value={p.resourceType}
								onChange={(e) => update(i, "resourceType", e.target.value)}
							>
								<option value="api">api</option>
								<option value="api-call">api-call</option>
								<option value="photo">photo</option>
								<option value="file">file</option>
								<option value="data">data</option>
							</Select>
						</Field>
						<Field label="Duration (s)" hint="Blank = single-use">
							<Input
								type="number"
								value={p.accessDurationSeconds}
								onChange={(e) =>
									update(
										i,
										"accessDurationSeconds",
										e.target.value === "" ? "" : Number(e.target.value),
									)
								}
								placeholder="3600"
							/>
						</Field>
					</div>
				</div>
			))}

			<button
				type="button"
				onClick={add}
				className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-700 px-4 py-2 text-sm text-neutral-400 transition-colors hover:border-emerald-500 hover:text-emerald-400"
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
				Add Tier
			</button>
		</div>
	);
}
