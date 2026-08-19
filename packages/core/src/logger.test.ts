import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, formatLogRecord, retainDailyLogs } from "./logger.js";

function capture(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

class TerminalScreen extends Writable {
  private readonly lines = [""];
  private writes = 0;
  private row = 0;
  private column = 0;

  constructor(readonly columns = Number.POSITIVE_INFINITY, readonly rows = Number.POSITIVE_INFINITY) { super(); }

  text(): string { return this.lines.join("\n").trimEnd(); }
  writeCount(): number { return this.writes; }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes += 1;
    const content = chunk.toString();
    for (let index = 0; index < content.length;) {
      const control = content.slice(index).match(/^\u001b\[(\d+)([AB])|^\u001b\[2K/);
      if (control) {
        if (control[0] === "\u001b[2K") { this.lines[this.row] = ""; this.column = 0; }
        else {
          const distance = Number(control[1]);
          this.row = control[2] === "A" ? Math.max(0, this.row - distance) : this.row + distance;
          while (this.lines.length <= this.row) this.lines.push("");
        }
        index += control[0].length;
        continue;
      }
      const character = content[index] ?? "";
      if (character === "\n") {
        this.row += 1;
        this.column = 0;
        while (this.lines.length <= this.row) this.lines.push("");
      } else if (character === "\r") this.column = 0;
      else {
        const line = this.lines[this.row] ?? "";
        this.lines[this.row] = `${line.slice(0, this.column)}${character}${line.slice(this.column + 1)}`;
        this.column += 1;
        if (this.column >= this.columns) {
          this.row += 1;
          this.column = 0;
          while (this.lines.length <= this.row) this.lines.push("");
        }
      }
      index += 1;
    }
    callback();
  }
}

describe("daemon logger", () => {
  afterEach(() => vi.useRealTimers());

  it("formats structured records for terminal reading", () => {
    const output = formatLogRecord({ level: 40, time: new Date(2026, 7, 18, 9, 5, 4).getTime(), service: "pulsecortex", msg: "Connection retry", retryMs: 2500, detail: { connected: false } });
    expect(output).toContain("2026-08-18 09:05:04 WARN  Connection retry");
    expect(output).toContain("  retryMs: 2500");
    expect(output).toContain("  detail:\n    {\n      \"connected\": false\n    }");
    expect(output).not.toContain("service:");
    expect(output).not.toContain("\u001b[");
  });

  it("prints readable output and persists one redacted daily log", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 9, 5, 4));
    const terminal = new PassThrough();
    const terminalText = capture(terminal);
    const logger = createLogger("info", { output: terminal, color: false, logDir: directory });

    logger.info({ connected: true, token: "secret-value" }, "Feishu connected");

    expect(terminalText()).toContain("INFO  Feishu connected");
    expect(terminalText()).toContain("  connected: true\n  token: [REDACTED]");
    expect(await readdir(directory)).toEqual(["2026-08-18.log"]);
    expect(await readFile(path.join(directory, "2026-08-18.log"), "utf8")).toBe(terminalText());
    expect(terminalText()).not.toContain("secret-value");
  });

  it("replaces the terminal entry for an updated Feishu message", () => {
    const terminal = new TerminalScreen(80);
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working", safeSummary: "x".repeat(200) } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "update", messageId: "message-1", content: { phase: "completed", safeSummary: "y".repeat(200) } } }, "Feishu outbound message");

    const output = terminal.text();
    expect(output).not.toContain('"phase": "working"');
    expect(output).toContain('"phase": "completed"');
    expect(output.replaceAll("\n", "")).toContain(`"safeSummary": "${"y".repeat(200)}"`);
    expect((output.match(/message-1/g) ?? [])).toHaveLength(1);
    expect(terminal.writeCount()).toBe(2);
  });

  it("appends complete updates when a live message is taller than the terminal", () => {
    const terminal = new TerminalScreen(40, 6);
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working", safeSummary: "x".repeat(200) } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "update", messageId: "message-1", content: { phase: "completed", safeSummary: "y".repeat(200) } } }, "Feishu outbound message");

    const output = terminal.text().replaceAll("\n", "");
    expect(output).toContain(`"safeSummary": "${"x".repeat(200)}"`);
    expect(output).toContain(`"safeSummary": "${"y".repeat(200)}"`);
    expect((output.match(/message-1/g) ?? [])).toHaveLength(2);
    expect(output).not.toContain("\u001b[");
  });

  it("keeps only the latest resolved approval entry for a message ID", () => {
    const terminal = new TerminalScreen();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "approval", operation: "send", messageId: "approval-1", content: { title: "Run command" } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "approval", operation: "update", messageId: "approval-1", content: { title: "Run command", decision: "accept", resolvedAt: 1 } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "approval", operation: "update", messageId: "approval-1", content: { title: "Run command", decision: "acceptForSession", resolvedAt: 2 } } }, "Feishu outbound message");

    const output = terminal.text();
    expect(output).not.toContain('"decision": "accept"');
    expect(output).toContain('"decision": "acceptForSession"');
    expect((output.match(/approval-1/g) ?? [])).toHaveLength(1);
  });

  it("keeps terminal entries separate when message IDs differ", () => {
    const terminal = new TerminalScreen();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });
    const content = { sessionId: "session-1", turnId: "turn-1", phase: "working", safeSummary: "Codex is working...", updatedAt: 1 };

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-2", content: { ...content, updatedAt: 2 } } }, "Feishu outbound message");

    expect((terminal.text().match(/Codex is working\.\.\./g) ?? [])).toHaveLength(2);
  });

  it("does not pin one-off outbound text messages", () => {
    const terminal = new TerminalScreen();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "text", operation: "send", messageId: "message-1", content: "Delivered once" } }, "Feishu outbound message");
    logger.info({ connected: true }, "Feishu connection state changed");

    const output = terminal.text();
    expect((output.match(/Delivered once/g) ?? [])).toHaveLength(1);
    expect(output).not.toContain("\u001b[");
  });

  it("redraws live messages around an ordinary terminal log", () => {
    const terminal = new TerminalScreen();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working", safeSummary: "One visible status" } } }, "Feishu outbound message");
    logger.info({ connected: true }, "Feishu connection state changed");

    const output = terminal.text();
    expect((output.match(/One visible status/g) ?? [])).toHaveLength(1);
    expect((output.match(/Feishu connection state changed/g) ?? [])).toHaveLength(1);
  });

  it("retires a live status when the same message becomes a result", () => {
    const terminal = new TerminalScreen(100);
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working" } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "result", operation: "update", messageId: "message-1", content: { status: "completed", summary: "Done" } } }, "Feishu outbound message");
    logger.info({ connected: true }, "Feishu connection state changed");

    const output = terminal.text();
    expect(output).not.toContain('"phase": "working"');
    expect(output).toContain('"status": "completed"');
    expect((output.match(/message-1/g) ?? [])).toHaveLength(1);
    expect((output.match(/Feishu connection state changed/g) ?? [])).toHaveLength(1);
  });

  it("stores every update while replacing it in the terminal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const terminal = new PassThrough();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true, logDir: directory });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working" } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "update", messageId: "message-1", content: { phase: "completed" } } }, "Feishu outbound message");

    const [fileName] = await readdir(directory);
    const dailyLog = await readFile(path.join(directory, fileName!), "utf8");
    expect(dailyLog).toContain('"phase": "working"');
    expect(dailyLog).toContain('"phase": "completed"');
  });

  it("rolls over to a new file when the local date changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 23, 59, 59));
    const logger = createLogger("info", { output: new PassThrough(), color: false, logDir: directory });

    logger.info("Before midnight");
    vi.setSystemTime(new Date(2026, 7, 19, 0, 0, 1));
    logger.info("After midnight");

    expect((await readdir(directory)).sort()).toEqual(["2026-08-18.log", "2026-08-19.log"]);
    expect(await readFile(path.join(directory, "2026-08-18.log"), "utf8")).toContain("Before midnight");
    expect(await readFile(path.join(directory, "2026-08-19.log"), "utf8")).toContain("After midnight");
  });

  it("retains today's file while removing expired and over-budget daily logs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const now = new Date(2026, 7, 19, 12).getTime();
    const recent = path.join(directory, "2026-08-18.log");
    const expired = path.join(directory, "2026-08-01.log");
    await writeFile(path.join(directory, "2026-08-19.log"), "today", "utf8");
    await writeFile(recent, "recent", "utf8");
    await writeFile(expired, "expired", "utf8");
    await utimes(recent, new Date(now - 86_400_000), new Date(now - 86_400_000));
    await utimes(expired, new Date(now - 18 * 86_400_000), new Date(now - 18 * 86_400_000));

    expect(await retainDailyLogs(directory, 7, 8, now)).toEqual({ removed: 2, bytes: 5 });
    expect(await readdir(directory)).toEqual(["2026-08-19.log"]);
  });
});
