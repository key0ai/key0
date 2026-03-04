---
description: Review README, update if needed, then push
allowed-tools: Bash, Read, Edit
---

Before pushing, review docs against what's actually being pushed:

1. Run `git diff origin/$(git rev-parse --abbrev-ref HEAD)...HEAD --stat` to see what's changing.
   Also run `git diff origin/$(git rev-parse --abbrev-ref HEAD)...HEAD -- '*.ts' '*.js'` to read the actual code changes.

2. Review README.md — decide whether it still accurately describes:
   - Installation / quick-start commands
   - Configuration options and env vars
   - Architecture or data flow
   - Any new files, endpoints, or features

3. Review CLAUDE.md — based on the code changes, decide whether any section needs updating:
   - New or renamed states in `challenge-engine.ts` → update the state machine description in "Core Layers"
   - New files or modules added → update the relevant layer description
   - New config fields in `SellerConfig` → update "Key Configuration"
   - New integrations or entry points → update "Entry Points" or "Integrations"
   - New storage methods or atomicity guarantees → update "Storage Abstraction"
   - New auth helpers → update "Auth Helpers"
   Keep changes minimal — only update what is factually wrong or missing.

4. If any docs were updated:
   - `git add README.md CLAUDE.md` (only the ones you changed)
   - `git commit -m "docs: update <README/CLAUDE> for <brief description of what changed>"`

5. Run `git push`.
