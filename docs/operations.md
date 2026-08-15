# Operations

## Configuration

Non-secret settings live in `config.json` below the platform data directory:

- Windows: `%LOCALAPPDATA%\PulseCortex`
- macOS: `~/Library/Application Support/PulseCortex`
- Linux: `$XDG_STATE_HOME/pulsecortex` or `~/.local/state/pulsecortex`

`PULSECORTEX_DATA_DIR` overrides the directory. `PULSECORTEX_ENV_FILE` overrides the secret-file path.

Supported settings include status/approval intervals, metadata/log retention, log byte ceiling, Feishu or Lark domain, log level, and JavaScript regular expressions for additional redaction.

## Diagnostics

```powershell
pnpm pulsectl diagnose
pnpm pulsectl project list
pnpm pulsectl db sessions --limit 20
pnpm pulsectl db delivery_queue --limit 20
```

Diagnostics verifies the pinned Codex version, SQLite integrity, owner/chat binding, credential presence without displaying values, registered directory existence, and queued delivery count. The daemon logs Feishu connection transitions and retry state as structured JSON.

## Service Management

Build before installing. The installer uses a scheduled task at user logon on Windows, a LaunchAgent on macOS, and a systemd user unit on Linux.

```powershell
pnpm build
pnpm pulsectl service generate
pnpm pulsectl service install
pnpm pulsectl service status
pnpm pulsectl service uninstall
```

The daemon runs as the logged-in user so `codex app-server` reuses that user's existing authentication. Do not run it as a system account or copy Codex credentials into the service environment.

## Failure Semantics

- Feishu offline: Codex continues; state transitions and results queue locally; approvals wait.
- API throttle/transient error: bounded exponential retry, then durable queue.
- Codex app-server exit or malformed protocol: active turn fails; thread mapping remains.
- Daemon restart during work: active state becomes `interrupted_unknown`; it never claims completion.
- Missing project directory: diagnostics fails and new/resumed work is blocked by path validation.
- Invalid/stale/duplicate card: no effect; audit records a rejected action where attribution is available.

SQLite WAL files and command-log files are part of controller state. Stop the daemon before a manual backup and back up the entire data directory. Never edit the database while the daemon is running.
