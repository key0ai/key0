# CLI Self-Install Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--install` flag to the compiled Key0 CLI binary so it can install itself to PATH without any external tooling.

**Architecture:** All changes are in `src/integrations/cli-template.ts` only. We extend `ParsedArgs`, update `parseCli`, add `runInstall`, wire it into `runMain`, and update the help output. Tests are added to the existing `src/integrations/__tests__/cli-build.test.ts` file alongside existing `generateCliSource` and `buildCli` tests.

**Tech Stack:** Bun, TypeScript strict mode, `bun:test`, `node:fs` (copyFileSync, chmodSync, mkdirSync), `node:os` (homedir), `node:path` (join)

---

## Chunk 1: ParsedArgs + parseCli + runMain stub

### Task 1: Extend `ParsedArgs`, `parseCli`, and add `runMain` case together

**Why all in one task:** Adding `{ command: "install" }` to `ParsedArgs` causes a TypeScript exhaustiveness error on the `runMain` switch until the `"install"` case is added. To avoid breaking the existing test suite mid-task, we add the `ParsedArgs` entry, the `parseCli` branch, a stub `runInstall`, and the `runMain` case all in one commit.

**Files:**
- Modify: `src/integrations/cli-template.ts`
- Test: `src/integrations/__tests__/cli-build.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/integrations/__tests__/cli-build.test.ts`, add a new import at the top of the file alongside the existing one:

```ts
// existing import — keep it
import { buildCli, generateCliSource } from "../cli.js";
// new import
import { parseCli } from "../cli-template.js";
```

Then add a new `describe` block before the existing `generateCliSource` block:

```ts
describe("parseCli", () => {
	test("--install returns install command", () => {
		expect(parseCli(["--install"])).toEqual({ command: "install" });
	});
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: runtime assertion failure — `parseCli(["--install"])` currently returns `{ command: "error", message: 'Unknown command: "--install"' }` instead of `{ command: "install" }`.

- [ ] **Step 3: Add `install` to `ParsedArgs`, add `--install` to `parseCli`, add stub `runInstall`, and add `install` case to `runMain`**

Make all four edits to `src/integrations/cli-template.ts`:

**3a. Extend `ParsedArgs`** (add `| { command: "install" }` before the `error` member):

```ts
export type ParsedArgs =
	| { command: "discover" }
	| { command: "request"; plan: string; resource?: string; paymentSignature?: string }
	| { command: "help" }
	| { command: "version" }
	| { command: "install" }
	| { command: "error"; message: string };
```

**3b. Add `--install` recognition in `parseCli`** (after the `--version` / `-v` block, before the `discover` check):

```ts
	if (first === "--install") {
		return { command: "install" };
	}
```

**3c. Add a stub `runInstall`** (place it after `runRequest`, before `runMain`). This is temporary — it will be replaced in Task 2:

```ts
export async function runInstall(
	_binaryName: string,
	_opts?: Record<string, unknown>,
): Promise<CliResult> {
	return { exitCode: 1, output: { error: "not implemented", code: "NOT_IMPLEMENTED" } };
}
```

**3d. Add `install` case to `runMain` switch** (add before the closing brace of the switch):

```ts
		case "install":
			return runInstall(name);
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: the new `parseCli` test passes. All pre-existing tests also pass (no broken intermediate state).

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/cli-template.ts src/integrations/__tests__/cli-build.test.ts
git commit -m "feat(cli): add --install to ParsedArgs, parseCli, and runMain (stub)"
```

---

## Chunk 2: Implement `runInstall`

### Task 2: Replace stub with full `runInstall` implementation

**Files:**
- Modify: `src/integrations/cli-template.ts`
- Test: `src/integrations/__tests__/cli-build.test.ts`

- [ ] **Step 1: Write the failing tests**

Update imports at the top of `src/integrations/__tests__/cli-build.test.ts`:

**a. Extend the existing `node:fs` import** to add `chmodSync` and `statSync` (keep `mkdtempSync`, `rmSync` that are already there):

```ts
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
```

**b. `node:os` and `node:path`** are already imported — do not add them again.

**c. Update the `cli-template.js` import** to add `runInstall`:

```ts
import { parseCli, runInstall } from "../cli-template.js";
```

Then add the `describe("runInstall", ...)` block after the `parseCli` describe block:

```ts
describe("runInstall", () => {
	let fakeBinary: string;
	let tmpBase: string;

	beforeAll(async () => {
		tmpBase = mkdtempSync(join(tmpdir(), "install-test-"));
		fakeBinary = join(tmpBase, "fake-binary");
		await Bun.write(fakeBinary, "#!/bin/sh\necho hello");
		chmodSync(fakeBinary, 0o755);
	});

	afterAll(() => {
		rmSync(tmpBase, { recursive: true, force: true });
	});

	test("installs to localBinDir when writable", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: false,
				pathEnv: localDir,
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output["installed"]).toBe(join(localDir, "my-agent"));
			expect(result.output["inPath"]).toBe(true);
			expect(result.output["addToPath"]).toBeTypeOf("string");
			expect(result.output["addToPath"] as string).toContain(localDir);
			const mode = statSync(join(localDir, "my-agent")).mode;
			expect(mode & 0o755).toBe(0o755);
		} finally {
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});

	test("falls through to systemBinDir when localBinDir is not writable", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			chmodSync(localDir, 0o555);
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: false,
				pathEnv: systemDir,
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output["installed"]).toBe(join(systemDir, "my-agent"));
			expect(result.output["addToPath"]).toBeUndefined();
		} finally {
			chmodSync(localDir, 0o755);
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});

	test("returns PERMISSION_DENIED when both dirs are not writable", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			chmodSync(localDir, 0o555);
			chmodSync(systemDir, 0o555);
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: false,
				pathEnv: "",
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(1);
			expect(result.output["code"]).toBe("PERMISSION_DENIED");
		} finally {
			chmodSync(localDir, 0o755);
			chmodSync(systemDir, 0o755);
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});

	test("returns UNSUPPORTED_PLATFORM on Windows", async () => {
		const result = await runInstall("my-agent", { platform: "win32", execPath: fakeBinary });
		expect(result.exitCode).toBe(1);
		expect(result.output["code"]).toBe("UNSUPPORTED_PLATFORM");
	});

	test("skips localBinDir and installs to systemBinDir when root", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: true,
				pathEnv: systemDir,
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output["installed"]).toBe(join(systemDir, "my-agent"));
			expect(result.output["addToPath"]).toBeUndefined();
		} finally {
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});

	test("inPath is false and addToPath is present when install dir not in PATH", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: false,
				pathEnv: "/usr/bin:/usr/local/bin",
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output["inPath"]).toBe(false);
			expect(result.output["addToPath"]).toBeTypeOf("string");
		} finally {
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});

	test("addToPath is absent when installed to systemBinDir", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "local-bin-"));
		const systemDir = mkdtempSync(join(tmpdir(), "system-bin-"));
		try {
			chmodSync(localDir, 0o555);
			const result = await runInstall("my-agent", {
				localBinDir: localDir,
				systemBinDir: systemDir,
				platform: "linux",
				isRoot: false,
				pathEnv: systemDir,
				execPath: fakeBinary,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output["addToPath"]).toBeUndefined();
		} finally {
			chmodSync(localDir, 0o755);
			rmSync(localDir, { recursive: true, force: true });
			rmSync(systemDir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: `runInstall` tests fail — the stub always returns `NOT_IMPLEMENTED`.

- [ ] **Step 3: Replace the stub `runInstall` with the real implementation**

Add these imports at the top of `src/integrations/cli-template.ts` (after the placeholder constant lines):

```ts
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
```

Replace the stub `runInstall` with:

```ts
export async function runInstall(
	binaryName: string,
	opts?: {
		localBinDir?: string;
		systemBinDir?: string;
		platform?: string;
		isRoot?: boolean;
		pathEnv?: string;
		execPath?: string;
	},
): Promise<CliResult> {
	const platform = opts?.platform ?? process.platform;
	if (platform === "win32") {
		return { exitCode: 1, output: { error: "Windows is not supported", code: "UNSUPPORTED_PLATFORM" } };
	}

	const isRoot = opts?.isRoot ?? (process.getuid?.() === 0);
	const srcPath = opts?.execPath ?? process.execPath;
	const localBinDir = opts?.localBinDir ?? join(homedir(), ".local", "bin");
	const systemBinDir = opts?.systemBinDir ?? "/usr/local/bin";
	const pathEnv = opts?.pathEnv ?? (process.env["PATH"] ?? "");

	function tryInstall(dir: string): string | null {
		try {
			mkdirSync(dir, { recursive: true });
			const dest = join(dir, binaryName);
			copyFileSync(srcPath, dest);
			chmodSync(dest, 0o755);
			return dest;
		} catch {
			return null;
		}
	}

	let installed: string | null = null;
	let usedLocalBin = false;

	if (!isRoot) {
		installed = tryInstall(localBinDir);
		if (installed !== null) usedLocalBin = true;
	}

	if (installed === null) {
		installed = tryInstall(systemBinDir);
	}

	if (installed === null) {
		return {
			exitCode: 1,
			output: {
				error: `Permission denied. Try: sudo ./${binaryName} --install`,
				code: "PERMISSION_DENIED",
			},
		};
	}

	const installDir = usedLocalBin ? localBinDir : systemBinDir;
	const inPath = pathEnv.split(":").includes(installDir);
	const output: Record<string, unknown> = { installed, inPath };

	if (usedLocalBin) {
		// `addToPath` uses the actual installDir so the hint is accurate
		// even when localBinDir is overridden via opts
		output["addToPath"] = `export PATH="${installDir}:$PATH"`;
	}

	return { exitCode: 0, output };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: all `runInstall` tests pass. All pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/cli-template.ts src/integrations/__tests__/cli-build.test.ts
git commit -m "feat(cli): implement runInstall with injectable deps for testability"
```

---

## Chunk 3: Update help output + final checks

### Task 3: Add `--install` to help flags and verify everything

**Files:**
- Modify: `src/integrations/cli-template.ts`
- Test: `src/integrations/__tests__/cli-build.test.ts`

- [ ] **Step 1: Add `--install` to the `help` case flags in `runMain`**

In `src/integrations/cli-template.ts`, find the `"help"` case. Update the `flags` object:

```ts
				flags: {
					"--plan": "Plan ID (required for request)",
					"--resource": "Resource ID (optional, defaults to 'default')",
					"--payment-signature": "Base64-encoded x402 payment payload from payments-mcp",
					"--install": "Install this binary to PATH (~/.local/bin or /usr/local/bin)",
				},
```

- [ ] **Step 2: Write tests for the updated help and runMain routing**

Add a new import to `src/integrations/__tests__/cli-build.test.ts` for `runMain`:

```ts
import { parseCli, runInstall, runMain } from "../cli-template.js";
```

Add a new `describe` block:

```ts
describe("runMain --install wiring", () => {
	test("--install flag appears in help flags", async () => {
		const result = await runMain(["--help"], "my-agent", "https://example.com");
		expect(result.exitCode).toBe(0);
		const flags = result.output["flags"] as Record<string, string>;
		expect(flags["--install"]).toBeTypeOf("string");
	});

	test("--install routes through runMain and returns a CliResult", async () => {
		// No control over install dirs here — just verify shape and no crash
		const result = await runMain(["--install"], "my-agent", "https://example.com");
		expect(result).toHaveProperty("exitCode");
		expect(result).toHaveProperty("output");
		expect(typeof result.exitCode).toBe("number");
	});
});
```

- [ ] **Step 3: Run all tests**

```bash
bun test src/integrations/__tests__/cli-build.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors. If lint reports formatting issues, run `bun run lint --write` to auto-fix.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/cli-template.ts src/integrations/__tests__/cli-build.test.ts
git commit -m "feat(cli): add --install to help flags output"
```
