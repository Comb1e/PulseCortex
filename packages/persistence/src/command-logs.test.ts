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

  it("keeps messages, commands, and command output in one append order", async () => {
    const store = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));

    const writes = [
      store.append("turn", "message", "I will inspect the project.\n"),
      store.append("turn", "command", "$ pnpm test\n"),
      store.append("turn", "stdout", "all tests passed\n"),
      store.append("turn", "message", "The tests are green.\n"),
    ];
    await Promise.all(writes);

    expect(await store.read("turn")).toBe("I will inspect the project.\n$ pnpm test\nall tests passed\nThe tests are green.\n");
  });
});
