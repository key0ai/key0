# CLI Self-Install Design

**Date:** 2026-03-16
**Status:** Approved

## Problem

The Key0 CLI binary (produced by `buildCli()`) currently requires manual installation steps: the user must `chmod +x` the binary and manually move it to a directory in `PATH`. This is a friction point for both human developers and AI agents that need to use the CLI autonomously.

## Goal

Make the CLI binary self-installable via a single `--install` flag, following the same pattern as tools like `gh` and `aws-cli`. After installation, the binary is callable by name from anywhere in the shell.

## Scope

- **In scope:** Adding `--install` to `cli-template.ts` only. No changes to `cli.ts` (the `buildCli()` function) or any other file.
- **Out of scope:** Homebrew tap, npm publishing, universal CLI, install scripts, GitHub Releases integration.

## Design

### New command: `--install`

Added to `cli-template.ts` alongside existing commands (`discover`, `request`, `--help`, `--version`).

### `parseCli` change

Recognizes `--install` as a top-level flag and returns `{ command: "install" }`.

### `runInstall(binaryName: string): Promise<CliResult>`

Install logic (in order):

1. Get own path via `process.execPath`
2. **Try `~/.local/bin/<CLI_NAME>`**
   - Create directory if it doesn't exist (`mkdir -p`)
   - Copy binary to that path
   - Set permissions to `0o755`
3. **If step 2 throws**, try `/usr/local/bin/<CLI_NAME>` (no sudo — works on many systems)
4. **If step 3 also throws**, return:
   ```json
   { "exitCode": 1, "output": { "error": "Permission denied. Try: sudo ./<binary> --install", "code": "PERMISSION_DENIED" } }
   ```
5. On success, check if install dir is in `process.env.PATH`
6. If not in PATH, include `addToPath` hint in output:
   ```
   export PATH="$HOME/.local/bin:$PATH"
   ```
7. Return machine-readable JSON so AI agents can parse the result:
   ```json
   { "installed": "/home/user/.local/bin/key0-agent", "inPath": true }
   ```

### `runMain` change

Routes `command: "install"` to `runInstall(CLI_NAME)`.

### Updated help output

`--help` lists `--install` as a command:
```
--install   Install this binary to PATH (~/.local/bin or /usr/local/bin)
```

## User / Agent Flow

```bash
# 1. Download (seller provides platform-specific URL)
curl -fsSL https://myservice.com/downloads/key0-agent-darwin-arm64 -o key0-agent

# 2. Make executable
chmod +x ./key0-agent

# 3. Self-install
./key0-agent --install
# → { "installed": "/home/user/.local/bin/key0-agent", "inPath": true }

# 4. Use from anywhere
key0-agent discover
key0-agent request --plan basic
```

## Error Cases

| Situation | Behavior |
|---|---|
| `~/.local/bin` write fails | Fall through to `/usr/local/bin` |
| Both paths fail | Exit 1, print sudo hint |
| Already installed | Overwrite silently (idempotent) |
| Install dir not in PATH | Exit 0, include `addToPath` field in JSON output |

## Testing

- Unit test `parseCli(["--install"])` returns `{ command: "install" }`
- Unit test `runInstall` with a writable temp dir — verify binary is copied and executable
- Unit test `runInstall` with a non-writable dir — verify fallback behavior
- Unit test PATH detection — in PATH vs not in PATH

## Files Changed

- `src/integrations/cli-template.ts` — only file modified
