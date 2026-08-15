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
Codex AgentDriver (JSONL stdio)
        |
locally allowlisted project directory
```

The domain package owns channel-neutral and Codex-neutral contracts. The Feishu adapter converts direct messages and JSON 2.0 callback cards into `ChannelCommand` and `ChannelAction`. The Codex driver converts app-server methods, notifications, and server requests into normalized `AgentEvent` values. Adapter-specific payloads do not enter coordinator behavior.

## Lifecycle

Only the local CLI registers canonical project paths. It rejects missing directories, duplicates, and parent/child overlaps. A new session starts with that canonical directory as `cwd`, its sole runtime workspace root, workspace-write sandboxing, and network disabled.

The coordinator permits one active turn across the daemon. It keeps one mutable status card, updates it every two seconds at most for streaming deltas, and updates immediately for state transitions. Command output is appended to per-turn JSONL files; SQLite receives hashes, summaries, current diff/state, milestones, delivery work, and audit events.

Approvals are app-server server requests. Each card action is HMAC-signed and bound to tenant, owner, session, turn, request, expiry, action kind, and a random nonce. The database consumes the nonce transactionally before any effect. Only one-time approval scope is returned. Destination-less broad network grants and filesystem/write roots outside the registered project are rejected locally.

## Recovery

Feishu disconnection does not stop Codex. Failed milestone/result deliveries enter a SQLite queue with exponential backoff and jitter. Approval requests remain pending in the app-server and are never auto-approved.

An app-server crash fails the active turn and preserves the bot-created thread mapping. A daemon restart cannot truthfully claim its previous in-memory stdio process continued, so startup transactionally marks active rows `interrupted_unknown`. Stored session IDs can later be resumed against the same local Codex history.

## Persistence

SQLite uses WAL mode, foreign keys, and migrations. Tables cover owner binding, pairing codes, projects, sessions, turns, interactions, event deduplication, deliveries, milestones, and append-only audits. Sensitive prompt content is hashed for audit; command output stays in bounded files.

Metadata retention defaults to 30 days. Command logs retain at most seven days and 100 MB, deleting oldest files first. The daemon applies retention at startup and daily.
