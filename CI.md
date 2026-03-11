# CI / CD Overview

This document explains every automated workflow and background service in this repository, what each step does, and why it exists.

---

## Workflows at a glance

| File | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Push / PR to `main` | Gate — must pass before anything merges or publishes |
| `canary.yml` | After CI passes on `main` | Publish a pre-release to npm for early testing |
| `release.yml` | Push of a `v*` tag | Publish the stable release to npm + Docker |
| `changeset-check.yml` | PR to `main` | Remind contributors to include a changeset file |
| `codeql.yml` | Push / PR to `main` + weekly | Static security analysis |
| `pr-title.yml` | PR opened / edited | Enforce conventional commit format on PR titles |
| `stale.yml` | Daily schedule | Auto-close inactive issues and PRs |
| `dependabot.yml` | Weekly schedule | Auto-open PRs for dependency updates |

---

## `ci.yml` — Continuous Integration

**Triggers:** every push to `main` and every pull request targeting `main`.

```
concurrency group: cancels any in-progress run for the same branch/PR
```
Prevents two pushes in quick succession from running duplicate CI jobs, saving runner minutes and avoiding confusing overlapping status checks.

### Steps

**`bun install --frozen-lockfile`**
Installs dependencies exactly as recorded in the lockfile. `--frozen-lockfile` fails the build if the lockfile is out of sync with `package.json`, ensuring every CI run uses the same dependency tree as local development.

**`npm audit --audit-level=high`**
Checks all dependencies against the npm advisory database for known CVEs. Runs at `high` severity so the build fails on high and critical vulnerabilities but not on low/moderate noise. Uses `npm install --package-lock-only --ignore-scripts` first to generate a `package-lock.json` from `package.json` since bun does not produce one.

> This is particularly important for this SDK because it handles USDC payments and JWT signing — a compromised dependency (e.g. `viem`, `jose`) could directly impact funds or auth tokens.

**`bun run typecheck`**
Runs `tsc --noEmit` to catch type errors without emitting output. Catches API contract mismatches and invalid config shapes early, before they reach runtime.

**`bun run lint`**
Runs Biome to enforce code style and catch common mistakes. Keeps the codebase consistent for contributors.

**`bun test --recursive`**
Runs the full test suite. All tests must pass for the branch to be considered healthy.

---

## `canary.yml` — Canary Publish

**Triggers:** fires automatically after the CI workflow completes successfully on `main`.

```yaml
if: ${{ github.event.workflow_run.conclusion == 'success' }}
```
Uses `workflow_run` instead of `push` so canary never publishes from a commit that failed CI. This avoids running typecheck and tests twice (CI already did them).

### Steps

**`actions/checkout` with `fetch-depth: 0`**
Fetches the full git history and all tags. `changeset publish` needs this to compare against already-published tags and determine what needs to be released.

**`bun run build`**
Compiles TypeScript to `dist/` via `tsc`. The published package contains compiled JavaScript and `.d.ts` declaration files, not raw TypeScript source.

**`bunx @changesets/cli version --snapshot canary`**
Bumps all package versions to a snapshot identifier (e.g. `0.1.0-canary-20240301120000`) without consuming the pending changesets. This gives every main-branch commit a unique, installable pre-release version.

**`bunx @changesets/cli publish --tag canary --provenance`**
Publishes to npm under the `canary` dist-tag. `--provenance` attaches a signed SLSA provenance attestation so consumers can verify the package was built from this exact commit in this repository.

### Docker job (`docker`, needs: canary)

Runs after the npm publish job succeeds. Builds and pushes a multi-arch Docker image (`linux/amd64`, `linux/arm64`) to DockerHub as `riklr/key0:canary`. Uses GitHub Actions cache (`type=gha`) for faster layer rebuilds.

**`NODE_AUTH_TOKEN`**
Set from the `NPM_TOKEN` repository secret. The `.npmrc` at the root of the repo wires this into the npm registry auth automatically.

**Permissions: `contents: write`, `id-token: write`**
`contents: write` is required for `changeset publish` to create git tags. `id-token: write` is required by GitHub's OIDC provider to issue the provenance attestation.

---

## `release.yml` — Stable Release Publish

**Triggers:** any tag pushed matching `v*` (e.g. `v1.0.0`, `v0.2.1`).

The expected workflow for cutting a release:
1. Run `bun changeset` locally to describe your changes
2. Run `npx changeset version` locally to bump versions and update the changelog
3. Commit those changes and push to `main`
4. Tag the commit: `git tag v1.0.0 && git push --tags`
5. This workflow publishes automatically

### Steps

**`actions/checkout` with `fetch-depth: 0`**
Same as canary — full history needed for `changeset publish` to resolve existing tags.

**`bun run build`**
Compiles TypeScript to `dist/` before publishing. Consumers receive compiled JavaScript and type declarations.

**`npx changeset publish --provenance`**
Publishes all packages that have not yet been published at their current version. `--provenance` attaches a signed SLSA attestation linking the npm package to this exact GitHub Actions run and commit SHA.

**Permissions: `contents: write`, `id-token: write`**
Same as canary — required for git tagging and OIDC provenance.

### Docker job (`docker`, needs: publish)

Runs after the npm publish job succeeds. Builds and pushes a multi-arch Docker image (`linux/amd64`, `linux/arm64`) to DockerHub as `riklr/key0` with the following tags derived from the git tag via `docker/metadata-action`:

- `riklr/key0:<full semver>` (e.g. `1.2.3`)
- `riklr/key0:<major>.<minor>` (e.g. `1.2`)
- `riklr/key0:<major>` (e.g. `1`)
- `riklr/key0:latest`

Uses GitHub Actions cache (`type=gha`) for faster layer rebuilds.

---

## `changeset-check.yml` — Changeset Reminder

**Triggers:** every pull request targeting `main`.

Comments on a PR if no changeset file (`.changeset/*.md`) was included. This is a reminder only — it does not block the merge, version the package, or publish anything. Releases remain fully manual.

See `.changeset/README.md` for the full release workflow.

---

## `codeql.yml` — Static Security Analysis

**Triggers:** push and PRs to `main`, plus a weekly scheduled scan every Monday.

The scheduled scan catches vulnerabilities that were introduced not by a code change but by a newly published CVE in a pattern CodeQL recognises.

```
concurrency group: cancels stale runs on the same ref
```

### Steps

**`github/codeql-action/init`**
Initialises the CodeQL analysis engine for `javascript-typescript`. This covers both the TypeScript source and any compiled JavaScript.

**`github/codeql-action/autobuild`**
Automatically builds the project so CodeQL can trace data flows through the compiled output.

**`github/codeql-action/analyze`**
Runs the full CodeQL query suite and uploads results to GitHub's Security tab. Findings appear as code scanning alerts and can block PRs if branch protection rules require clean scans.

> This is especially relevant for this SDK because CodeQL detects data-flow issues — for example, user-controlled input (resourceId, clientAgentId) flowing into sensitive operations without sanitisation.

---

## `pr-title.yml` — PR Title Linting

**Triggers:** when a PR is opened, edited, or updated with new commits.

```
concurrency group: cancels stale runs on the same PR
```

Enforces that every PR title follows the [Conventional Commits](https://www.conventionalcommits.org/) format using `amannn/action-semantic-pull-request`.

**Allowed types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `ci`, `build`

**Why this matters:** Changesets generates changelogs from PR titles and commit messages. Inconsistent titles produce low-quality changelogs. Enforcing this at the PR stage costs nothing and keeps release notes meaningful for users.

Examples of valid titles:
```
feat: add Redis storage adapter
fix: handle expired challenges gracefully
docs: add Express integration example
chore: upgrade viem to v2.5
```

---

## `stale.yml` — Stale Issue and PR Management

**Triggers:** runs on a daily schedule at midnight UTC.

Keeps the issue tracker clean as the project grows.

| | Issues | PRs |
|---|---|---|
| Marked stale after | 60 days inactive | 30 days inactive |
| Closed after stale | 7 days | 7 days |
| Exempt labels | `pinned`, `security`, `bug` | `pinned`, `security` |

`security` and `bug` issues are never auto-closed — a valid security report or reproducible bug should not disappear due to inactivity.

---

## `dependabot.yml` — Automated Dependency Updates

Not a workflow file — this configures GitHub's Dependabot service directly.

**npm (weekly):** Opens PRs to update `package.json` dependencies. For security advisories, Dependabot opens PRs immediately regardless of the schedule. Limit of 10 open PRs at a time to avoid noise.

**github-actions (weekly):** Opens PRs to update action versions used in `.github/workflows/`. Keeps `actions/checkout`, `oven-sh/setup-bun`, etc. on their latest patch versions. Limit of 5 open PRs at a time.

> Keeping GitHub Actions up to date is itself a security practice — older versions of actions may have known vulnerabilities or use deprecated Node.js runtimes.

---

## Security design decisions

**`--frozen-lockfile` everywhere**
Reproducible installs. Prevents a compromised registry package from being silently pulled in by a version range resolution at CI time.

**`npm audit --audit-level=high` on every PR**
Catches known CVEs in the dependency tree before they merge. High/critical threshold avoids alert fatigue from low-severity findings while still blocking dangerous vulnerabilities.

**`--provenance` on all publishes**
Every package published from this repo — canary or stable — carries a signed SLSA Level 2 provenance attestation. Users can verify on `npmjs.com` that the package was built from the declared source commit and was not modified after the build.

**Principle of least privilege**
Each workflow declares only the permissions it actually needs. `ci.yml` has `contents: read` only. Publish workflows have `contents: write` (for git tagging) and `id-token: write` (for OIDC provenance) and nothing else.
