/**
 * Polling utilities for async assertions.
 */

/** Poll fn until it returns a truthy value or timeout is exceeded. */
export async function pollUntil<T>(
	fn: () => Promise<T | null | undefined | false>,
	timeoutMs: number,
	intervalMs = 1000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await fn();
		if (result) return result;
		await Bun.sleep(intervalMs);
	}
	throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

/** Poll until challengeState === expected, return the state. */
export async function waitForChallengeState(
	readState: () => Promise<string | null>,
	expectedState: string,
	timeoutMs: number,
): Promise<string> {
	return pollUntil(async () => {
		const s = await readState();
		return s === expectedState ? s : null;
	}, timeoutMs);
}
