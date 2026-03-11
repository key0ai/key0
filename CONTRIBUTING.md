# Contributing to Key0

Thank you for your interest in contributing to Key0! No contribution is too small — whether it's a bug report, a documentation fix, a new framework adapter, or a feature proposal, all contributions are valued.

Please take a few minutes to read this guide before opening an issue or pull request.

---

## Table of Contents

- [Questions and Support](#questions-and-support)
- [Project Overview](#project-overview)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Security Vulnerabilities](#security-vulnerabilities)
- [License](#license)

---

## Questions and Support

**Please do not open GitHub Issues for questions or support requests.**

If you have a question about how to use Key0, join our community:

- **GitHub Discussions:** [github.com/Riklr/key0/discussions](https://github.com/Riklr/key0/discussions)

Reserve GitHub Issues for confirmed bugs and feature proposals only. This keeps the issue tracker actionable for maintainers.

---

## Project Overview

Key0 is a TypeScript SDK for monetizing APIs through payment-gated access using the x402 HTTP payment protocol. It enables autonomous agents to discover, pay for, and access services on-chain with USDC on Base — without complex smart contract development.

Key protocols: **x402** (HTTP 402 payment flow), **A2A** (Agent-to-Agent discovery), **EIP-3009** (gasless token authorization).

---

## Reporting Bugs

Before filing a bug:

1. **Search existing issues** to avoid duplicates.
2. **Reproduce on `master`** — the bug may already be fixed.
3. **Isolate the problem** — strip it down to a minimal reproduction.

When opening a bug report, include:

- Bun version (`bun --version`) and Node.js version if applicable
- Operating system and version
- Network: testnet (Base Sepolia) or mainnet (Base)
- Framework being used (Express / Hono / Fastify / standalone)
- Transaction hash if the issue involves a payment or on-chain operation
- Exact error message and stack trace
- Minimal code snippet that reproduces the issue

---

## Requesting Features

**Small changes** (a new config option, an additional helper, a minor API improvement): open a pull request directly with a clear description of the motivation.

**Large or breaking changes** (new payment adapter, new protocol support, changes to the challenge/token flow, new framework integration, API redesign): open a GitHub Issue or Discussion first. Describe the use case and proposed approach before writing code. This prevents wasted effort and ensures alignment with the project's direction.

If you are unsure whether something qualifies as large, open a Discussion first — it's always better to align early.

---

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.3 or later
- Node.js 18+ (for compatibility testing)
- A wallet address on **Base Sepolia** (testnet) for running integration examples
  - Get testnet USDC from the [Base Sepolia faucet](https://faucet.circle.com)
  - Never use mainnet funds for development

### Setup

```bash
# 1. Fork and clone
git clone https://github.com/Riklr/key0.git
cd key0

# 2. Install dependencies
bun install

# 3. Set up environment variables for examples
cp examples/express-seller/.env.example examples/express-seller/.env
# Edit .env with your testnet wallet keys

# 4. Run tests
bun test

# 5. Run the linter
bun run lint

# 6. Type check
bun run typecheck
```

### Environment Variables

When running examples locally, you need a `.env` file in the example directory:

```env
WALLET_A_KEY=0x...        # Sender private key (testnet only)
WALLET_B_ADDRESS=0x...    # Receiver address (no private key needed)
NETWORK=testnet           # Always use testnet for development
```

**Never commit private keys.** The `.env` file is gitignored. Always use Base Sepolia (testnet) for development — real USDC on mainnet is not needed to contribute.

---

## Project Structure

```
src/
├── adapter/         # On-chain USDC payment verification (viem)
├── core/            # Challenge engine, token issuer, storage (memory/Redis)
├── integrations/    # Framework adapters (Express, Hono, Fastify)
├── types/           # Shared TypeScript interfaces
├── helpers/         # Remote verifiers and auth strategies
├── validator/       # Lightweight token validation for backend services
├── test-utils/      # Mock adapters and test fixtures
├── executor.ts      # A2A executor implementation
├── factory.ts       # Key0 factory
├── middleware.ts    # Token validation middleware
└── index.ts         # Public export barrel

examples/
├── express-seller/  # Express-based API provider with pricing tiers
├── hono-seller/     # Hono-based API provider
├── client-agent/    # Buyer agent making real USDC payments
└── standalone-service/ # Standalone deployment mode

docs/                # Documentation (contributions welcome)
```

---

## Making Changes

### Branch Naming

Branch off `master` and use a prefix that matches your change type:

| Prefix | Use for |
|---|---|
| `feat/` | New features or enhancements |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `chore/` | Tooling, deps, CI, refactoring |
| `test/` | Tests only |

Examples: `feat/fastify-adapter`, `fix/challenge-expiry-race`, `docs/hono-example`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`

**Scopes:** `core`, `adapter`, `express`, `hono`, `fastify`, `validator`, `helpers`, `examples`, `types`

**Examples:**
```
feat(hono): add payment middleware for Hono framework
fix(adapter): handle chain reorg during tx verification
docs(examples): update express-seller README with testnet steps
chore(deps): upgrade viem to v2.22.0
test(core): add challenge expiry edge case coverage
```

Keep the summary under 72 characters. Use the commit body for context when the change isn't self-evident.

---

## Code Style

Key0 uses [Biome](https://biomejs.dev) for linting and formatting. All code must pass:

```bash
bun run lint        # Check for lint errors
bun run typecheck   # TypeScript strict mode check
```

Key rules:
- **No `any`** — use proper TypeScript types or generics
- **No unused variables or imports** — Biome enforces this
- **Strict TypeScript** — `tsconfig.json` has `strict: true`
- Do not disable Biome rules with inline comments without a clear explanation

If you are adding a new framework integration, follow the existing pattern in `src/integrations/` — wrap the core `Key0` instance, don't reimplement logic.

---

## Testing

```bash
bun test            # Run the full test suite
bun test --watch    # Watch mode during development
```

**Requirements for pull requests:**

- All existing tests must pass
- New features must include unit tests
- Bug fixes should include a regression test that would have caught the bug
- Integration tests that require a live Base Sepolia connection are tagged and optional in CI — mock the blockchain interaction for unit tests using the utilities in `src/test-utils/`

Do not use mainnet in tests. Mock on-chain calls wherever possible; use Base Sepolia only for true end-to-end integration tests in the `examples/` directory.

---

## Pull Request Process

1. Ensure `bun test`, `bun run lint`, and `bun run typecheck` all pass locally.
2. Update documentation in the PR if your change affects public API, configuration options, or examples.
3. Fill in the pull request description:
   - What does this change do?
   - Why is it needed?
   - Link to the related issue if one exists (`Closes #123`)
4. Keep PRs focused — one logical change per PR. Large PRs are harder to review and slower to merge.
5. Be responsive to review feedback. If a change is requested, push a follow-up commit rather than force-pushing so the review history is preserved.
6. At least one maintainer approval is required to merge.

---

## Security Vulnerabilities

> **Do not report security vulnerabilities as public GitHub Issues.**

Key0 handles payment flows, private key management patterns, EIP-3009 authorization, and on-chain transaction verification. A vulnerability in any of these areas could result in loss of funds.

If you discover a security vulnerability, please report it privately:

**Email:** `founders@riklr.com`

Include in your report:
- Description of the vulnerability and the potential impact
- Steps to reproduce or a proof-of-concept (do not exploit it against real funds)
- Affected versions
- Any suggested mitigations

We will acknowledge your report within 48 hours, keep you informed of our progress, and credit you in the release notes when the fix is published (unless you prefer to remain anonymous).

---

## License

By submitting a pull request to this repository, you agree that your contribution will be licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE) — the same license that covers the rest of the project. You confirm that you have the right to submit the work under this license.
