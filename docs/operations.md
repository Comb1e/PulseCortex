# Operations

## Configuration

Non-secret settings live in `config.json` below the platform data directory:

- Windows: `%LOCALAPPDATA%\PulseCortex`
- macOS: `~/Library/Application Support/PulseCortex`
- Linux: `$XDG_STATE_HOME/pulsecortex` or `~/.local/state/pulsecortex`

`PULSECORTEX_DATA_DIR` overrides the directory. `PULSECORTEX_ENV_FILE` overrides the secret-file path.

Supported settings include status/approval intervals, metadata/log retention, log byte ceiling, Feishu or Lark domain, log level, JavaScript regular expressions for additional redaction, and `codexAppServerUrl`. The latter defaults to `ws://127.0.0.1:4500` on Windows and macOS and `ws://127.0.0.1:4501` on Linux, including WSL. It must remain a loopback `ws://` URL with an explicit port. Existing `config.json` files retain their explicit value; change the Linux/WSL value to port `4501` manually when upgrading an initialized installation.

Runtime preferences are stored in `settings.json` rather than `config.json` or SQLite. The file is created below the platform data directory with this shape:

```json
{
  "defaultProject": "pulsecortex",
  "autoStartOnBoot": false
}
```

PulseCortex records the last project selected through Feishu, a resumed or addressed session, or `pulsectl codex`. At daemon startup it prefers the newest controllable session in that project; if none is running, ordinary task text and `/new` use the remembered project without prompting. The explicit Codex launcher also falls back to it when the current directory is outside registered projects. Additional JSON keys are preserved for future settings.

```powershell
pnpm pulsectl settings list
pnpm pulsectl settings set default-project <project-name>
pnpm pulsectl settings set default-project none
pnpm pulsectl settings set auto-start-on-boot true
pnpm pulsectl settings set auto-start-on-boot false
```

Changing `auto-start-on-boot` installs or removes the same user-level startup integration managed by `pulsectl service`. The service install and uninstall commands keep the stored preference synchronized.

## Shared Codex Sessions

After building, install the Codex shell integration once:

```powershell
pnpm pulsectl shell install
```

Open a new terminal, start the daemon, and run `codex` normally from a registered project. The shim adds Codex's `--remote` option for interactive and saved-session commands, while passing maintenance and non-interactive commands through unchanged. On Windows, installation also updates the current user's all-hosts PowerShell profiles so the PulseCortex wrapper takes precedence over Codex shims installed on the machine PATH. If the daemon is unavailable, the shim visibly warns before falling back to standalone Codex. Remove the integration and its marked PowerShell profile blocks with `pnpm pulsectl shell uninstall`.

The explicit `pnpm pulsectl codex` launcher remains available. An explicitly supplied project name wins; when it is omitted, the remembered default project wins, and the current directory is used only when no default has been saved. PulseCortex rescans the shared app-server every two seconds for loaded threads whose canonical working directory is at or below a registered project root. It automatically rejoins loaded idle and active threads, then verifies that its connection can send direct input. It also reads Codex's live thread-writer locks so a standalone process reported by the app-server as `notLoaded` is still recognized as running. A sole newly discovered controllable thread becomes the default and produces a Feishu notification; multiple new threads produce a selection prompt. `/sessions` displays three sessions per page with 100-word previews and Previous or Show more navigation. Selecting a session makes `/send <message>` target it by default; with no selected session, the command creates a new session and sends the message as its first task. `/send <session-id> <message>` remains the explicit form. Choosing a project normally adopts its newest controllable session, while choosing a project for an unaddressed `/send` creates the requested new session. A thread active in a separate app-server runtime triggers a one-time Feishu warning and is not announced as controllable.

## Diagnostics

```powershell
pnpm pulsectl diagnose
pnpm pulsectl project list
pnpm pulsectl project remove <project-name>
pnpm pulsectl db sessions --limit 20
pnpm pulsectl db delivery_queue --limit 20
```

Diagnostics verifies the pinned Codex version, shared app-server health, SQLite integrity, owner/chat binding, credential presence without displaying values, registered directory existence, and queued delivery count.

`pnpm start` displays daemon events as readable timestamped entries with structured fields on indented lines. In an interactive terminal, updates to the same Feishu card replace its previous entry by message ID. The color-free `daemon.log` and redacted `daemon.jsonl` files remain append-only and record every update for audit and tooling use. When either file reaches `logMaxBytes`, startup moves it to a single `.previous` file before opening a fresh log. The daemon records Feishu connection transitions, retry state, and every successfully delivered user-visible Feishu message.

## Service Management

Build before installing. On Windows the installer prefers a scheduled task at user logon and falls back to the current user's Startup folder when Task Scheduler access is unavailable. It uses a LaunchAgent on macOS and a systemd user unit on Linux.

```powershell
pnpm build
pnpm pulsectl service generate
pnpm pulsectl service install
pnpm pulsectl service status
pnpm pulsectl service uninstall
```

The daemon runs as the logged-in user so `codex app-server` reuses that user's existing authentication. Do not run it as a system account or copy Codex credentials into the service environment.

Stopping PulseCortex with Ctrl+C, a terminal hangup, or the service manager also stops the shared Codex app-server and its entire descendant process tree. Independently launched standalone Codex processes are not part of that tree and are left running.

## Failure Semantics

- Feishu offline: Codex continues; state transitions and results queue locally; approvals wait.
- API throttle/transient error: bounded exponential retry, then durable queue.
- Codex app-server exit or malformed protocol: attached active turns fail; thread mappings remain.
- Daemon restart during work: active states become `interrupted_unknown`; it never claims completion.
- Missing project directory: diagnostics fails and new/resumed work is blocked by path validation.
- Invalid/stale/duplicate card: no effect; audit records a rejected action where attribution is available.

SQLite WAL files, command-log files, `daemon.log`, and `daemon.jsonl` are part of controller state. Stop the daemon before a manual backup and back up the entire data directory. Never edit the database while the daemon is running.
