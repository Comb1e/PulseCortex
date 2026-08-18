# Architecture

```text
Feishu mobile app
        |
outbound event/card WebSocket
        |
Feishu MessagingAdapter
        |
owner auth + coordinator + SQLite event store
        |
Codex AgentDriver (loopback WebSocket)
        |
shared `codex app-server --listen`
        |
locally allowlisted project directory
```

The domain package owns channel-neutral and Codex-neutral contracts. The Feishu adapter converts direct messages and JSON 2.0 callback cards into `ChannelCommand` and `ChannelAction`. The Codex driver converts app-server methods, notifications, and server requests into normalized `AgentEvent` values. Adapter-specific payloads do not enter coordinator behavior.

## Lifecycle

Only the local CLI registers canonical project paths. It rejects missing directories, duplicates, and parent/child overlaps. A new session starts with that canonical directory as `cwd`, its sole runtime workspace root, workspace-write sandboxing, and network disabled.

The coordinator tracks active turns by session, so independent sessions and registered projects can run concurrently. Each turn keeps its own mutable status card, updated every two seconds at most for streaming deltas and immediately for state transitions. Command output is appended to per-turn JSONL files; SQLite receives hashes, summaries, current diff/state, milestones, delivery work, and audit events.

The daemon owns a loopback-only Codex app-server. The optional shell integration routes ordinary interactive `codex` invocations to that server; `pulsectl codex` remains an explicit fallback. Every two seconds PulseCortex queries the server's loaded-thread inventory so a TUI and Feishu can control the same live thread. It rejoins loaded threads that have not granted its connection direct input, then verifies that capability before announcing or defaulting them. It combines the inventory with Codex's live thread-writer locks, which distinguish a running standalone thread from an old `notLoaded` history entry. It resolves each thread working directory and accepts only paths at or below a canonical registered project root. A sole newly discovered session is selected and announced, while ambiguous discoveries require `/sessions`; choosing a project selects its newest controllable session. The selected session receives `/send <message>` by default; without a selected session, `/send` creates one and uses the message as its first task. A running thread owned by another app-server process produces a one-time Feishu warning and remains uncontrollable because Codex's single-writer lock rejects a cross-runtime resume.

Approvals are app-server server requests. Each card action is HMAC-signed and bound to tenant, owner, session, turn, request, expiry, action kind, and a random nonce. The database consumes the nonce transactionally before any effect. Command cards can return Codex's session-wide auto-approve decision; all other approval kinds remain one-time only. Destination-less broad network grants and filesystem/write roots outside the registered project are rejected locally.

## Recovery

Feishu disconnection does not stop Codex. Failed milestone/result deliveries enter a SQLite queue with exponential backoff and jitter. Approval requests remain pending in the app-server unless the owner previously enabled command auto approve for that Codex session.

An app-server crash fails every attached active turn and preserves the thread mappings. A daemon restart cannot truthfully claim its previous shared runtime continued, so startup transactionally marks active rows `interrupted_unknown`. Stored session IDs can later be resumed against the same local Codex history.

## Persistence

SQLite uses WAL mode, foreign keys, and migrations. Tables cover owner binding, pairing codes, projects, sessions, turns, interactions, event deduplication, deliveries, milestones, and append-only audits. User-editable preferences live in `settings.json` beside the database; the JSON object retains the default project, OS startup preference, and future settings. Sensitive prompt content is hashed for audit; command output stays in bounded files.

Metadata retention defaults to 30 days. Command logs retain at most seven days and 100 MB in total, deleting oldest files first. The human-readable and structured daemon logs each rotate at the same configured byte ceiling during startup and keep one `.previous` file. The daemon applies command-log retention at startup and daily.
