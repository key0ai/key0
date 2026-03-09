interface FieldProps {
	label: string;
	hint?: string;
	required?: boolean;
	children: React.ReactNode;
}

export function Field({ label, hint, required, children }: FieldProps) {
	return (
		<div className="space-y-1.5">
			<span className="block text-sm font-medium text-neutral-300">
				{label}
				{required && <span className="ml-1 text-red-400">*</span>}
			</span>
			{children}
			{hint && <p className="text-xs text-neutral-500">{hint}</p>}
		</div>
	);
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input(props: InputProps) {
	return (
		<input
			{...props}
			className={`w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 transition-colors focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 ${props.className ?? ""}`}
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
			className={`w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 transition-colors focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 ${props.className ?? ""}`}
		>
			{props.children}
		</select>
	);
}
