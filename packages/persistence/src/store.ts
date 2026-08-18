import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import {
  normalizePathForComparison,
  pathsOverlap,
  type AgentSessionInfo,
  type OwnerIdentity,
  type Project,
  type SessionState,
  type StoredSession,
} from "@pulsecortex/domain";
import { migrate } from "./migrations.js";
import { hasSettingsFile, LocalSettingsFile, type LocalSettingKey, type LocalSettings } from "./settings.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseProject(row: unknown): Project {
  const value = row as { id: string; name: string; canonical_path: string; created_at: number };
  return { id: value.id, name: value.name, canonicalPath: value.canonical_path, createdAt: value.created_at };
}

function parseSession(row: unknown): StoredSession {
  const value = row as { id: string; project_id: string; title: string; created_at: number; updated_at: number; last_turn_id: string | null; state: StoredSession["state"]; bot_created: number };
  return { id: value.id, projectId: value.project_id, title: value.title, createdAt: value.created_at, updatedAt: value.updated_at, lastTurnId: value.last_turn_id, state: value.state, botCreated: value.bot_created === 1 };
}

export interface AuditInput {
  eventType: string;
  summary: string;
  actor?: OwnerIdentity;
  sessionId?: string;
  turnId?: string;
  sensitiveData?: string;
}

export interface InteractionRecord {
  nonce: string;
  kind: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  expiresAt: number;
  payload: Record<string, unknown>;
}

export class ControllerStore {
  readonly database: Database.Database;
  private readonly localSettings: LocalSettingsFile;

  constructor(databasePath: string, settingsPath?: string) {
    const settingsAlreadyExisted = settingsPath ? hasSettingsFile(settingsPath) : true;
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    migrate(this.database);
    this.localSettings = new LocalSettingsFile(settingsPath);
    if (settingsPath && !settingsAlreadyExisted) this.migrateLegacySettings();
  }

  close(): void { this.database.close(); }

  integrityCheck(): string[] {
    return (this.database.pragma("integrity_check") as Array<Record<string, unknown>>).map((row) => String(row["integrity_check"]));
  }

  getOwner(): (OwnerIdentity & { pairedAt: number; chatId: string }) | null {
    const row = this.database.prepare("SELECT tenant_id, user_id, paired_at, chat_id FROM owner_binding WHERE singleton = 1").get() as { tenant_id: string; user_id: string; paired_at: number; chat_id: string } | undefined;
    return row ? { tenantId: row.tenant_id, userId: row.user_id, pairedAt: row.paired_at, chatId: row.chat_id } : null;
  }

  createPairingCode(ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
    if (this.getOwner()) throw new Error("An owner is already paired");
    const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
    const expiresAt = Date.now() + ttlMs;
    this.database.prepare("DELETE FROM pairing_codes").run();
    this.database.prepare("INSERT INTO pairing_codes(code_hash, expires_at) VALUES (?, ?)").run(sha256(code), expiresAt);
    this.audit({ eventType: "pairing.code_created", summary: `Pairing code created; expires ${new Date(expiresAt).toISOString()}` });
    return { code, expiresAt };
  }

  consumePairingCode(code: string, actor: OwnerIdentity): boolean {
    const digest = sha256(code);
    const row = this.database.prepare("SELECT code_hash, expires_at, consumed_at, attempts FROM pairing_codes WHERE code_hash = ?").get(digest) as { code_hash: string; expires_at: number; consumed_at: number | null; attempts: number } | undefined;
    const comparable = Buffer.from(row?.code_hash ?? "0".repeat(64), "hex");
    const supplied = Buffer.from(digest, "hex");
    const validHash = comparable.length === supplied.length && timingSafeEqual(comparable, supplied);
    if (!row || !validHash || row.consumed_at !== null || row.expires_at < Date.now() || row.attempts >= 5 || this.getOwner()) {
      this.database.prepare("UPDATE pairing_codes SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= 5 THEN ? ELSE consumed_at END WHERE consumed_at IS NULL AND expires_at >= ?").run(Date.now(), Date.now());
      return false;
    }
    const bind = this.database.transaction(() => {
      const consumed = this.database.prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at >= ?").run(Date.now(), digest, Date.now());
      if (consumed.changes !== 1) return false;
      this.database.prepare("INSERT INTO owner_binding(singleton, tenant_id, user_id, paired_at) VALUES (1, ?, ?, ?)").run(actor.tenantId, actor.userId, Date.now());
      return true;
    });
    const success = bind();
    if (success) this.audit({ eventType: "owner.paired", summary: "Feishu owner paired", actor });
    return success;
  }

  isOwner(actor: OwnerIdentity): boolean {
    const owner = this.getOwner();
    return !!owner && owner.tenantId === actor.tenantId && owner.userId === actor.userId;
  }

  setOwnerChat(actor: OwnerIdentity, chatId: string): boolean {
    return this.database.prepare("UPDATE owner_binding SET chat_id = ? WHERE singleton = 1 AND tenant_id = ? AND user_id = ?").run(chatId, actor.tenantId, actor.userId).changes === 1;
  }

  addProject(name: string, canonicalPath: string): Project {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) throw new Error("Project name must use 1-64 letters, numbers, dots, underscores, or hyphens");
    const existing = this.listProjects();
    const conflict = existing.find((project) => pathsOverlap(project.canonicalPath, canonicalPath));
    if (conflict) throw new Error(`Project path overlaps registered project '${conflict.name}'`);
    const project: Project = { id: randomUUID(), name, canonicalPath: path.resolve(canonicalPath), createdAt: Date.now() };
    this.database.prepare("INSERT INTO projects(id, name, canonical_path, path_key, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.canonicalPath, normalizePathForComparison(project.canonicalPath), project.createdAt);
    this.audit({ eventType: "project.added", summary: `Project ${project.name} registered at ${project.canonicalPath}` });
    return project;
  }

  removeProject(name: string): boolean {
    const remove = this.database.transaction(() => {
      const project = this.getProject(name);
      if (!project) return false;
      const wasDefault = this.getLocalSettings().defaultProject?.toLocaleLowerCase() === project.name.toLocaleLowerCase();
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      if (result.changes && wasDefault) this.setLocalSetting("defaultProject", null);
      return result.changes === 1;
    });
    const removed = remove();
    if (removed) this.audit({ eventType: "project.removed", summary: `Project ${name} removed` });
    return removed;
  }

  listProjects(): Project[] { return this.database.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all().map(parseProject); }
  getProject(nameOrId: string): Project | null {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1").get(nameOrId, nameOrId);
    return row ? parseProject(row) : null;
  }

  getLocalSettings(): LocalSettings {
    const settings = this.localSettings.get();
    if (settings.defaultProject && !this.getProject(settings.defaultProject)) settings.defaultProject = null;
    return settings;
  }

  setLocalSetting<K extends LocalSettingKey>(key: K, value: LocalSettings[K]): void {
    if (key === "defaultProject" && value !== null && (typeof value !== "string" || !this.getProject(value))) throw new Error("The default project is not registered");
    if (key === "autoStartOnBoot" && typeof value !== "boolean") throw new Error("Auto-start must be a boolean");
    if (this.localSettings.get()[key] === value) return;
    this.localSettings.set(key, value);
    this.audit({ eventType: "setting.updated", summary: `${key} updated` });
  }

  private migrateLegacySettings(): void {
    const rows = this.database.prepare("SELECT key, value_json FROM local_settings").all() as Array<{ key: string; value_json: string }>;
    for (const row of rows) {
      if (row.key !== "lastProjectId" && row.key !== "defaultProject" && row.key !== "autoStartOnBoot") continue;
      let value: unknown;
      try { value = JSON.parse(row.value_json) as unknown; } catch { continue; }
      if (row.key === "lastProjectId" && (value === null || typeof value === "string")) {
        const project = value ? this.getProject(value) : null;
        this.localSettings.set("defaultProject", project?.name ?? null);
      }
      if (row.key === "defaultProject" && (value === null || typeof value === "string")) this.localSettings.set(row.key, value);
      if (row.key === "autoStartOnBoot" && typeof value === "boolean") this.localSettings.set(row.key, value);
    }
  }

  createSession(input: { id: string; projectId: string; title: string }): StoredSession {
    const now = Date.now();
    this.database.prepare("INSERT INTO sessions(id, project_id, title, created_at, updated_at, state, bot_created) VALUES (?, ?, ?, ?, ?, 'idle', 1)")
      .run(input.id, input.projectId, input.title, now, now);
    this.audit({ eventType: "session.created", summary: input.title, sessionId: input.id });
    return this.getSession(input.id)!;
  }

  getSession(id: string): StoredSession | null { const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id); return row ? parseSession(row) : null; }
  listSessions(limit = 20): StoredSession[] { return this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit).map(parseSession); }

  upsertDiscoveredSession(input: AgentSessionInfo): StoredSession {
    this.database.prepare(`INSERT INTO sessions(id, project_id, title, created_at, updated_at, last_turn_id, state, bot_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, updated_at=excluded.updated_at,
        last_turn_id=COALESCE(excluded.last_turn_id, sessions.last_turn_id), state=excluded.state`)
      .run(input.id, input.projectId, input.title, input.createdAt, input.updatedAt, input.activeTurnId ?? null, input.state, input.botCreated ? 1 : 0);
    return this.getSession(input.id)!;
  }

  attachTurn(input: { id: string; sessionId: string; state: SessionState; startedAt: number }): void {
    this.database.prepare(`INSERT OR IGNORE INTO turns(id, session_id, state, prompt_hash, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.sessionId, input.state, sha256(""), input.startedAt, Date.now());
    this.database.prepare("UPDATE sessions SET last_turn_id=?, state=?, updated_at=? WHERE id=?").run(input.id, input.state, Date.now(), input.sessionId);
  }

  updateSessionState(id: string, state: SessionState, turnId?: string): void {
    const now = Date.now();
    this.database.prepare("UPDATE sessions SET state = ?, last_turn_id = COALESCE(?, last_turn_id), updated_at = ? WHERE id = ?").run(state, turnId ?? null, now, id);
  }

  createTurn(input: { id: string; sessionId: string; prompt: string }): void {
    const now = Date.now();
    const create = this.database.transaction(() => {
      this.database.prepare("INSERT INTO turns(id, session_id, state, prompt_hash, started_at, updated_at) VALUES (?, ?, 'starting', ?, ?, ?)").run(input.id, input.sessionId, sha256(input.prompt), now, now);
      this.database.prepare("UPDATE sessions SET last_turn_id = ?, state = 'starting', updated_at = ? WHERE id = ?").run(input.id, now, input.sessionId);
    });
    create();
    this.audit({ eventType: "turn.started", summary: "Remote turn started", sessionId: input.sessionId, turnId: input.id, sensitiveData: input.prompt });
  }

  updateTurn(id: string, input: { state?: SessionState; safeSummary?: string; diff?: string; changedFileCount?: number; testSummary?: string; completed?: boolean }): void {
    const current = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`Unknown turn ${id}`);
    const state = input.state ?? String(current["state"]);
    const completedAt = input.completed ? Date.now() : current["completed_at"];
    this.database.prepare("UPDATE turns SET state=?, safe_summary=?, diff_text=?, changed_file_count=?, test_summary=?, updated_at=?, completed_at=? WHERE id=?")
      .run(state, input.safeSummary ?? current["safe_summary"], input.diff ?? current["diff_text"], input.changedFileCount ?? current["changed_file_count"], input.testSummary ?? current["test_summary"], Date.now(), completedAt, id);
    this.database.prepare("UPDATE sessions SET state=?, updated_at=? WHERE id=?").run(state, Date.now(), current["session_id"]);
  }

  getTurn(id: string): Record<string, unknown> | null { return this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Record<string, unknown> | undefined ?? null; }

  markActiveTurnsInterrupted(): number {
    const active = ["starting", "working", "awaiting_approval", "awaiting_input", "stopping"];
    const placeholders = active.map(() => "?").join(",");
    return this.database.transaction(() => {
      const turns = this.database.prepare(`UPDATE turns SET state='interrupted_unknown', updated_at=?, completed_at=? WHERE state IN (${placeholders})`).run(Date.now(), Date.now(), ...active);
      this.database.prepare(`UPDATE sessions SET state='interrupted_unknown', updated_at=? WHERE state IN (${placeholders})`).run(Date.now(), ...active);
      return turns.changes;
    })();
  }

  claimEvent(eventId: string): boolean {
    return this.database.prepare("INSERT INTO processed_events(event_id, processed_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING").run(eventId, Date.now()).changes === 1;
  }

  createInteraction(record: InteractionRecord): void {
    this.database.prepare(`INSERT INTO pending_interactions(nonce, kind, tenant_id, user_id, session_id, turn_id, request_id, expires_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.nonce, record.kind, record.tenantId, record.userId, record.sessionId, record.turnId, record.requestId, record.expiresAt, JSON.stringify(record.payload));
  }

  consumeInteraction(nonce: string, actor: OwnerIdentity, now = Date.now(), allowExpired = false): InteractionRecord | null {
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM pending_interactions WHERE nonce = ?").get(nonce) as Record<string, unknown> | undefined;
      if (!row || row["consumed_at"] !== null || (!allowExpired && Number(row["expires_at"]) < now) || row["tenant_id"] !== actor.tenantId || row["user_id"] !== actor.userId) return null;
      const consumed = this.database.prepare("UPDATE pending_interactions SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL").run(now, nonce);
      if (consumed.changes !== 1) return null;
      return {
        nonce: String(row["nonce"]), kind: String(row["kind"]), tenantId: String(row["tenant_id"]), userId: String(row["user_id"]),
        sessionId: String(row["session_id"]), turnId: String(row["turn_id"]), requestId: String(row["request_id"]), expiresAt: Number(row["expires_at"]),
        payload: JSON.parse(String(row["payload_json"])) as Record<string, unknown>,
      };
    })();
  }

  addMilestone(sessionId: string, turnId: string, eventType: string, payload: unknown): void {
    this.database.prepare("INSERT INTO milestones(session_id, turn_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, turnId, eventType, JSON.stringify(payload), Date.now());
  }

  enqueueDelivery(kind: string, payload: unknown, nextAttemptAt = Date.now(), dedupeKey?: string): string {
    if (dedupeKey) {
      const existing = this.database.prepare("SELECT id FROM delivery_queue WHERE dedupe_key = ? AND delivered_at IS NULL").get(dedupeKey) as { id: string } | undefined;
      if (existing) {
        this.database.prepare("UPDATE delivery_queue SET kind=?, payload_json=?, attempts=0, next_attempt_at=?, last_error=NULL, created_at=? WHERE id=?")
          .run(kind, JSON.stringify(payload), nextAttemptAt, Date.now(), existing.id);
        return existing.id;
      }
    }
    const id = randomUUID();
    this.database.prepare("INSERT INTO delivery_queue(id, kind, payload_json, next_attempt_at, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, JSON.stringify(payload), nextAttemptAt, Date.now(), dedupeKey ?? null);
    return id;
  }

  pendingDeliveries(limit = 20): Array<{ id: string; kind: string; payload: unknown; attempts: number }> {
    return (this.database.prepare("SELECT * FROM delivery_queue WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY created_at LIMIT ?").all(Date.now(), limit) as Array<Record<string, unknown>>)
      .map((row) => ({ id: String(row["id"]), kind: String(row["kind"]), payload: JSON.parse(String(row["payload_json"])), attempts: Number(row["attempts"]) }));
  }

  completeDelivery(id: string): void { this.database.prepare("UPDATE delivery_queue SET delivered_at = ?, last_error = NULL WHERE id = ?").run(Date.now(), id); }
  failDelivery(id: string, error: string, nextAttemptAt: number): void { this.database.prepare("UPDATE delivery_queue SET attempts=attempts+1, last_error=?, next_attempt_at=? WHERE id=?").run(error.slice(0, 500), nextAttemptAt, id); }
  queuedDeliveryCount(): number { return Number((this.database.prepare("SELECT COUNT(*) AS count FROM delivery_queue WHERE delivered_at IS NULL").get() as { count: number }).count); }

  audit(input: AuditInput): void {
    this.database.prepare(`INSERT INTO audit_log(event_type, tenant_id, user_id, session_id, turn_id, summary, data_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.eventType, input.actor?.tenantId ?? null, input.actor?.userId ?? null, input.sessionId ?? null, input.turnId ?? null, input.summary.slice(0, 500), input.sensitiveData ? sha256(input.sensitiveData) : null, Date.now());
  }

  inspectAudit(limit = 50): Record<string, unknown>[] { return this.database.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]; }
  inspectTable(table: "projects" | "sessions" | "turns" | "pending_interactions" | "delivery_queue" | "audit_log" | "local_settings", limit = 50): Record<string, unknown>[] {
    if (table === "local_settings") return this.localSettings.entries().slice(0, limit).map(({ key, value }) => ({ key, value_json: JSON.stringify(value) }));
    return this.database.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  }

  applyRetention(metadataDays: number): { audit: number; events: number; milestones: number; sessions: number } {
    const cutoff = Date.now() - metadataDays * 86_400_000;
    return this.database.transaction(() => {
      const audit = this.database.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes;
      const events = this.database.prepare("DELETE FROM processed_events WHERE processed_at < ?").run(cutoff).changes;
      const milestones = this.database.prepare("DELETE FROM milestones WHERE created_at < ?").run(cutoff).changes;
      this.database.prepare("DELETE FROM pending_interactions WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)").run(Date.now(), cutoff);
      this.database.prepare("DELETE FROM delivery_queue WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(cutoff);
      const sessions = this.database.prepare("DELETE FROM sessions WHERE updated_at < ? AND state NOT IN ('starting','working','awaiting_approval','awaiting_input','stopping')").run(cutoff).changes;
      return { audit, events, milestones, sessions };
    })();
  }
}
