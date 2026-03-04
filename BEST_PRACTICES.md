# Claude Code Best Practices — AgentGate SDK

This document explains the Claude Code configuration applied to this repo: what each file does, why it exists, and how to use it day-to-day.

## File Map

```
.claude/
├── settings.json               # Shared team config (git-tracked)
├── settings.local.json         # Personal config (gitignored)
├── agents/
│   ├── security-reviewer.md    # preloads: payment-invariants
│   └── test-writer.md          # preloads: payment-invariants, test-conventions
├── commands/
│   └── check.md
└── skills/
    ├── payment-invariants/
    │   └── SKILL.md            # The 5 security invariants — shared knowledge
    └── test-conventions/
        └── SKILL.md            # bun:test patterns — factory helpers, clock, concurrency
CLAUDE.md                       # Project context loaded into every Claude session
```

---

## `CLAUDE.md` — Project Context

**What it is**: A markdown file that Claude Code automatically loads at the start of every session. It's the single most impactful file for AI-assisted development.

**What ours contains**:
- Project architecture overview (two-phase payment flow, all core layers)
- All common commands (`bun test`, `bun run typecheck`, etc.)
- Code style rules (Biome: tabs, 100-char lines, double quotes)
- Key design invariants (e.g. always use `transition()` for state changes)
- Pointers to related docs (`SPEC.md`)
- Discovery section listing available agents

**Rule of thumb**: Keep it under ~150 lines. It's a briefing, not a manual.

---

## `.claude/settings.json` — Team-Shared Safety Rails

Checked into git. Every contributor gets these automatically.

### Force-Push Block

```json
"deny": [
  "Bash(git push --force*)",
  "Bash(git push -f*)"
]
```

Claude cannot force-push under any circumstances. Prevents accidental history destruction on shared branches.

### Auto-Format Hook

```json
"PostToolUse": [{
  "matcher": "Edit|Write|MultiEdit",
  "hooks": [{
    "type": "command",
    "command": "cd \"$CLAUDE_PROJECT_DIR\" && bunx biome check --write --unsafe \"$CLAUDE_FILE_PATH\" 2>/dev/null || true"
  }]
}]
```

After every file edit, Biome automatically fixes formatting. You never need to manually run `bunx biome check --write` — it happens silently in the background. The `|| true` means a Biome failure never blocks Claude's work.

### Pre-Push README Guard

```json
"PreToolUse": [{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/pre-push-readme.sh\""
  }]
}]
```

Implemented in `.claude/hooks/pre-push-readme.sh`. Before any `git push`, the hook compares pending commits against `origin/<branch>` and checks whether `src/`, `docker/`, `.github/`, or `Dockerfile` changed without a corresponding `README.md` update. If so, it exits 2 (blocking the push) and tells Claude which files need README attention. Once Claude updates and commits `README.md`, the next push is allowed through automatically.

Use `/push` as an explicit alternative — it prompts Claude to review the diff, update README if needed, commit, then push.

### `settings.local.json` (personal, gitignored)

Each developer's personal file for allow-listing tools they're comfortable with (e.g. auto-approving `bun install`, `gh pr`, etc.). Not shared because tool trust is a personal decision.

---

## `.claude/agents/` — Specialized Subagents

Agents are focused AI personas invoked with `@agent-name`. Each has a restricted tool set, explicit model, and domain-specific instructions baked in. You call them when their expertise is exactly what you need.

### `@security-reviewer`

**When to use**: Any time you modify payment-critical files — `challenge-engine.ts`, `verify-transfer.ts`, `storage/memory.ts`, `storage/redis.ts`, `access-token.ts`, or the x402 middleware.

**What it does**: Reviews code against the five security invariants that protect this payment system:

1. **State transitions** — all challenge state changes go through `transition()` (atomic CAS), never direct writes
2. **Double-spend prevention** — `markUsed()` return value is checked; rollback guard exists if transition fails after marking
3. **On-chain verification completeness** — all six checks present: receipt status, Transfer event, `to` address, amount, chainId, timestamp window
4. **JWT security** — `jti` = challengeId, HS256 secret ≥ 32 chars, `exp` present, no algorithm confusion
5. **Callback safety** — `onPaymentReceived` is fire-and-forget (correct), `onIssueToken` errors are caught

It outputs a PASS/FAIL/N/A verdict per invariant and a final APPROVE / REQUEST CHANGES verdict.

**Frontmatter config**:
- `tools: Read, Grep, Glob, WebFetch` — read-only; it literally cannot edit files
- `model: sonnet` — precise reasoning for security analysis
- `color: red` — visual signal in the agent picker

**Example invocation**:
```
@security-reviewer Please review the changes I just made to challenge-engine.ts
```

---

### `@test-writer`

**When to use**: Adding or expanding test coverage for `ChallengeEngine`, storage, adapters, or middleware.

**What it does**: Writes `bun:test` tests that match the established project conventions exactly:
- Uses `makeConfig()` / `makeEngine()` factory helpers (not inline config objects)
- Injectable `clock` for time-travel testing instead of `setTimeout`
- `InMemoryChallengeStore({ cleanupIntervalMs: 0 })` + `store.stopCleanup()` pattern
- `Promise.all` + `.filter(Boolean).length === 1` for concurrency assertions
- `AgentGateError` assertions check both `.code` and `.httpStatus`
- `MockPaymentAdapter.setVerifyResult()` for controlling verification outcomes

**Frontmatter config**:
- `tools: Read, Write, Edit, Grep, Glob, Bash` — needs write access to create test files + Bash to run `bun test`
- `model: sonnet` — good code generation
- `color: cyan` — distinct from security reviewer in the agent picker
- `permissionMode: acceptEdits` — auto-accepts file writes without pausing for confirmation on each file

**Example invocation**:
```
@test-writer Write tests for the new onPaymentReceived callback timeout behavior
```

---

## `.claude/skills/` — Shared Knowledge Bundles

Skills are markdown files that agents preload at startup. Unlike agent body text (which belongs to one agent), skills are reusable — multiple agents can load the same skill. They can also be invoked standalone as `/skill-name`.

The key distinction from `CLAUDE.md`: CLAUDE.md is loaded into every session for every task. Skills are loaded only by the agents that need them, keeping context focused.

### `payment-invariants`

The 5 security invariants that protect AgentGate's payment flow. Both agents preload this skill.

**Why both agents need it**:
- `@security-reviewer` uses it as the checklist to review code against
- `@test-writer` uses it to know *what to test* — without this skill, test-writer only knows *how* to write tests, not which security properties are critical to cover

The invariants (in brief):
1. All state changes via `transition()` — never direct writes
2. `markUsed()` return value checked + rollback guard if `transition()` subsequently fails
3. All 6 on-chain checks: receipt status, Transfer event, `to` address, amount, chainId, timestamp
4. JWT has `jti` = challengeId, `exp`, secret ≥ 32 chars
5. `onPaymentReceived` fire-and-forget; `onIssueToken` errors caught

### `test-conventions`

The exact `bun:test` patterns for this codebase. Only `@test-writer` preloads this.

Contains: imports, `makeConfig()`/`makeEngine()`/`makeRequest()` factory patterns, injectable clock for time-travel testing, `InMemoryChallengeStore({ cleanupIntervalMs: 0 })` + `stopCleanup()`, `Promise.all` + filter-Boolean concurrency assertions, `AgentGateError` `.code`/`.httpStatus` assertions, `MockPaymentAdapter.setVerifyResult()`.

---

## `.claude/commands/` — Slash Commands

Commands are reusable prompt templates invoked with `/command-name`. They appear in autocomplete.

### `/check`

**What it does**: Runs typecheck and lint together — the pre-commit sanity check.

```bash
bun run typecheck && bun run lint
```

**Fix guidance built in**:
- Lint failures: `bunx biome check --write .`
- Typecheck `noImplicitAnyLet` errors: add explicit type annotations, never use `any`

**Config**: `allowed-tools: Bash` — this command only runs shell commands, nothing else.

**Usage**: Just type `/check` in any Claude Code session.

---

## How These Work Together

**Typical workflow for a new feature:**

1. Write your implementation — Biome auto-formats every file you touch via the PostToolUse hook
2. Run `/check` to confirm typecheck + lint pass before committing
3. Call `@test-writer` to generate tests matching project conventions
4. If you touched payment-critical code, call `@security-reviewer` to verify invariants

**Typical workflow for a bug fix in `challenge-engine.ts`:**

1. Make the fix — auto-formatted on save
2. `@security-reviewer` — verify the fix doesn't break any of the 5 invariants
3. `/check` — confirm clean typecheck + lint
4. `@test-writer` — add a regression test for the bug

---

## What Was Intentionally Not Added

These patterns exist in the broader Claude Code ecosystem but don't apply here:

- **More skills** — The two existing skills cover the genuine shared-knowledge cases. General project knowledge stays in `CLAUDE.md` (loaded everywhere). Skills are only worth creating when content is too domain-specific for CLAUDE.md but useful to more than one agent.
- **Complex lifecycle hooks** (SessionStart, PreToolUse Python scripts) — useful for large teams with sophisticated automation. The single PostToolUse Biome hook is the right level for this project.
- **Agent memory** (`.claude/agent-memory/<name>/`) — allows agents to accumulate learnings across sessions. Worth adding once the agents have been used enough to identify recurring patterns worth persisting.
- **More slash commands** — `/build`, `/test` etc. are trivial one-liners developers already have memorized. Commands add value when they encode non-obvious multi-step workflows, not when they alias a single command.
