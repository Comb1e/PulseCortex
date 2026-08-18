import { readFile, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, formatLogRecord, rotateLogFile } from "./logger.js";

function capture(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

class TerminalScreen extends Writable {
  private readonly lines = [""];
  private row = 0;
  private column = 0;

  text(): string { return this.lines.join("\n").trimEnd(); }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
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
      }
      index += 1;
    }
    callback();
  }
}

describe("daemon logger", () => {
  it("formats structured records for terminal reading", () => {
    const output = formatLogRecord({ level: 40, time: new Date(2026, 7, 18, 9, 5, 4).getTime(), service: "pulsecortex", msg: "Connection retry", retryMs: 2500, detail: { connected: false } });
    expect(output).toContain("2026-08-18 09:05:04 WARN  Connection retry");
    expect(output).toContain("  retryMs: 2500");
    expect(output).toContain("  detail:\n    {\n      \"connected\": false\n    }");
    expect(output).not.toContain("service:");
    expect(output).not.toContain("\u001b[");
  });

  it("prints readable output and persists human and redacted structured logs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const humanLogPath = path.join(directory, "daemon.log");
    const structuredLogPath = path.join(directory, "daemon.jsonl");
    const terminal = new PassThrough();
    const terminalText = capture(terminal);
    const logger = createLogger("info", { output: terminal, color: false, humanLogPath, structuredLogPath });

    logger.info({ connected: true, token: "secret-value" }, "Feishu connected");

    expect(terminalText()).toContain("INFO  Feishu connected");
    expect(terminalText()).toContain("  connected: true\n  token: [REDACTED]");
    expect(await readFile(humanLogPath, "utf8")).toBe(terminalText());
    const structured = JSON.parse((await readFile(structuredLogPath, "utf8")).trim()) as Record<string, unknown>;
    expect(structured["msg"]).toBe("Feishu connected");
    expect(structured["token"]).toBe("[REDACTED]");
  });

  it("replaces the terminal entry for an updated Feishu message", () => {
    const terminal = new TerminalScreen();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working" } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "update", messageId: "message-1", content: { phase: "completed" } } }, "Feishu outbound message");

    const output = terminal.text();
    expect(output).not.toContain('"phase": "working"');
    expect(output).toContain('"phase": "completed"');
    expect((output.match(/Feishu outbound message/g) ?? [])).toHaveLength(1);
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

  it("stores every update while replacing it in the terminal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const humanLogPath = path.join(directory, "daemon.log");
    const structuredLogPath = path.join(directory, "daemon.jsonl");
    const terminal = new PassThrough();
    const logger = createLogger("info", { output: terminal, color: false, liveStatus: true, humanLogPath, structuredLogPath });

    logger.info({ feishu: { kind: "status", operation: "send", messageId: "message-1", content: { phase: "working" } } }, "Feishu outbound message");
    logger.info({ feishu: { kind: "status", operation: "update", messageId: "message-1", content: { phase: "completed" } } }, "Feishu outbound message");

    const humanLog = await readFile(humanLogPath, "utf8");
    const structuredLog = await readFile(structuredLogPath, "utf8");
    expect(humanLog).toContain('"phase": "working"');
    expect(humanLog).toContain('"phase": "completed"');
    expect(structuredLog.trim().split("\n")).toHaveLength(2);
  });

  it("rotates an oversized log and keeps one previous file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const filePath = path.join(directory, "daemon.log");
    await writeFile(filePath, "old log content", "utf8");

    expect(rotateLogFile(filePath, 5)).toBe(true);
    expect(await readFile(`${filePath}.previous`, "utf8")).toBe("old log content");
    expect(rotateLogFile(filePath, 5)).toBe(false);
  });
});
