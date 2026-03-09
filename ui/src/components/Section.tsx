interface SectionProps {
	title: string;
	description?: string;
	icon: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
}

export function Section({ title, description, icon, children, defaultOpen = true }: SectionProps) {
	return (
		<details open={defaultOpen} className="group">
			<summary className="flex cursor-pointer items-center gap-3 rounded-lg py-2 select-none">
				<span className="text-lg">{icon}</span>
				<div className="flex-1">
					<h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
					{description && <p className="text-xs text-neutral-500">{description}</p>}
				</div>
				<svg
					className="h-4 w-4 text-neutral-500 transition-transform group-open:rotate-180"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</summary>
			<div className="mt-4 space-y-4 pl-8">{children}</div>
		</details>
	);
}
