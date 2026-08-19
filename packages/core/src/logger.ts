import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger, type StreamEntry } from "pino";

const LEVEL_NAMES: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
const LEVEL_COLORS: Record<string, string> = { TRACE: "\u001b[90m", DEBUG: "\u001b[36m", INFO: "\u001b[32m", WARN: "\u001b[33m", ERROR: "\u001b[31m", FATAL: "\u001b[31;1m" };
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const LOG_METADATA = new Set(["level", "time", "pid", "hostname", "service", "msg"]);
const LIVE_MESSAGE_KINDS = new Set(["status", "approval", "result"]);

interface LogTarget { write(content: string): unknown; columns?: number; rows?: number }

export interface LoggerOptions {
  output?: LogTarget;
  color?: boolean;
  liveStatus?: boolean;
  logDir?: string;
  terminalDiagnostics?: boolean;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function dateStamp(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : Date.now());
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function hourStamp(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : Date.now());
  return pad(date.getHours());
}

function timestamp(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : Date.now());
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatField(key: string, value: unknown, compact = false): string {
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else if (value === undefined) rendered = "undefined";
  else rendered = JSON.stringify(value, null, compact ? undefined : 2) ?? String(value);
  const lines = rendered.split("\n");
  if (lines.length === 1) return `  ${key}: ${lines[0]}`;
  return `  ${key}:\n${lines.map((line) => `    ${line}`).join("\n")}`;
}

export function formatLogRecord(record: Record<string, unknown>, color = false, compact = false): string {
  const level = LEVEL_NAMES[Number(record["level"])] ?? String(record["level"] ?? "LOG").toUpperCase();
  const time = timestamp(record["time"]);
  const levelText = level.padEnd(5);
  const prefix = color ? `${DIM}${time}${RESET} ${LEVEL_COLORS[level] ?? ""}${levelText}${RESET}` : `${time} ${levelText}`;
  const message = typeof record["msg"] === "string" && record["msg"] ? record["msg"] : "Log event";
  const fields = Object.entries(record).filter(([key]) => !LOG_METADATA.has(key)).map(([key, value]) => formatField(key, value, compact));
  return `${prefix} ${message}${fields.length ? `\n${fields.join("\n")}` : ""}\n`;
}

function characterWidth(character: string): number {
  return character.codePointAt(0)! <= 0x7f ? 1 : 2;
}

function wrapForTerminal(value: string, maxCells: number): { rendered: string; lines: number } {
  const wrapped = value.split("\n").flatMap((line) => {
    if (!line) return [""];
    const chunks: string[] = [];
    let chunk = "";
    let cells = 0;
    for (const character of line) {
      const width = characterWidth(character);
      if (chunk && cells + width > maxCells) {
        chunks.push(chunk);
        chunk = "";
        cells = 0;
      }
      chunk += character;
      cells += width;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }).join("\n");
  return { rendered: wrapped, lines: Math.max(1, wrapped.split("\n").length - 1) };
}

interface LiveRecord {
  rendered: string;
  lines: number;
  liveKey: string;
  messageId: string;
  fingerprint: string;
  lifecycle: "active" | "settled";
}

interface RendererTrace {
  at: number;
  transition: string;
  state: "idle" | "live-footer";
  messageId?: string;
  columns: number | null;
  rows: number | null;
  footerEntries: number;
  footerLines: number;
  clearedLines: number;
  emittedBytes: number;
  reason?: string;
}

class PrettyLogStream extends Writable {
  private buffered = "";
  private readonly liveRecords = new Map<string, LiveRecord>();
  private readonly recentFingerprints = new Map<string, string>();
  private footerColumns: number | null | undefined;

  constructor(
    private readonly target: LogTarget,
    private readonly color: boolean,
    private readonly liveStatus = false,
    private readonly terminalOutput?: DiagnosticLogWriter,
    private readonly rendererTrace?: DiagnosticLogWriter,
  ) { super(); }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffered += chunk.toString();
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line) this.writeLine(line);
      newline = this.buffered.indexOf("\n");
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.buffered) this.writeLine(this.buffered);
    callback();
  }

  private writeLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    }
    catch {
      this.writeTerminalRecord(`${line}\n`, Date.now());
      return;
    }

    const liveEvent = this.liveEvent(record);
    if (this.liveStatus && liveEvent) {
      this.writeLiveRecord(record, liveEvent);
      return;
    }
    this.writeTerminalRecord(formatLogRecord(record, this.color), this.recordTime(record));
  }

  private writeLiveRecord(record: Record<string, unknown>, event: { liveKey: string; messageId: string; lifecycle: LiveRecord["lifecycle"] }): void {
    const at = this.recordTime(record);
    const fingerprint = this.liveFingerprint(record);
    if (this.recentFingerprints.get(event.liveKey) === fingerprint) {
      this.trace(at, "duplicate-skipped", event.messageId, 0, 0, "matching-fingerprint");
      return;
    }

    if (!this.canClearFooter()) {
      const abandoned = this.liveRecords.size;
      this.liveRecords.clear();
      const rendered = this.renderLiveRecord(record);
      if (event.lifecycle === "active" && rendered.lines < this.terminalRows()) {
        this.liveRecords.set(event.liveKey, { ...event, ...rendered, fingerprint });
      }
      this.rememberFingerprint(event.liveKey, fingerprint);
      this.emitFrame(rendered.rendered, at, "footer-reset", event.messageId, 0, `footer-geometry-unreachable-with-${abandoned}-entries`);
      return;
    }

    const clearedLines = this.liveFooterLines();
    const committed = this.takeSettledExcept(event.liveKey);
    this.liveRecords.delete(event.liveKey);
    this.liveRecords.set(event.liveKey, {
      ...event,
      ...this.renderLiveRecord(record),
      fingerprint,
    });
    this.rememberFingerprint(event.liveKey, fingerprint);

    while (this.liveFooterLines() >= this.terminalRows()) {
      const oldestKey = this.liveRecords.keys().next().value as string | undefined;
      if (!oldestKey) break;
      committed.push(this.liveRecords.get(oldestKey)!.rendered);
      this.liveRecords.delete(oldestKey);
    }

    const frame = `${this.clearTerminalLines(clearedLines)}${committed.join("")}${this.renderLiveRecords()}`;
    const transition = event.lifecycle === "settled" ? "live-settled" : "live-updated";
    this.emitFrame(frame, at, transition, event.messageId, clearedLines, committed.length ? "settled-or-overflow-committed" : undefined);
  }

  private writeTerminalRecord(content: string, at: number): void {
    if (!this.liveStatus || !this.liveRecords.size) {
      this.emitFrame(content, at, "ordinary", undefined, 0);
      return;
    }

    if (!this.canClearFooter()) {
      const abandoned = this.liveRecords.size;
      this.liveRecords.clear();
      this.emitFrame(content, at, "footer-reset", undefined, 0, `footer-geometry-unreachable-with-${abandoned}-entries`);
      return;
    }

    const clearedLines = this.liveFooterLines();
    const settled = this.takeSettledExcept(null);
    const frame = `${this.clearTerminalLines(clearedLines)}${settled.join("")}${content}${this.renderLiveRecords()}`;
    this.emitFrame(frame, at, "ordinary-with-footer", undefined, clearedLines, settled.length ? "settled-committed" : undefined);
  }

  private liveEvent(record: Record<string, unknown>): { liveKey: string; messageId: string; lifecycle: LiveRecord["lifecycle"] } | null {
    if (record["msg"] !== "Feishu outbound message") return null;
    const feishu = record["feishu"];
    if (!feishu || typeof feishu !== "object") return null;
    const value = feishu as Record<string, unknown>;
    const kind = String(value["kind"]);
    const operation = String(value["operation"]);
    if (!LIVE_MESSAGE_KINDS.has(kind) || typeof value["messageId"] !== "string") return null;
    if (kind === "result" && operation !== "update") return null;
    const lifecycle = kind === "result" || (kind === "approval" && operation !== "send") ? "settled" : "active";
    return { liveKey: `message:${value["messageId"]}`, messageId: value["messageId"], lifecycle };
  }

  private liveFingerprint(record: Record<string, unknown>): string {
    const feishu = record["feishu"];
    if (!feishu || typeof feishu !== "object") return "";
    const value = feishu as Record<string, unknown>;
    const content = value["content"];
    if (content && typeof content === "object") {
      const { updatedAt: _updatedAt, ...stableContent } = content as Record<string, unknown>;
      return JSON.stringify({ ...value, content: stableContent }) ?? String(stableContent);
    }
    return JSON.stringify(value) ?? String(value);
  }

  private clearTerminalLines(lines: number): string {
    if (!lines) return "";
    return `\u001b[${lines}A${"\u001b[2K\u001b[1B".repeat(lines)}\u001b[${lines}A\r`;
  }

  private takeSettledExcept(except: string | null): string[] {
    const committed: string[] = [];
    for (const [key, entry] of this.liveRecords) {
      if (entry.lifecycle !== "settled" || key === except) continue;
      committed.push(entry.rendered);
      this.liveRecords.delete(key);
    }
    return committed;
  }

  private renderLiveRecords(): string {
    return [...this.liveRecords.values()].map((entry) => entry.rendered).join("");
  }

  private renderLiveRecord(record: Record<string, unknown>): { rendered: string; lines: number } {
    const rendered = wrapForTerminal(formatLogRecord(record, false), this.terminalWidth());
    if (rendered.lines < this.terminalRows()) return rendered;
    return wrapForTerminal(formatLogRecord(record, false, true), this.terminalWidth());
  }

  private liveFooterLines(): number {
    return [...this.liveRecords.values()].reduce((total, entry) => total + entry.lines, 0);
  }

  private canClearFooter(): boolean {
    if (!this.liveRecords.size) return true;
    return this.footerColumns === this.terminalColumns() && this.liveFooterLines() < this.terminalRows();
  }

  private rememberFingerprint(key: string, fingerprint: string): void {
    this.recentFingerprints.delete(key);
    this.recentFingerprints.set(key, fingerprint);
    if (this.recentFingerprints.size > 10_000) this.recentFingerprints.delete(this.recentFingerprints.keys().next().value!);
  }

  private emitFrame(frame: string, at: number, transition: string, messageId: string | undefined, clearedLines: number, reason?: string): void {
    this.target.write(frame);
    this.terminalOutput?.append(at, frame);
    this.footerColumns = this.liveRecords.size ? this.terminalColumns() : undefined;
    this.trace(at, transition, messageId, clearedLines, Buffer.byteLength(frame), reason);
  }

  private trace(at: number, transition: string, messageId: string | undefined, clearedLines: number, emittedBytes: number, reason?: string): void {
    if (!this.rendererTrace) return;
    const trace: RendererTrace = {
      at,
      transition,
      state: this.liveRecords.size ? "live-footer" : "idle",
      ...(messageId ? { messageId } : {}),
      columns: this.terminalColumns(),
      rows: this.terminalRowsValue(),
      footerEntries: this.liveRecords.size,
      footerLines: this.liveFooterLines(),
      clearedLines,
      emittedBytes,
      ...(reason ? { reason } : {}),
    };
    this.rendererTrace.append(at, `${JSON.stringify(trace)}\n`);
  }

  private recordTime(record: Record<string, unknown>): number {
    return typeof record["time"] === "number" ? record["time"] : Date.now();
  }

  private terminalWidth(): number {
    return Math.max(4, (this.terminalColumns() ?? 120) - 1);
  }

  private terminalColumns(): number | null {
    return typeof this.target.columns === "number" && Number.isFinite(this.target.columns) ? Math.max(5, Math.floor(this.target.columns)) : null;
  }

  private terminalRowsValue(): number | null {
    return typeof this.target.rows === "number" && Number.isFinite(this.target.rows) ? Math.max(2, Math.floor(this.target.rows)) : null;
  }

  private terminalRows(): number {
    return this.terminalRowsValue() ?? Number.POSITIVE_INFINITY;
  }

}

class DiagnosticLogWriter {
  private activeDate: string | undefined;
  private activeHour: string | undefined;
  private activeChunk = 0;
  private activePath: string | undefined;
  private activeBytes = 0;

  private static readonly MAX_CHUNK_BYTES = 10 * 1024 * 1024;

  constructor(private readonly directory: string, private readonly kind: "terminal" | "renderer", private readonly extension: "ansi" | "jsonl") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  append(at: number, content: string): void {
    const date = dateStamp(at);
    const hour = hourStamp(at);
    const bytes = Buffer.byteLength(content, "utf8");
    if (date !== this.activeDate || hour !== this.activeHour) this.selectLatestChunk(date, hour);
    if (this.activeBytes > 0 && this.activeBytes + bytes > DiagnosticLogWriter.MAX_CHUNK_BYTES) {
      this.selectChunk(date, hour, this.activeChunk + 1, 0);
    }
    appendFileSync(this.activePath!, content, { encoding: "utf8", mode: 0o600 });
    this.activeBytes += bytes;
  }

  private selectLatestChunk(date: string, hour: string): void {
    const folder = path.join(this.directory, date);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const prefix = `${hour}-${this.kind}-`;
    const suffix = `.${this.extension}`;
    const chunks = readdirSync(folder)
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => Number(name.slice(prefix.length, -suffix.length)))
      .filter((chunk) => Number.isSafeInteger(chunk) && chunk > 0)
      .sort((left, right) => right - left);
    const latest = chunks[0] ?? 0;
    const latestPath = latest > 0 ? path.join(folder, this.chunkName(hour, latest)) : undefined;
    const latestBytes = latestPath ? statSync(latestPath).size : 0;
    if (latest > 0 && latestBytes < DiagnosticLogWriter.MAX_CHUNK_BYTES) this.selectChunk(date, hour, latest, latestBytes);
    else this.selectChunk(date, hour, latest + 1, 0);
  }

  private selectChunk(date: string, hour: string, chunk: number, bytes: number): void {
    const folder = path.join(this.directory, date);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.activeDate = date;
    this.activeHour = hour;
    this.activeChunk = chunk;
    this.activePath = path.join(folder, this.chunkName(hour, chunk));
    this.activeBytes = bytes;
  }

  private chunkName(hour: string, chunk: number): string {
    return `${hour}-${this.kind}-${String(chunk).padStart(4, "0")}.${this.extension}`;
  }
}

class DailyLogStream extends Writable {
  private buffered = "";
  private activeDate: string | undefined;
  private activeHour: string | undefined;
  private activeChunk = 0;
  private activePath: string | undefined;
  private activeBytes = 0;

  private static readonly MAX_CHUNK_BYTES = 10 * 1024 * 1024;

  constructor(private readonly directory: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffered += chunk.toString();
    let newline = this.buffered.indexOf("\n");
    try {
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line) this.writeLine(line);
        newline = this.buffered.indexOf("\n");
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      if (this.buffered) this.writeLine(this.buffered);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private writeLine(line: string): void {
    const record = JSON.parse(line) as Record<string, unknown>;
    const date = dateStamp(record["time"]);
    const hour = hourStamp(record["time"]);
    const formatted = formatLogRecord(record, false);
    const bytes = Buffer.byteLength(formatted, "utf8");

    if (date !== this.activeDate || hour !== this.activeHour) this.selectLatestChunk(date, hour);
    if (this.activeBytes > 0 && this.activeBytes + bytes > DailyLogStream.MAX_CHUNK_BYTES) {
      this.selectChunk(date, hour, this.activeChunk + 1, 0);
    }

    appendFileSync(this.activePath!, formatted, { encoding: "utf8", mode: 0o600 });
    this.activeBytes += bytes;
  }

  private selectLatestChunk(date: string, hour: string): void {
    const folder = path.join(this.directory, date);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const prefix = `${hour}-`;
    const chunks = readdirSync(folder)
      .filter((name) => name.startsWith(prefix) && /^\d{2}-\d{4,}\.log$/u.test(name))
      .map((name) => Number(name.slice(prefix.length, -4)))
      .filter((chunk) => Number.isSafeInteger(chunk) && chunk > 0)
      .sort((left, right) => right - left);
    const latest = chunks[0] ?? 0;
    const latestPath = latest > 0 ? path.join(folder, this.chunkName(hour, latest)) : undefined;
    const latestBytes = latestPath ? statSync(latestPath).size : 0;
    if (latest > 0 && latestBytes < DailyLogStream.MAX_CHUNK_BYTES) this.selectChunk(date, hour, latest, latestBytes);
    else this.selectChunk(date, hour, latest + 1, 0);
  }

  private selectChunk(date: string, hour: string, chunk: number, bytes: number): void {
    const folder = path.join(this.directory, date);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.activeDate = date;
    this.activeHour = hour;
    this.activeChunk = chunk;
    this.activePath = path.join(folder, this.chunkName(hour, chunk));
    this.activeBytes = bytes;
  }

  private chunkName(hour: string, chunk: number): string {
    return `${hour}-${String(chunk).padStart(4, "0")}.log`;
  }
}

export async function retainDailyLogs(directory: string, maxAgeDays: number, maxBytes: number, now = Date.now()): Promise<{ removed: number; bytes: number }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const today = dateStamp(now);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name);
  const entries = await Promise.all(names.map(async (name) => ({ name, info: await stat(path.join(directory, name)), size: await directoryBytes(path.join(directory, name)) })));
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const cutoff = now - maxAgeDays * 86_400_000;
  let keptBytes = 0;
  let removed = 0;
  for (const entry of entries) {
    const isCurrent = entry.name === today;
    const remove = !isCurrent && (entry.info.mtimeMs < cutoff || keptBytes + entry.size > maxBytes);
    if (remove) {
      await rm(path.join(directory, entry.name), { recursive: true, force: true });
      removed += 1;
    } else keptBytes += entry.size;
  }
  return { removed, bytes: keptBytes };
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

export function createLogger(level = "info", options: LoggerOptions = {}): Logger {
  const output = options.output ?? process.stdout;
  const useColor = options.color ?? (output === process.stdout && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined);
  const diagnostics = options.logDir && options.terminalDiagnostics
    ? {
        output: new DiagnosticLogWriter(options.logDir, "terminal", "ansi"),
        trace: new DiagnosticLogWriter(options.logDir, "renderer", "jsonl"),
      }
    : undefined;
  const streams: Array<StreamEntry<string>> = [{ level, stream: new PrettyLogStream(output, useColor, options.liveStatus ?? false, diagnostics?.output, diagnostics?.trace) }];
  if (options.logDir) streams.push({ level, stream: new DailyLogStream(options.logDir) });
  return pino({
    level,
    base: { service: "pulsecortex" },
    redact: {
      paths: ["appId", "appSecret", "signingKey", "secrets", "token", "*.appSecret", "*.token", "*.authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  }, pino.multistream(streams));
}
