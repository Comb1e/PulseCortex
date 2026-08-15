import { describe, expect, it } from "vitest";
import { isPathInside, paginate, parseCommand, pathsOverlap, redact, transition } from "./index.js";

describe("command parsing", () => {
  it("parses commands and strips bot suffixes", () => {
    expect(parseCommand(" /new@bot api ")).toEqual({ name: "new", args: ["api"], text: "/new@bot api" });
    expect(parseCommand("/send@bot session-1 keep going")).toEqual({ name: "send", args: ["session-1", "keep", "going"], text: "/send@bot session-1 keep going" });
    expect(parseCommand("implement this").name).toBe("text");
    expect(parseCommand("/shell whoami").name).toBe("unknown");
  });
});

describe("session transitions", () => {
  it("allows the approval lifecycle and rejects invalid completion", () => {
    expect(transition("working", "request_approval")).toBe("awaiting_approval");
    expect(transition("awaiting_approval", "resolve_approval")).toBe("working");
    expect(() => transition("idle", "complete")).toThrow(/Invalid session transition/u);
  });
});

describe("path boundaries", () => {
  it("detects containment and overlap without prefix confusion", () => {
    const root = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    const child = process.platform === "win32" ? "C:\\work\\app\\src" : "/work/app/src";
    const sibling = process.platform === "win32" ? "C:\\work\\app2" : "/work/app2";
    expect(isPathInside(root, child)).toBe(true);
    expect(isPathInside(root, sibling)).toBe(false);
    expect(pathsOverlap(root, child)).toBe(true);
    expect(pathsOverlap(root, sibling)).toBe(false);
  });
});

describe("safe mobile output", () => {
  it("removes controls, redacts credentials, and paginates", () => {
    expect(redact("\u001b[31mtoken=abc123\u001b[0m")).toBe("[REDACTED]");
    const page = paginate("x".repeat(500), 1, 100, 2);
    expect(page.totalPages).toBe(2);
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(100);
    expect(paginate("x".repeat(500), 2, 100, 2).text).toContain("Output truncated");
  });
});
