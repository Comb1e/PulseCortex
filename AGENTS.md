# PulseCortex Repository Guide

## Overview

PulseCortex is a TypeScript/pnpm monorepo for a local Feishu-to-Codex daemon.
The packages are layered from channel-neutral domain contracts through persistence,
the Codex app-server driver, Feishu integration, coordination, daemon startup,
CLI administration, and platform installers.

## Development Commands

- Install dependencies with `pnpm install`.
- Run type checking with `pnpm typecheck`.
- Run the test suite with `pnpm test`.
- Build all packages with `pnpm build`.
- Run the daemon from TypeScript with `pnpm dev`.
- Use `pnpm pulsectl ...` for local CLI administration.

Run focused Vitest tests while iterating, then run `pnpm typecheck`, `pnpm test`,
and `pnpm build` for changes that cross package boundaries or affect runtime
behavior.

## Package Boundaries

- `packages/domain`: normalized contracts, state rules, paths, and safe text
- `packages/persistence`: SQLite migrations, settings, audit, delivery, and logs
- `packages/codex-driver`: generated app-server protocol and WebSocket driver
- `packages/feishu-adapter`: Feishu SDK transport, cards, and normalization
- `packages/core`: authorization and session coordination
- `packages/daemon`: supervised process entry point
- `packages/cli`: `pulsectl` administration commands
- `packages/installer`: user-level startup and shell integration

Keep adapter-specific payloads out of coordinator behavior and preserve the
domain contracts between packages. Protocol files under
`packages/codex-driver/src/generated` are generated artifacts; regenerate them
only with the supported Codex CLI via `pnpm protocol:generate`.

## Change Guidelines

- Use Git for code management and keep commits focused.
- Preserve unrelated user changes in a dirty worktree.
- Prefer existing package patterns and shared contracts over new abstractions.
- Add or update focused tests for behavioral changes.
- Keep secrets out of source, configuration committed to the repository, logs,
  command arguments, and test fixtures.
- Validate project paths through the existing allowlist and canonicalization APIs.

## Documentation

Consult `README.md`, `docs/architecture.md`, `docs/operations.md`, and
`docs/security.md` for runtime, deployment, and security constraints before
changing cross-package or externally visible behavior.
