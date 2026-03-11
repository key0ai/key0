interface FieldProps {
	label: string;
	hint?: string;
	required?: boolean;
	children: React.ReactNode;
}

export function Field({ label, hint, required, children }: FieldProps) {
	return (
		<div className="space-y-1.5">
			<span className="block text-sm font-medium text-foreground">
				{label}
				{required && <span className="ml-1 text-accent-secondary">*</span>}
			</span>
			{children}
			{hint && <p className="text-xs text-muted">{hint}</p>}
		</div>
	);
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input(props: InputProps) {
	return (
		<input
			{...props}
			className={`w-full rounded-input border-none bg-surface px-3 py-2 text-sm text-foreground placeholder-muted shadow-neu-inset transition-all focus:outline-none ${props.className ?? ""}`}
		/>
	);
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
	children: React.ReactNode;
}

export function Select(props: SelectProps) {
	return (
		<select
			{...props}
			className={`w-full rounded-input border-none bg-surface px-3 py-2 text-sm text-foreground shadow-neu-inset transition-all focus:outline-none ${props.className ?? ""}`}
		>
			{props.children}
		</select>
	);
}
