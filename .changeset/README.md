# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets). It tracks unreleased changes and drives versioning + changelog generation for `@riklr/key0`.

---

## What is a changeset?

A changeset is a small markdown file (auto-named, e.g. `fuzzy-dogs-eat.md`) that describes:
- **What changed** — a human-readable summary that lands in `CHANGELOG.md`
- **Semver bump type** — `patch`, `minor`, or `major`

These files live in `.changeset/` and are committed alongside your code changes. They are consumed and deleted when a release is cut.

---

## What gets released

Every release publishes **two artifacts** from the `release.yml` workflow:

| Artifact | Target |
|---|---|
| npm package | `@riklr/key0` on npmjs.com |
| Docker image | `riklr/key0` on Docker Hub (tagged by semver + `latest`) |

Both are triggered automatically when a `v*` tag is pushed to `main`.

---

## Release workflow

### Changeset bot (PR reminder)

The `changeset-check.yml` workflow runs on every PR to `main` and comments if a changeset file is missing. This is a reminder only — it does not version or publish anything. Releases remain fully manual.

### Current approach: manual tag

#### 1. During development — add a changeset

Whenever you make a change worth releasing, run:

```bash
bunx changeset
```

This prompts you to select the bump type and describe the change. Commit the generated `.changeset/*.md` file with your PR.

**Bump guide:**
| Change type | Bump |
|---|---|
| Bug fix, docs, internal refactor | `patch` |
| New feature, new export, new config option | `minor` |
| Breaking API change | `major` |

#### 2. Before releasing — version the package

Once all changesets are merged to `main`, run locally:

```bash
bunx changeset version
```

This:
- Reads all pending `.changeset/*.md` files
- Bumps `package.json` version (highest bump wins across all changesets)
- Updates `CHANGELOG.md`
- Deletes the consumed changeset files

Commit the result:

```bash
git add .
git commit -m "chore: version packages"
```

#### 3. Publish — push a tag

Tag the release and push. CI handles the rest:

```bash
git tag v<version>   # e.g. git tag v0.2.0
git push origin main --tags
```

The `release.yml` workflow triggers on `v*` tags and:
1. Runs `bun run build`
2. Runs `changeset publish --provenance` → publishes to npm
3. Builds and pushes the Docker image to `riklr/key0` (only runs if npm publish succeeds)

---

## Config (`config.json`)

| Field | Value | Meaning |
|---|---|---|
| `access` | `"public"` | Published as a public npm package |
| `baseBranch` | `"main"` | Changesets diff against `main` |
| `commit` | `false` | `changeset version` does not auto-commit |
| `changelog` | `@changesets/cli/changelog` | Default changelog format |

---

## What NOT to do

- Do not manually edit `package.json` version — let `changeset version` do it.
- Do not skip adding a changeset for user-facing changes — the CHANGELOG will be missing the entry.
- Do not push a tag without first running `changeset version` — `changeset publish` will find no changesets and may publish with a stale version.
