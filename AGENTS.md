# Repository Guidelines

## Project Structure

PulseCortex is a TypeScript monorepo managed with pnpm. Runtime code lives under
`packages/*/src` and is split by responsibility:

- `domain`: shared contracts, paths, text helpers, and state machines
- `config` and `persistence`: configuration, SQLite storage, migrations, audit, and logs
- `codex-driver`: Codex app-server WebSocket transport and generated protocol types
- `feishu-adapter`: Feishu SDK integration, payload normalization, and cards
- `core`: authorization and session coordination
- `daemon`, `cli`, and `installer`: process entry points, `pulsectl`, and platform setup

Tests are colocated with implementation files as `*.test.ts`. Root configuration
includes `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, and
`vitest.config.ts`; operational and security guidance is in `docs/`.

## Build, Test, and Development

Run `pnpm install` first (Node `>=25.9.0`, pnpm `11.21.0`). Common commands:

- `pnpm typecheck` - check all project references without emitting files
- `pnpm test` - run the Vitest suite once; use `pnpm test:watch` while iterating
- `pnpm build` - compile all packages; `pnpm clean` removes build output
- `pnpm dev` - run the daemon from TypeScript
- `pnpm pulsectl ...` - run local administration commands
- `pnpm protocol:generate` - regenerate Codex protocol files when required

## Coding Style and Naming

Use the existing TypeScript style: four-space indentation, semicolons, and
double-quoted strings. Keep functions and variables `camelCase`, types and
classes `PascalCase`, and constants `UPPER_SNAKE_CASE` only when truly constant.
Prefer shared domain contracts over adapter-specific payloads and validate
project paths through the existing allowlist/canonicalization APIs. Do not edit
`packages/codex-driver/src/generated`; regenerate it with the supported command.

## Testing Guidelines

Add a colocated `*.test.ts` for behavioral changes and keep tests deterministic.
Run the focused Vitest file first, then `pnpm typecheck`, `pnpm test`, and
`pnpm build` for cross-package or runtime changes. No separate coverage threshold
is configured; meaningful regression coverage is expected.

## Commits and Pull Requests

Recent history uses concise conventional prefixes such as `feat:`, `fix:`,
`docs:`, and `chore:` (for example, `fix: support Codex CLI 0.148`). Keep each
commit focused and written in the imperative mood. Pull requests should explain
the behavior change, identify affected packages, link relevant issues, list
validation commands and results, and call out configuration, migration, or
security implications. Include screenshots or captured output when changing
operator-facing CLI or Feishu cards.

## Security and Configuration

Never commit secrets or place them in source, arguments, logs, or fixtures.
Review `docs/security.md` and `docs/operations.md` before changing externally
visible behavior, persistence, or deployment paths.
