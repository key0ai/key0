/** Allowed characters in URL template param values. */
const SAFE_PARAM_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Interpolates `{param}` placeholders in a URL template using the supplied params.
 *
 * Rules:
 * - Unknown placeholders (no matching param) → throws with a clear message
 * - Param values containing `/` or `.` → throws (path traversal protection)
 * - Extra params not present in the template → silently ignored
 *
 * @example
 * interpolateUrlTemplate("/signal/{asset}", { asset: "BTC" }) // "/signal/BTC"
 */
export function interpolateUrlTemplate(template: string, params: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_placeholder, key: string) => {
		if (!(key in params)) {
			throw new Error(`Missing param "${key}" required by URL template "${template}"`);
		}
		const value = params[key]!;
		if (!SAFE_PARAM_RE.test(value)) {
			throw new Error(`Invalid param "${key}": value "${value}" contains disallowed characters`);
		}
		return value;
	});
}

/**
 * Extracts all placeholder names from a URL template.
 * @example extractTemplateParams("/signal/{asset}") // ["asset"]
 */
export function extractTemplateParams(template: string): string[] {
	const params: string[] = [];
	for (const match of template.matchAll(/\{(\w+)\}/g)) {
		params.push(match[1]!);
	}
	return params;
}
