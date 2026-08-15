# Security Model

PulseCortex is remote code execution mediated by Codex. Treat the Feishu account, application credentials, workstation account, Codex account, and registered source trees as one security boundary.

## Enforced Controls

- The daemon opens no inbound listener. Feishu events and callbacks arrive over official SDK outbound WebSockets; Codex uses local stdio.
- Only a paired tenant and owner `open_id` can submit commands or consume actions. Group messages are rejected.
- Feishu cannot register a path. Canonical projects are added locally and nested/duplicate roots are rejected.
- Only bot-created session mappings are resumable remotely.
- One active turn prevents cross-turn approval confusion.
- Actions are signed, owner/session/turn/request-bound, expiring, and transactionally single-use.
- Approval cards expose Allow once, Deny, and Stop only. Session-wide approval is never returned.
- Network cards use app-server destination host/protocol. Broad network grants without a destination are denied.
- Secret-input questions are denied and interrupt the turn instead of asking for credentials over Feishu.
- ANSI/control characters are removed; common and configured credential patterns are redacted; mobile payloads are bounded.
- App credentials and the action signing key load only from process environment or a restricted local environment file. They are not command arguments, repository config, SQLite values, cards, or logs.
- Audit rows record pairing, prompts by hash, sessions, approvals, stops, failures, and delivery outcomes.

## Residual Risk

Redaction cannot identify every secret. Source code, a diff, a prompt, or a tool result may contain sensitive data in an unfamiliar format. A malicious repository can influence the agent, although it cannot bypass the controller's owner and action-token checks. Feishu tenant retention, administrators, endpoint backups, and mobile notifications may retain transmitted data outside this project.

Use a dedicated least-privilege Feishu app and limit its availability. Register only projects suitable for remote operation. Keep operating system, Node.js, Codex CLI, and dependencies patched. Rotate the App Secret and signing key after suspected exposure; existing card actions become invalid when the signing key changes.

## Secret File Permissions

`pulsectl init` creates mode `0600` files on Unix. On Windows it removes inherited ACLs from `pulsecortex.env` and grants the current user read/write access. Review with:

```powershell
icacls "$env:LOCALAPPDATA\PulseCortex\pulsecortex.env"
```

Service artifacts contain only the environment-file path, Node path, and daemon path. They never contain credential values.

## Acceptance Tests

Automated tests cover command parsing, state transitions, canonical path containment, nested allowlist rejection, redaction/pagination, owner authorization, event deduplication, forged/replayed action rejection, Codex destination-specific approval normalization, card schema, and all platform service artifact generators.

Before a release tag, also run the developer-tenant trial in [Feishu setup](feishu-setup.md), authenticated temporary-repository Codex integration tests, restart/crash tests, and OS-supervised startup tests on physical or virtual Windows, macOS, and Linux hosts.
