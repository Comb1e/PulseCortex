import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentEvent, Project } from "@pulsecortex/domain";
import { CodexAppServerDriver } from "./driver.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-app-server.mjs");
const project: Project = { id: "project", name: "test", canonicalPath: process.cwd(), createdAt: Date.now() };

describe("Codex app-server contract", () => {
  it("discovers controllable threads in registered project subdirectories", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "reject-redundant-resume"], verifyVersion: false });
    await driver.start();
    await expect(driver.listSessions([project])).resolves.toEqual([expect.objectContaining({ id: "external-thread", projectId: "project", activeTurnId: "external-turn", state: "working", loaded: true, canAcceptDirectInput: true })]);
    await expect(driver.resumeSession("external-thread", project, { managed: false })).resolves.toBeUndefined();
    await driver.stop();
  });

  it("rejoins a loaded shared-server thread before reporting it as controllable", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "rejoin-loaded"], verifyVersion: false });
    await driver.start();

    await expect(driver.listSessions([project])).resolves.toEqual([
      expect.objectContaining({ id: "external-thread", loaded: true, canAcceptDirectInput: true }),
    ]);
    await expect(driver.resumeSession("external-thread", project, { managed: false })).resolves.toBeUndefined();
    await driver.stop();
  });

  it("preserves a discovered session subdirectory when starting its next turn", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "resumed-cwd"], verifyVersion: false });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { if (event.type === "turn.completed") complete(); });
    await driver.start();
    await driver.listSessions([project]);

    await expect(driver.startTurn("external-thread", "continue here")).resolves.toBe("019fake-turn");
    await completed;
    await driver.stop();
  });

  it("detects a running standalone thread from its Codex writer lock", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "pulse-codex-home-"));
    const locks = path.join(codexHome, "thread-writer-locks");
    await mkdir(locks);
    await writeFile(path.join(locks, "standalone-thread.lock"), "");
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "writer-lock"], env: { ...process.env, FAKE_CODEX_HOME: codexHome }, verifyVersion: false });
    await driver.start();

    await expect(driver.listSessions([project])).resolves.toContainEqual(expect.objectContaining({
      id: "standalone-thread", projectId: "project", state: "working", loaded: false, canAcceptDirectInput: false,
    }));
    await driver.stop();
  });

  it("does not resume a thread it just created before starting work", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "reject-redundant-resume"], verifyVersion: false });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await expect(driver.resumeSession(sessionId, project, { managed: true })).resolves.toBeUndefined();
    await driver.stop();
  });

  it("lists and applies Codex built-in instruction presets", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture], verifyVersion: false });
    await driver.start();
    const sessionId = await driver.createSession(project, {});

    await expect(driver.listInstructionPresets()).resolves.toEqual([
      { id: "Plan", label: "Plan", mode: "plan", reasoningEffort: "medium" },
      { id: "Default", label: "Default", mode: "default" },
    ]);
    await expect(driver.selectInstructionPreset(sessionId, "Plan")).resolves.toEqual({ id: "Plan", label: "Plan", mode: "plan", reasoningEffort: "medium" });
    await driver.stop();
  });

  it("normalizes streams and one-time network approval", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture], verifyVersion: false });
    const events: AgentEvent[] = [];
    let startReturned = false;
    let eventBeforeReturn = false;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => {
      if (!startReturned && event.type !== "driver.crashed") eventBeforeReturn = true;
      events.push(event);
      if (event.type === "approval.requested") void driver.resolveApproval(event.approvalId, "accept");
      if (event.type === "turn.completed") complete();
    });
    const capabilities = await driver.start();
    expect(capabilities.protocolMajor).toBe(2);
    expect(capabilities.supportsNamespaceTools).toBe(true);
    const sessionId = await driver.createSession(project, {});
    expect(sessionId).toBe("019fake-thread");
    await driver.startTurn(sessionId, "run tests");
    startReturned = true;
    await completed;
    expect(events.find((event) => event.type === "approval.requested")).toMatchObject({ kind: "network", network: [{ host: "registry.npmjs.org", protocol: "https" }] });
    expect(events.some((event) => event.type === "command.started")).toBe(true);
    expect(events.some((event) => event.type === "diff.updated")).toBe(true);
    expect(eventBeforeReturn).toBe(false);
    await driver.stop();
  });

  it("emits the authoritative completed plan item", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "plan-complete"], verifyVersion: false });
    const events: AgentEvent[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { events.push(event); if (event.type === "turn.completed") complete(); });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "plan the change");
    await completed;

    expect(events.find((event) => event.type === "plan.completed")).toMatchObject({
      sessionId,
      text: "# Plan\n\n1. Make the change.\n2. Run the tests.",
    });
    await driver.stop();
  });

  it("maps command auto approve to the native session decision", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "auto-approve"], verifyVersion: false });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => {
      if (event.type === "approval.requested") {
        expect(event).toMatchObject({ kind: "command", title: "Run command outside sandbox?", canAutoApprove: true });
        void driver.resolveApproval(event.approvalId, "acceptForSession");
      }
      if (event.type === "turn.completed") complete();
    });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "run tests");
    await completed;
    await driver.stop();
  });

  it("rejects structured root filesystem grants before presenting approval", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "unsafe-permission"], verifyVersion: false });
    const events: AgentEvent[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { events.push(event); if (event.type === "turn.completed") complete(); });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "request unsafe permission");
    await completed;
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    expect(events.some((event) => event.type === "agent.message.delta" && event.delta.includes("denied filesystem access"))).toBe(true);
    await driver.stop();
  });

  it("rejects filesystem grants that escape through a directory link", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "pulse-path-policy-"));
    const registered = path.join(temporary, "registered");
    const outside = path.join(temporary, "outside");
    const linked = path.join(registered, "linked");
    await mkdir(registered);
    await mkdir(outside);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const linkedProject: Project = { ...project, canonicalPath: await realpath(registered) };
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "symlink-permission"],
      env: { ...process.env, FAKE_PERMISSION_PATH: path.join(linked, "new-file.txt") },
      verifyVersion: false,
    });
    const events: AgentEvent[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { events.push(event); if (event.type === "turn.completed") complete(); });

    try {
      await driver.start();
      const sessionId = await driver.createSession(linkedProject, {});
      await driver.startTurn(sessionId, "request linked write permission");
      await completed;
      expect(events.some((event) => event.type === "approval.requested")).toBe(false);
      expect(events.some((event) => event.type === "agent.message.delta" && event.delta.includes("denied filesystem access"))).toBe(true);
    } finally {
      await driver.stop();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("blocks new turns while the execution environment is disconnected", async () => {
    const diagnostics: string[] = [];
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "disconnected-before-turn"],
      verifyVersion: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(driver.startTurn(sessionId, "use a tool")).rejects.toThrow("tool access is unavailable");
    expect(diagnostics).toContain("Codex execution environment disconnected; tool access is unavailable");
    await driver.stop();
  });

  it("fails an active turn when its execution environment disconnects", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "disconnect-active"], verifyVersion: false });
    const events: AgentEvent[] = [];
    driver.subscribe((event) => events.push(event));
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "use a tool").catch(() => undefined);

    await expect.poll(() => events.some((event) => event.type === "turn.failed")).toBe(true);
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({ error: expect.stringContaining("tool access is unavailable") });
    await driver.stop();
  });

  it("interrupts a turn when a raw response reports invalid tool arguments", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "raw-router-error"], verifyVersion: false });
    const events: AgentEvent[] = [];
    driver.subscribe((event) => events.push(event));
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "use a namespace tool");

    await expect.poll(() => events.some((event) => event.type === "turn.failed")).toBe(true);
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({ error: expect.stringContaining("may not preserve namespace tool schemas") });
    await expect(driver.startTurn(sessionId, "recover after failure")).resolves.toBe("019fake-turn");
    await driver.stop();
  });

  it("uses stderr as a circuit breaker when exactly one turn is active", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "stderr-router-error"], verifyVersion: false });
    const events: AgentEvent[] = [];
    driver.subscribe((event) => events.push(event));
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "use a namespace tool");

    await expect.poll(() => events.some((event) => event.type === "turn.failed")).toBe(true);
    await driver.stop();
  });

  it("reports when the configured provider lacks namespace tools", async () => {
    const diagnostics: string[] = [];
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "no-namespace-tools"],
      verifyVersion: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    const capabilities = await driver.start();

    expect(capabilities.supportsNamespaceTools).toBe(false);
    expect(diagnostics).toContain("Codex model provider does not support namespace tools; PulseCortex-managed sessions use single-agent tools");
    await driver.stop();
  });

  it("responds safely to app-server host requests", async () => {
    const diagnostics: string[] = [];
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "host-requests"],
      verifyVersion: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { if (event.type === "turn.completed") complete(); });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "exercise host requests");
    await completed;

    expect(diagnostics).not.toContain("Rejected an unregistered dynamic tool call");
    expect(diagnostics).toContain("Declined MCP elicitation because remote structured input is not enabled");
    await driver.stop();
  });

  it("warns only after five consecutive rejected dynamic tool calls", async () => {
    const diagnostics: Array<{ level: string; message: string; details?: Record<string, unknown> }> = [];
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "tool-call-warning-threshold"],
      verifyVersion: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { if (event.type === "turn.completed") complete(); });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "repeat invalid dynamic tool calls");
    await completed;

    const warnings = diagnostics.filter((diagnostic) => diagnostic.message === "Rejected an unregistered dynamic tool call");
    expect(warnings).toEqual([expect.objectContaining({
      level: "warn",
      details: expect.objectContaining({ consecutiveFailures: 5, tool: "unregistered-after-reset-5" }),
    })]);
    await driver.stop();
  });

  it("clears pending requests resolved by the app-server during validation", async () => {
    const driver = new CodexAppServerDriver({ executable: process.execPath, args: [fixture, "server-resolved"], verifyVersion: false });
    const events: AgentEvent[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    driver.subscribe((event) => { events.push(event); if (event.type === "turn.completed") complete(); });
    await driver.start();
    const sessionId = await driver.createSession(project, {});
    await driver.startTurn(sessionId, "wait for cancellation");
    await completed;

    const resolved = events.find((event) => event.type === "request.resolved");
    expect(resolved).toEqual(expect.objectContaining({ sessionId, requestId: `${sessionId}:${resolved?.turnId}:cmd` }));
    const approval = events.find((event) => event.type === "approval.requested");
    if (approval?.type === "approval.requested") expect(approval.approvalId).toBe(resolved?.type === "request.resolved" ? resolved.requestId : undefined);
    if (resolved?.type === "request.resolved") await expect(driver.resolveApproval(resolved.requestId, "accept")).rejects.toThrow("stale");
    await driver.stop();
  });

  it("surfaces app-server warnings and stderr as diagnostics", async () => {
    const diagnostics: Array<{ level: string; message: string; output?: unknown }> = [];
    const driver = new CodexAppServerDriver({
      executable: process.execPath,
      args: [fixture, "diagnostics"],
      verifyVersion: false,
      onDiagnostic: (diagnostic) => diagnostics.push({ level: diagnostic.level, message: diagnostic.message, output: diagnostic.details?.["output"] }),
    });
    await driver.start();

    await expect.poll(() => diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warn", message: "fake app-server warning" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warn", message: "Codex app-server stderr", output: "fake app-server stderr" }));
    await driver.stop();
  });
});
