# Security Model

PulseCortex is remote code execution mediated by Codex. Treat the Feishu account, application credentials, workstation account, Codex account, and registered source trees as one security boundary.

## Enforced Controls

- Feishu events and callbacks arrive over official SDK outbound WebSockets. The only inbound listener is the shared Codex app-server, validated as loopback-only with an explicit port; it is never exposed on the LAN or internet.
- Only a paired tenant and owner `open_id` can submit commands or consume actions. Group messages are rejected.
- Feishu cannot register a path. Canonical projects are added locally and nested/duplicate roots are rejected.
- Only sessions whose real working directory is at or below a locally registered canonical project root are exposed or controllable remotely.
- Concurrent turns are isolated by session, and every approval remains bound to its session, turn, request, owner, and tenant.
- Actions are signed, owner/session/turn/request-bound, expiring, and transactionally single-use. An expired approval is denied automatically at the app-server and cannot be accepted from an old card.
- Approval cards expose Allow once, Deny, and Stop. PulseCortex never grants session-wide automatic command approval. Allowing a command is a one-time escape from the Codex sandbox, so the command can use all access available to the daemon's operating-system account.
- Network cards use app-server destination host/protocol. Broad network grants without a destination are denied.
- Filesystem grants are resolved through symlinks and junctions before project containment is checked. Nonexistent targets are checked through their nearest existing ancestor.
- Secret-input questions are denied and interrupt the turn instead of asking for credentials over Feishu.
- ANSI/control characters are removed; common and configured credential patterns are redacted; mobile payloads are bounded.
- App credentials and the action signing key load only from process environment or a restricted local environment file. They are not command arguments, repository config, SQLite values, cards, or logs.
- Audit rows record pairing, prompts by hash, sessions, approvals, stops, failures, and delivery outcomes. Every successfully delivered Feishu text or card is also recorded after action-token removal in the redacted daily `logs/YYYY-MM-DD/HH-NNNN.log` chunks.

## Residual Risk

Redaction cannot identify every secret. Source code, a diff, a prompt, or a tool result may contain sensitive data in an unfamiliar format. A malicious repository can influence the agent, although it cannot bypass the controller's owner and action-token checks. A user-approved sandbox escape can still execute with the daemon account's full host permissions. Feishu tenant retention, administrators, endpoint backups, and mobile notifications may retain transmitted data outside this project.

The default Codex `:workspace` profile includes the registered workspace and system temporary directory. A custom named profile may grant more access than PulseCortex can infer from its name; treat profile definitions as privileged local configuration and do not give remotely controlled sessions broad host or network access. The built-in `:danger-full-access` profile is rejected.

The Codex app-server listener is loopback-only, but PulseCortex does not add a second client-authentication layer to that local protocol. A local process able to connect to the configured port may attempt to speak the app-server protocol. Protect the workstation account from untrusted local processes and do not expose or proxy the listener.

Use a dedicated least-privilege Feishu app and limit its availability. Register only projects suitable for remote operation. Keep operating system, Node.js, Codex CLI, and dependencies patched. Rotate the App Secret and signing key after suspected exposure; existing card actions become invalid when the signing key changes.

## Secret File Permissions

`pulsectl init` creates mode `0600` files on Unix. On Windows it removes inherited ACLs from `pulsecortex.env` and grants the current user read/write access. Review with:

```powershell
icacls "$env:LOCALAPPDATA\PulseCortex\pulsecortex.env"
```

Service artifacts contain only the environment-file path, Node path, and daemon path. They never contain credential values. The Codex child environment removes `FEISHU_*`, `LARK_*`, and `PULSECORTEX_*` variables so app-server tools do not inherit controller secrets.

## Acceptance Tests

Automated tests cover command parsing, concurrent state transitions, session discovery and pagination, canonical path containment, nested allowlist rejection, redaction, owner authorization, event deduplication, forged/replayed action rejection, Codex destination-specific approval normalization, card schema, and all platform service artifact generators.

Before a release tag, also run the developer-tenant trial in [Feishu setup](feishu-setup.md), authenticated temporary-repository Codex integration tests, restart/crash tests, and OS-supervised startup tests on physical or virtual Windows, macOS, and Linux hosts.
