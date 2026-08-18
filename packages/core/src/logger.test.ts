import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
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

  it("rotates an oversized log and keeps one previous file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-daemon-log-"));
    const filePath = path.join(directory, "daemon.log");
    await writeFile(filePath, "old log content", "utf8");

    expect(rotateLogFile(filePath, 5)).toBe(true);
    expect(await readFile(`${filePath}.previous`, "utf8")).toBe("old log content");
    expect(rotateLogFile(filePath, 5)).toBe(false);
  });
});
