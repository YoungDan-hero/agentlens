# Contributing to AgentLens

Thanks for your interest in contributing! This document describes the development workflow and conventions.

## Prerequisites

- Node.js >= 22.13 (pnpm 11 depends on the `node:sqlite` builtin)
- [pnpm](https://pnpm.io) (version pinned in the `packageManager` field of `package.json`)

## Getting started

```bash
git clone https://github.com/YoungDan-hero/agentlens.git
cd agentlens
pnpm install
pnpm build
pnpm test
```

## Repository layout

This is a pnpm monorepo. All publishable packages live in `packages/`:

- `shared` — wire protocol and shared types; every other package depends on it
- `runtime` — browser-side collector SDK
- `vite-plugin` — dev-mode injection of the runtime
- `mcp-server` — the daemon exposing events over MCP

## Development workflow

| Command                         | Purpose                            |
| ------------------------------- | ---------------------------------- |
| `pnpm build`                    | Build all packages with tsup       |
| `pnpm test` / `pnpm test:watch` | Run Vitest                         |
| `pnpm lint` / `pnpm lint:fix`   | ESLint (type-aware, strict)        |
| `pnpm typecheck`                | `tsc --noEmit` across all packages |
| `pnpm format`                   | Prettier                           |

## Commit conventions

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:`, ...). This is enforced by commitlint via a `commit-msg` hook. A `pre-commit` hook runs ESLint and Prettier on staged files.

## Changesets

Any PR that changes a published package must include a changeset:

```bash
pnpm changeset
```

Pick the affected packages and a semver bump, then describe the change. Releases are automated on `main` via the Changesets GitHub Action.

## Pull requests

1. Fork and create a feature branch from `main`.
2. Make your changes, including tests for behavior changes.
3. Ensure `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
4. Open a PR using the template. CI must be green before review.

## Code style

- Strict TypeScript. `any` is a lint error; prefer generics and type guards.
- No classes in browser-facing APIs unless state encapsulation genuinely requires it.
- Comments explain intent and constraints, not what the code does.
