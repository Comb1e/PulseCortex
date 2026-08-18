import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
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

class PrettyLogStream extends Writable {
  private buffered = "";
  private readonly liveRecords = new Map<string, { rendered: string; lines: number; fingerprint: string }>();

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
        this.clearLiveRecords();
        const rendered = wrapForTerminal(formatLogRecord(record, false), this.terminalWidth());
        this.liveRecords.set(liveKey, { ...rendered, fingerprint });
        this.renderLiveRecords();
        return;
      }
      if (this.liveStatus && this.liveRecords.size) {
        this.clearLiveRecords();
        this.target.write(formatLogRecord(record, this.color));
        this.renderLiveRecords();
        return;
      }
      this.target.write(formatLogRecord(record, this.color));
    }
    catch {
      if (this.liveStatus && this.liveRecords.size) {
        this.clearLiveRecords();
        this.target.write(`${line}\n`);
        this.renderLiveRecords();
      } else this.target.write(`${line}\n`);
    }
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

  private clearLiveRecords(): void {
    if (!this.liveRecords.size) return;
    const lines = [...this.liveRecords.values()].reduce((total, entry) => total + entry.lines, 0);
    this.target.write(`\u001b[${lines}A`);
    for (let index = 0; index < lines; index += 1) this.target.write(`\u001b[2K\u001b[1B`);
    this.target.write(`\u001b[${lines}A\r`);
  }

  private renderLiveRecords(): void {
    for (const entry of this.liveRecords.values()) this.target.write(entry.rendered);
  }

  private terminalWidth(): number {
    return typeof this.target.columns === "number" && Number.isFinite(this.target.columns) ? Math.max(4, Math.floor(this.target.columns) - 1) : 119;
  }
}

class DailyLogStream extends Writable {
  private buffered = "";

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
    const filePath = path.join(this.directory, `${dateStamp(record["time"])}.log`);
    appendFileSync(filePath, formatLogRecord(record, false), { encoding: "utf8", mode: 0o600 });
  }
}

export async function retainDailyLogs(directory: string, maxAgeDays: number, maxBytes: number, now = Date.now()): Promise<{ removed: number; bytes: number }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const today = dateStamp(now);
  const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/u.test(name));
  const entries = await Promise.all(names.map(async (name) => ({ name, info: await stat(path.join(directory, name)) })));
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const cutoff = now - maxAgeDays * 86_400_000;
  let keptBytes = 0;
  let removed = 0;
  for (const entry of entries) {
    const isCurrent = entry.name === `${today}.log`;
    const remove = !isCurrent && (entry.info.mtimeMs < cutoff || keptBytes + entry.info.size > maxBytes);
    if (remove) {
      await unlink(path.join(directory, entry.name));
      removed += 1;
    } else keptBytes += entry.info.size;
  }
  return { removed, bytes: keptBytes };
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
