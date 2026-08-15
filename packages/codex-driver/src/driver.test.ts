import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent, Project } from "@pulsecortex/domain";
import { CodexAppServerDriver } from "./driver.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-app-server.mjs");
const project: Project = { id: "project", name: "test", canonicalPath: process.cwd(), createdAt: Date.now() };

describe("Codex app-server contract", () => {
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
});
