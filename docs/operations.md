# Operations

## Configuration

Non-secret settings live in `config.json` below the platform data directory:

- Windows: `%LOCALAPPDATA%\PulseCortex`
- macOS: `~/Library/Application Support/PulseCortex`
- Linux: `$XDG_STATE_HOME/pulsecortex` or `~/.local/state/pulsecortex`

`PULSECORTEX_DATA_DIR` overrides the directory. `PULSECORTEX_ENV_FILE` overrides the secret-file path.

Supported settings include status/approval intervals, metadata/log retention, log byte ceiling, Feishu or Lark domain, log level, JavaScript regular expressions for additional redaction, `codexPermissionProfile`, `codexExecutable`, and `codexAppServerUrl`. `codexPermissionProfile` defaults to `:workspace`; `:danger-full-access` is rejected for remotely controlled sessions. `codexExecutable` pins the Codex executable when a supervised service has a different PATH from the interactive terminal. `codexAppServerUrl` defaults to `ws://127.0.0.1:4500` on Windows and macOS and `ws://127.0.0.1:4501` on Linux, including WSL. It must remain a loopback `ws://` URL with an explicit port. Existing `config.json` files retain their explicit values; change the Linux/WSL URL to port `4501` manually when upgrading an initialized installation.

Example Windows overrides:

```json
{
  "codexPermissionProfile": ":workspace",
  "codexExecutable": "C:\\Users\\your-user\\AppData\\Roaming\\npm\\codex.cmd"
}
```

Managed sessions receive this named permission profile on creation and later turns. Shared sessions launched independently through the TUI keep their existing permission, approval, workspace-root, and tool settings when PulseCortex attaches; a remote turn does not silently replace them.

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

The explicit `pnpm pulsectl codex` launcher remains available. An explicitly supplied project name wins; when it is omitted, the remembered default project wins, and the current directory is used only when no default has been saved. PulseCortex announces its startup in Feishu, then rescans the shared app-server every two seconds for loaded threads whose canonical working directory is at or below a registered project root. It automatically rejoins loaded idle and active threads, then verifies that its connection can send direct input. It also reads Codex's live thread-writer locks so a standalone process reported by the app-server as `notLoaded` is still recognized as running. A sole newly discovered controllable thread becomes the default and produces a Feishu notification; multiple new threads produce a selection prompt. Sessions running in a separate app-server runtime remain uncontrollable without producing automatic Feishu notifications. `/sessions` displays three sessions per page with 100-word previews and Previous or Show more navigation. Selecting a session makes `/send <message>` target it by default; with no selected session, the command creates a new session and sends the message as its first task. `/send <session-id> <message>` remains the explicit form. `/instructions` lists the built-in instruction presets reported by Codex and applies the card selection to subsequent turns in the selected session. When no session is selected, it first creates one in the remembered or sole project; `/instruction` is accepted as an alias. Choosing a project normally adopts its newest controllable session, while choosing a project for an unaddressed `/send` creates the requested new session.

## Diagnostics

```powershell
pnpm pulsectl diagnose
pnpm pulsectl project list
pnpm pulsectl project remove <project-name>
pnpm pulsectl db sessions --limit 20
pnpm pulsectl db delivery_queue --limit 20
```

Diagnostics verifies the configured Codex executable and pinned version, configured managed permission profile, Codex home and temporary directory, shared app-server health, SQLite integrity, owner/chat binding, credential presence without displaying values, registered directory existence, and queued delivery count. The daemon log also records the permission profile Codex reports as active for each managed session.

`pnpm start` displays daemon events as readable timestamped entries with structured fields on indented lines. In an interactive terminal, mutable Feishu card entries are width-wrapped and replaced by message ID. When an ID repeats, the terminal erases its previous entry and all later entries, replays those later entries in order, and appends the replacement so only the latest entry for that message remains displayed. The color-free, redacted `logs/YYYY-MM-DD/HH-NNNN.log` chunks remain append-only and record every complete update for the local calendar day. Chunks are split by local hour and before a record would exceed 10 MiB; records are never split, and an oversized record gets a chunk of its own. A restart continues the latest non-full chunk for the current hour. The daemon creates a new date folder at midnight without requiring a restart. Daily log retention observes `logRetentionDays` and shares the `logMaxBytes` budget across complete date folders; the active day's folder is always retained. Existing flat `YYYY-MM-DD.log` files and unrelated entries are left alone. The daemon records Feishu connection transitions, Codex app-server warnings and stderr, execution-environment connection changes, retry state, and every successfully delivered user-visible Feishu message.

When a Codex session reports that terminal or tool calls are unavailable, inspect the current daily log. Startup records whether the configured model provider reports namespace-tool support. An `execution environment disconnected` entry means the local Code Mode tool host is unavailable; PulseCortex blocks new turns until Codex reports it ready and fails an active turn instead of letting it continue without tools. If Codex rejects function arguments, PulseCortex interrupts the affected turn rather than allowing an unbounded retry loop and reports that the provider may not preserve namespace schemas. PulseCortex-managed sessions disable multi-agent namespace tools while retaining normal shell, patch, MCP, and other single-agent tools. A custom Responses API proxy must still preserve custom tool definitions and tool-call items; PulseCortex cannot reconstruct schemas removed by an upstream provider.

## Service Management

Build before installing. On Windows the installer prefers a scheduled task at user logon and falls back to the current user's Startup folder when Task Scheduler access is unavailable. It uses a LaunchAgent on macOS and a systemd user unit on Linux.

```powershell
pnpm build
pnpm pulsectl service generate
pnpm pulsectl service install
pnpm pulsectl service status
pnpm pulsectl service uninstall
```

The daemon runs as the logged-in user so `codex app-server` reuses that user's existing authentication. A Windows scheduled task intentionally uses a limited user token, and service managers do not inherit later terminal PATH or environment changes. This can make service-launched Codex less capable than an elevated or differently configured terminal even in the same directory. Pin `codexExecutable`, compare `pulsectl diagnose` output, and grant only the operating-system rights actually required. Do not run the daemon as a system account or copy Codex credentials into the service environment.

The app-server inherits the daemon's ordinary user environment after PulseCortex removes all `FEISHU_*`, `LARK_*`, and `PULSECORTEX_*` variables. Put only controller secrets in `pulsecortex.env`; use normal user or service-manager configuration for non-secret variables that Codex genuinely requires.

Stopping PulseCortex with Ctrl+C, a terminal hangup, or the service manager also stops the shared Codex app-server and its entire descendant process tree. Independently launched standalone Codex processes are not part of that tree and are left running.

## Failure Semantics

- Feishu offline: Codex continues; state transitions and results queue locally; approvals wait.
- API throttle/transient error: bounded exponential retry, then durable queue.
- Codex app-server exit or malformed protocol: attached active turns fail; thread mappings remain.
- Codex execution-environment disconnect: attached work is interrupted and failed; new turns remain blocked until the environment reports ready.
- Unsupported MCP elicitation or an unregistered dynamic tool: the request receives an explicit fail-closed protocol response and the reason is logged.
- Daemon restart during work: active states become `interrupted_unknown`; it never claims completion.
- Missing project directory: diagnostics fails and new/resumed work is blocked by path validation.
- Invalid/stale/duplicate card: no effect; audit records a rejected action where attribution is available.

SQLite WAL files, command-log files, and the `logs` directory are part of controller state. Stop the daemon before a manual backup and back up the entire data directory. Never edit the database while the daemon is running.
