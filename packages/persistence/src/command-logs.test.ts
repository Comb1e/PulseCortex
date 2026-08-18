import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandLogStore } from "./command-logs.js";

describe("command log store", () => {
  it("returns concatenated command output instead of JSONL storage records", async () => {
    const store = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));

    await store.append("turn", "stdout", "first line\n");
    await store.append("turn", "stderr", "second line\n");

    expect(await store.read("turn")).toBe("first line\nsecond line\n");
  });

  it("reports when a turn has no recorded command output", async () => {
    const store = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));

    expect(await store.read("missing")).toBe("No command output recorded.");
  });
});
