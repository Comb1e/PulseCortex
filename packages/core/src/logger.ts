import { rmSync, renameSync, statSync } from "node:fs";
import { Writable } from "node:stream";
import pino, { type Logger, type StreamEntry } from "pino";

const LEVEL_NAMES: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
const LEVEL_COLORS: Record<string, string> = { TRACE: "\u001b[90m", DEBUG: "\u001b[36m", INFO: "\u001b[32m", WARN: "\u001b[33m", ERROR: "\u001b[31m", FATAL: "\u001b[31;1m" };
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const LOG_METADATA = new Set(["level", "time", "pid", "hostname", "service", "msg"]);

interface LogTarget { write(content: string): unknown }

export interface LoggerOptions {
  output?: LogTarget;
  color?: boolean;
  liveStatus?: boolean;
  humanLogPath?: string;
  structuredLogPath?: string;
  maxFileBytes?: number;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

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

class PrettyLogStream extends Writable {
  private buffered = "";
  private readonly liveRecords = new Map<string, { rendered: string; lines: number }>();

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
        const rendered = formatLogRecord(record, this.color);
        this.clearLiveRecords();
        this.liveRecords.set(liveKey, { rendered, lines: rendered.split("\n").length - 1 });
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
    if (value["kind"] !== "status" || typeof value["messageId"] !== "string") return null;
    return `status:${value["messageId"]}`;
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
}

export function rotateLogFile(filePath: string, maxBytes: number): boolean {
  try {
    if (statSync(filePath).size < maxBytes) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(`${filePath}.previous`, { force: true });
  renameSync(filePath, `${filePath}.previous`);
  return true;
}

export function createLogger(level = "info", options: LoggerOptions = {}): Logger {
  const output = options.output ?? process.stdout;
  const useColor = options.color ?? (output === process.stdout && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined);
  const streams: Array<StreamEntry<string>> = [{ level, stream: new PrettyLogStream(output, useColor, options.liveStatus ?? false) }];
  const maxFileBytes = options.maxFileBytes ?? 100_000_000;
  if (options.humanLogPath) {
    rotateLogFile(options.humanLogPath, maxFileBytes);
    const humanFile = pino.destination({ dest: options.humanLogPath, mkdir: true, sync: true });
    streams.push({ level, stream: new PrettyLogStream(humanFile, false) });
  }
  if (options.structuredLogPath) {
    rotateLogFile(options.structuredLogPath, maxFileBytes);
    streams.push({ level, stream: pino.destination({ dest: options.structuredLogPath, mkdir: true, sync: true }) });
  }
  return pino({
    level,
    base: { service: "pulsecortex" },
    redact: {
      paths: ["appId", "appSecret", "signingKey", "secrets", "token", "*.appSecret", "*.token", "*.authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  }, pino.multistream(streams));
}
