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
			<summary className="flex cursor-pointer items-center gap-3 rounded-button py-2 select-none">
				<span className="flex h-10 w-10 items-center justify-center rounded-inner bg-surface shadow-neu-inset-deep font-display text-sm font-bold text-foreground">
					{icon}
				</span>
				<div className="flex-1">
					<h3 className="font-display text-sm font-bold text-foreground">{title}</h3>
					{description && <p className="text-xs text-muted">{description}</p>}
				</div>
				<svg
					className="h-4 w-4 text-muted transition-transform group-open:rotate-180"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</summary>
			<div className="mt-4 space-y-4 pl-[3.25rem]">{children}</div>
		</details>
	);
}
