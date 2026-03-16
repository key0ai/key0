# CLI Self-Install Design

**Date:** 2026-03-16
**Status:** Approved

## Problem

The Key0 CLI binary (produced by `buildCli()`) currently requires manual installation steps: the user must `chmod +x` the binary and manually move it to a directory in `PATH`. This is a friction point for both human developers and AI agents that need to use the CLI autonomously.

## Goal

Make the CLI binary self-installable via a single `--install` flag. After installation, the binary is callable by name from anywhere in the shell.

## Scope

- **In scope:** Adding `--install` to `cli-template.ts` only. No changes to `cli.ts` or any other file.
- **Out of scope:** Homebrew tap, npm publishing, universal CLI, install scripts, GitHub Releases, Windows support.
- **Windows:** Not supported. `--install` exits with `code: "UNSUPPORTED_PLATFORM"` on `process.platform === "win32"`.

## Background: `CLI_NAME` and `CLI_URL`

`cli-template.ts` is a source template. At build time, `buildCli()` replaces two placeholder constants:

```ts
export const CLI_NAME = "__CLI_NAME__";  // replaced with e.g. "key0-agent"
export const CLI_URL  = "__CLI_URL__";   // replaced with e.g. "https://myservice.com"
```

`CLI_NAME` is the installed binary name (no spaces, already slugified by `buildCli()`). `runInstall` uses the `name` parameter (passed as `CLI_NAME` from `runMain`) as the destination filename.

## Design

### New command: `--install`

Added to `cli-template.ts` alongside `discover`, `request`, `--help`, `--version`.

### `parseCli` change

Recognizes `--install` as a top-level flag (same as `--help`, `--version`) and returns `{ command: "install" }`. The `ParsedArgs` union type gains: `{ command: "install" }`.

### `runInstall(binaryName: string): Promise<CliResult>`

`CliResult` is the existing type in `cli-template.ts`: `{ exitCode: number; output: Record<string, unknown> }`.

**Getting own path:** Use `process.execPath`. In a compiled Bun standalone binary, `process.execPath` points to the binary itself. (In interpreted mode it would point to the Bun runtime — but `runInstall` only runs inside a compiled binary, guarded by the `IS_MAIN` check.)

**Install logic (in order):**

1. If `process.platform === "win32"`, return `{ exitCode: 1, output: { error: "Windows is not supported", code: "UNSUPPORTED_PLATFORM" } }`

2. **Detect if running as root** (`process.getuid?.() === 0` on POSIX):
   - If root → skip `~/.local/bin`, go directly to step 4 (`/usr/local/bin`). Avoids installing into a user home dir when invoked via `sudo`.

3. **Try `~/.local/bin/<binaryName>`** (expand `~` via `os.homedir()`):
   - `mkdirSync(dir, { recursive: true })`
   - `copyFileSync(process.execPath, destPath)`
   - `chmodSync(destPath, 0o755)`
   - If **any** of the above throws → fall through to step 4
   - If all succeed → proceed to step 5

4. **Try `/usr/local/bin/<binaryName>`:**
   - Same: `copyFileSync` then `chmodSync(destPath, 0o755)`
   - If either throws → return:
     ```json
     { "exitCode": 1, "output": { "error": "Permission denied. Try: sudo ./<binary> --install", "code": "PERMISSION_DENIED" } }
     ```

5. **Atomicity note:** `copyFileSync` + `chmodSync` is not atomic. If interrupted between the two, a non-executable file sits at the destination. On re-run it is overwritten silently. Acceptable; no extra protection is added.

6. **PATH check:** Split `process.env.PATH ?? ""` on `:` and check if the install directory is present. Reflects PATH at process-launch time only; may produce a false negative if the shell rc already adds the dir. Best-effort only.

7. **Return success:**
   - `installed`: the actual resolved absolute path (e.g. `/Users/alice/.local/bin/key0-agent` on macOS)
   - `inPath`: boolean from step 6
   - `addToPath`: included **only** when install dir is `~/.local/bin`. Always present regardless of `inPath` value so agents can always find it. Value is bash/zsh-compatible; agents must decide which rc file to update.

   ```json
   {
     "installed": "/Users/alice/.local/bin/key0-agent",
     "inPath": true,
     "addToPath": "export PATH=\"$HOME/.local/bin:$PATH\""
   }
   ```

   When installed to `/usr/local/bin`, `addToPath` is omitted:
   ```json
   { "installed": "/usr/local/bin/key0-agent", "inPath": true }
   ```

**Overwrite behaviour:** Existing binaries at the destination are silently overwritten (idempotent). Intentional — no integrity check is performed.

### `runMain` change

- Add `"install"` case to the `switch (parsed.command)` block. Because the switch covers all members of `ParsedArgs` and TypeScript enforces exhaustiveness, the `"install"` case **must** be added to avoid a compile error.
- Call: `return runInstall(name)` (using the `name` parameter already in scope in `runMain`, not the module-level `CLI_NAME`).

### Updated help output

`--install` is a flag (like `--help`, `--version`), not a subcommand. It belongs in the `flags` section of the help output, not in `commands`:

```json
{
  "commands": {
    "discover": "List available plans (GET /discovery)",
    "request": "Request access or submit payment (POST /x402/access)"
  },
  "flags": {
    "--plan": "Plan ID (required for request)",
    "--resource": "Resource ID (optional, defaults to 'default')",
    "--payment-signature": "Base64-encoded x402 payment payload from payments-mcp",
    "--install": "Install this binary to PATH (~/.local/bin or /usr/local/bin)"
  }
}
```

## User / Agent Flow

```bash
# 1. Download (seller provides platform-specific URL)
curl -fsSL https://myservice.com/downloads/key0-agent-darwin-arm64 -o key0-agent

# 2. Make executable
chmod +x ./key0-agent

# 3. Self-install
./key0-agent --install
# → { "installed": "/Users/alice/.local/bin/key0-agent", "inPath": true, "addToPath": "export PATH=\"$HOME/.local/bin:$PATH\"" }

# 4. Use from anywhere
key0-agent discover
key0-agent request --plan basic
```

## Error Cases

| Situation | Behavior |
|---|---|
| Windows | Exit 1, `code: "UNSUPPORTED_PLATFORM"` |
| `~/.local/bin` write fails (any step) | Fall through to `/usr/local/bin` |
| Both paths fail | Exit 1, `code: "PERMISSION_DENIED"`, sudo hint |
| Running as root | Skip `~/.local/bin`, install directly to `/usr/local/bin` |
| Already installed | Overwrite silently (idempotent) |
| Install dir not in PATH | Exit 0, `inPath: false`, `addToPath` included (for `~/.local/bin` only) |

## Testing

- `parseCli(["--install"])` returns `{ command: "install" }`
- `runInstall` with writable temp dir as `~/.local/bin` — binary copied, permissions `0o755`
- `runInstall` with non-writable first dir, writable second dir — falls through correctly
- `runInstall` with both dirs non-writable — `exitCode: 1`, `code: "PERMISSION_DENIED"`
- `runInstall` on Windows (mock `process.platform`) — `code: "UNSUPPORTED_PLATFORM"`
- `runInstall` as root (mock `process.getuid()` → 0) — installs to `/usr/local/bin`, skips `~/.local/bin`
- PATH detection: install dir in PATH → `inPath: true`; not in PATH → `inPath: false`, `addToPath` present
- `/usr/local/bin` success — `addToPath` absent from output

## Files Changed

- `src/integrations/cli-template.ts` — only file modified
