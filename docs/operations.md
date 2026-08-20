# Operations

Examples use `pnpm pulsectl` for a source checkout. With the npm installation,
run the same commands as `pulsectl`.

## Configuration

Non-secret settings live in `config.json` below the platform data directory:

- Windows: `%LOCALAPPDATA%\PulseCortex`
- macOS: `~/Library/Application Support/PulseCortex`
- Linux: `$XDG_STATE_HOME/pulsecortex` or `~/.local/state/pulsecortex`

Use `PULSECORTEX_DATA_DIR` to override the data directory and
`PULSECORTEX_ENV_FILE` to override the secret-file path.

Important settings include:

- `codexPermissionProfile` (default `:workspace`; `:danger-full-access` is rejected)
- `codexExecutable` (use when a service has a different PATH)
- `codexAppServerUrl` (loopback `ws://` URL with an explicit port)
- retention, logging, Feishu/Lark domain, and redaction settings

The default app-server URL is `ws://127.0.0.1:4500` on Windows/macOS and
`ws://127.0.0.1:4501` on Linux/WSL. Existing config files keep their explicit
value; update older Linux/WSL files manually when upgrading.

Managed sessions receive the configured permission profile. Sessions launched
independently in the Codex TUI keep their own permissions and tools.

Runtime preferences are stored in `settings.json` beside the database:

```json
{
  "defaultProject": "my-project",
  "autoStartOnBoot": false
}
```

```bash
pnpm pulsectl settings list
pnpm pulsectl settings set default-project <project-name>
pnpm pulsectl settings set default-project none
pnpm pulsectl settings set auto-start-on-boot true
pnpm pulsectl settings set auto-start-on-boot false
```

The startup setting installs or removes the same user service managed by
`pulsectl service`.

## Shared Codex Sessions

After building, install the optional shell integration:

```bash
pnpm pulsectl shell install
```

Open a new terminal, start the daemon, and run `codex` from a registered
project. Interactive and saved-session commands use the shared app-server;
maintenance commands continue to use Codex directly. If the daemon is down,
the shim warns and falls back to standalone Codex. Remove it with:

```bash
pnpm pulsectl shell uninstall
```

The explicit launcher remains available:

```bash
pnpm pulsectl codex <project>
```

Without a project argument, the launcher uses the remembered default, then the
current directory. PulseCortex discovers loaded sessions every two seconds,
rejoins controllable sessions, and preserves each session's subdirectory.
Sessions owned by another app-server remain uncontrollable because Codex
allows one runtime writer per thread.

Feishu selects the newest controllable session for a project. `/send` targets
the selected session; without one, it creates a session in the selected or
default project. `/sessions` shows three sessions per page with 100-word
previews. `/instructions` exposes supported built-ins and live instruction
presets; `/instruction` is an alias. Plan completion offers actions to
implement in the current session, implement in a fresh session, or remain in
Plan mode.

## Diagnostics And Logs

```bash
pnpm pulsectl diagnose
pnpm pulsectl project list
pnpm pulsectl project remove <project-name>
pnpm pulsectl db sessions --limit 20
pnpm pulsectl db delivery_queue --limit 20
```

`diagnose` checks the Codex executable/version, permission profile, Codex home,
temporary directory, app-server health, SQLite integrity, owner binding,
credentials (without printing values), registered paths, and queued deliveries.

Daemon events are readable in the terminal and retained below `logs/`:

- `YYYY-MM-DD/HH-NNNN.log`: redacted event records
- `HH-terminal-NNNN.ansi`: exact terminal bytes
- `HH-renderer-NNNN.jsonl`: renderer state and fallback traces

Each stream rotates at 10 MiB by local hour. Retention runs at startup and
daily, keeps the active day, and shares the configured byte budget across date
folders. Command output is stored separately in bounded per-turn JSONL files.

For missing tools, inspect the current daily log. An `execution environment
disconnected` entry blocks new turns until Codex reports ready. Provider
function-argument rejection interrupts the affected turn; PulseCortex cannot
restore tool schemas removed by an upstream proxy.

## Service Management

Build before installing. The installer uses a per-user scheduled task on
Windows (Startup-folder fallback), a LaunchAgent on macOS, and a systemd user
unit on Linux.

```bash
pnpm build
pnpm pulsectl service generate
pnpm pulsectl service install
pnpm pulsectl service status
pnpm pulsectl service uninstall
```

Use `pulsectl` instead of `pnpm pulsectl` after an npm installation. The daemon
runs as the logged-in user so Codex reuses that user's authentication. Services
do not inherit later PATH changes; set `codexExecutable` and compare
`pulsectl diagnose` output when needed. Do not run the daemon as a system
account or place credentials in service arguments.

The app-server child environment removes `FEISHU_*`, `LARK_*`, and
`PULSECORTEX_*`. Keep controller secrets only in `pulsecortex.env`.

Stopping PulseCortex also stops its shared app-server and descendants.
Independently launched standalone Codex processes are left running.

## Failure And Recovery

- Feishu offline: Codex continues; results and milestones queue locally.
- Transient API failure: bounded exponential retry, then durable queue.
- App-server exit or malformed protocol: active turns fail; session mappings remain.
- Execution-environment disconnect: active work fails; new turns wait for recovery.
- Daemon restart during work: active rows become `interrupted_unknown`.
- Missing project directory: diagnostics fails and work is blocked by path validation.
- Invalid, stale, or duplicate card: no effect; rejection is audited when attributable.

SQLite WAL files, command logs, and `logs/` are controller state. Stop the
daemon before backing up the complete data directory, and never edit the
database while the daemon is running.
