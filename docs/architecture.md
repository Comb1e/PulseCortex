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

The domain package owns channel-neutral and Codex-neutral contracts. The Feishu adapter converts direct messages and JSON 2.0 callback cards into `ChannelCommand` and `ChannelAction`. The Codex driver converts app-server methods, notifications, and server requests into normalized `AgentEvent` values. Adapter-specific payloads do not enter coordinator behavior. Driver startup also reads the model provider capability contract. PulseCortex-created and resumed sessions use paginated history and disable multi-agent namespace tools, avoiding providers that claim namespace support but do not preserve those structured arguments; independently created TUI sessions retain their own configuration.

## Lifecycle

Only the local CLI registers canonical project paths. It rejects missing directories, duplicates, and parent/child overlaps. A new session starts with that canonical directory as `cwd`, its sole runtime workspace root, workspace-write sandboxing, and network disabled.

The coordinator tracks active turns by session, so independent sessions and registered projects can run concurrently. Each turn keeps its own mutable status card, updated every two seconds at most for streaming deltas and immediately for state transitions. Command output is appended to per-turn JSONL files; SQLite receives hashes, summaries, current diff/state, milestones, delivery work, and audit events.

The daemon owns a loopback-only Codex app-server. The optional shell integration routes ordinary interactive `codex` invocations to that server; `pulsectl codex` remains an explicit fallback. After Feishu connects, PulseCortex announces that it has started, then every two seconds queries the server's loaded-thread inventory so a TUI and Feishu can control the same live thread. It rejoins loaded threads that have not granted its connection direct input, then verifies that capability before announcing or defaulting them. It combines the inventory with Codex's live thread-writer locks, which distinguish a running standalone thread from an old `notLoaded` history entry. It resolves each thread working directory and accepts only paths at or below a canonical registered project root, while preserving the thread's subdirectory as the working directory for later turns. A sole newly discovered session is selected and announced, while ambiguous discoveries require `/sessions`; choosing a project selects its newest controllable session. The selected session receives `/send <message>` by default; without a selected session, `/send` creates one and uses the message as its first task. A running thread owned by another app-server process remains uncontrollable because Codex's single-writer lock rejects a cross-runtime resume, but discovery does not generate an automatic Feishu notification.

Approvals are app-server server requests. Each card action is HMAC-signed and bound to tenant, owner, session, turn, request, expiry, action kind, and a random nonce. The database consumes the nonce transactionally before any effect. Command cards can return Codex's session-wide auto-approve decision; all other approval kinds remain one-time only. Destination-less broad network grants and filesystem/write roots outside the registered project are rejected locally. When app-server resolves a request independently, the driver removes its pending state and the coordinator cancels the corresponding card. Current-time host requests are answered locally; MCP elicitation and dynamic tools not registered by PulseCortex receive explicit fail-closed responses.

## Recovery

Feishu disconnection does not stop Codex. Failed milestone/result deliveries enter a SQLite queue with exponential backoff and jitter. Approval requests remain pending in the app-server unless the owner previously enabled command auto approve for that Codex session.

An app-server crash fails every attached active turn and preserves the thread mappings. An execution-environment disconnect interrupts and fails its active turn, and blocks another turn until the environment is ready. PulseCortex-created sessions opt into raw response-item notifications so a rejected function-call payload can be correlated to its thread and interrupted immediately. A narrowly scoped stderr fallback does the same when exactly one legacy turn is active. A daemon restart cannot truthfully claim its previous shared runtime continued, so startup transactionally marks active rows `interrupted_unknown`. Stored session IDs can later be resumed against the same local Codex history.

## Persistence

SQLite uses WAL mode, foreign keys, and migrations. Tables cover owner binding, pairing codes, projects, sessions, turns, interactions, event deduplication, deliveries, milestones, and append-only audits. User-editable preferences live in `settings.json` beside the database; the JSON object retains the default project, OS startup preference, and future settings. Sensitive prompt content is hashed for audit; command output stays in bounded files.

Metadata retention defaults to 30 days. Command logs retain at most seven days and 100 MB in total, deleting oldest files first. Readable daemon events are stored in one `logs/YYYY-MM-DD.log` file per local calendar day. Daily logs use the same retention age and directory byte ceiling, while always preserving the active day's file. The daemon applies both log retention policies at startup and daily.
