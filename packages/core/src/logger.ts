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

interface LogTarget { write(content: string): unknown; columns?: number }

export interface LoggerOptions {
  output?: LogTarget;
  color?: boolean;
  liveStatus?: boolean;
  logDir?: string;
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

function formatField(key: string, value: unknown): string {
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else if (value === undefined) rendered = "undefined";
  else rendered = JSON.stringify(value, null, 2) ?? String(value);
  const lines = rendered.split("\n");
  if (lines.length === 1) return `  ${key}: ${lines[0]}`;
  return `  ${key}:\n${lines.map((line) => `    ${line}`).join("\n")}`;
}

export function formatLogRecord(record: Record<string, unknown>, color = false): string {
  const level = LEVEL_NAMES[Number(record["level"])] ?? String(record["level"] ?? "LOG").toUpperCase();
  const time = timestamp(record["time"]);
  const levelText = level.padEnd(5);
  const prefix = color ? `${DIM}${time}${RESET} ${LEVEL_COLORS[level] ?? ""}${levelText}${RESET}` : `${time} ${levelText}`;
  const message = typeof record["msg"] === "string" && record["msg"] ? record["msg"] : "Log event";
  const fields = Object.entries(record).filter(([key]) => !LOG_METADATA.has(key)).map(([key, value]) => formatField(key, value));
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

interface TerminalRecord {
  rendered: string;
  lines: number;
  liveKey?: string;
  fingerprint?: string;
}

class PrettyLogStream extends Writable {
  private buffered = "";
  private readonly terminalRecords: TerminalRecord[] = [];
  private readonly liveRecords = new Map<string, TerminalRecord>();

  constructor(private readonly target: LogTarget, private readonly color: boolean, private readonly liveStatus = false) { super(); }

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
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const liveKey = this.liveKey(record);
      if (this.liveStatus && liveKey) {
        const fingerprint = this.liveFingerprint(record);
        if (this.liveRecords.get(liveKey)?.fingerprint === fingerprint) return;
        const rendered = wrapForTerminal(formatLogRecord(record, false), this.terminalWidth());
        this.writeLiveRecord({ ...rendered, liveKey, fingerprint });
        return;
      }
      this.writeTerminalRecord(formatLogRecord(record, this.color));
    }
    catch {
      this.writeTerminalRecord(`${line}\n`);
    }
  }

  private writeLiveRecord(record: TerminalRecord & { liveKey: string; fingerprint: string }): void {
    const previous = this.liveRecords.get(record.liveKey);
    if (!previous) {
      this.terminalRecords.push(record);
      this.liveRecords.set(record.liveKey, record);
      this.target.write(record.rendered);
      return;
    }

    const previousIndex = this.terminalRecords.indexOf(previous);
    if (previousIndex < 0) throw new Error(`Missing terminal record for ${record.liveKey}`);
    const replay = this.terminalRecords.slice(previousIndex + 1);
    const lines = previous.lines + replay.reduce((total, entry) => total + entry.lines, 0);
    this.terminalRecords.splice(previousIndex, 1);
    this.terminalRecords.push(record);
    this.liveRecords.set(record.liveKey, record);
    this.target.write(`${this.clearTerminalLines(lines)}${replay.map((entry) => entry.rendered).join("")}${record.rendered}`);
    this.pruneTerminalHistory();
  }

  private writeTerminalRecord(content: string): void {
    if (!this.liveStatus || !this.liveRecords.size) {
      this.target.write(content);
      return;
    }
    const record = wrapForTerminal(content, this.terminalWidth());
    this.terminalRecords.push(record);
    this.target.write(record.rendered);
  }

  private liveKey(record: Record<string, unknown>): string | null {
    if (record["msg"] !== "Feishu outbound message") return null;
    const feishu = record["feishu"];
    if (!feishu || typeof feishu !== "object") return null;
    const value = feishu as Record<string, unknown>;
    const kind = String(value["kind"]);
    const operation = String(value["operation"]);
    if (!LIVE_MESSAGE_KINDS.has(kind) || typeof value["messageId"] !== "string") return null;
    if (kind === "result" && operation !== "update") return null;
    return `message:${value["messageId"]}`;
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
    return `\u001b[${lines}A${"\u001b[2K\u001b[1B".repeat(lines)}\u001b[${lines}A\r`;
  }

  private pruneTerminalHistory(): void {
    const firstLiveIndex = this.terminalRecords.findIndex((entry) => entry.liveKey !== undefined);
    if (firstLiveIndex > 0) this.terminalRecords.splice(0, firstLiveIndex);
  }

  private terminalWidth(): number {
    return typeof this.target.columns === "number" && Number.isFinite(this.target.columns) ? Math.max(4, Math.floor(this.target.columns) - 1) : 119;
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
  const streams: Array<StreamEntry<string>> = [{ level, stream: new PrettyLogStream(output, useColor, options.liveStatus ?? false) }];
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
