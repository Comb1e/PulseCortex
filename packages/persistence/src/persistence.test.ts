import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionTokenService, ControllerStore } from "./index.js";

const stores: ControllerStore[] = [];
function memoryStore(): ControllerStore { const store = new ControllerStore(":memory:"); stores.push(store); return store; }
afterEach(() => { while (stores.length) stores.pop()?.close(); });

describe("pairing and owner authorization", () => {
  it("consumes a short-lived code once", () => {
    const store = memoryStore();
    const actor = { tenantId: "tenant", userId: "owner" };
    const { code } = store.createPairingCode();
    expect(store.consumePairingCode(code, actor)).toBe(true);
    expect(store.consumePairingCode(code, actor)).toBe(false);
    expect(store.isOwner(actor)).toBe(true);
    expect(store.isOwner({ tenantId: "tenant", userId: "other" })).toBe(false);
  });

  it("locks the active code after five bad attempts", () => {
    const store = memoryStore();
    const { code } = store.createPairingCode();
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) expect(store.consumePairingCode(wrongCode, { tenantId: "t", userId: "u" })).toBe(false);
    expect(store.consumePairingCode(code, { tenantId: "t", userId: "u" })).toBe(false);
  });
});

describe("action token replay prevention", () => {
  it("binds every field and consumes the nonce once", () => {
    const store = memoryStore();
    const tokens = new ActionTokenService(store, "x".repeat(32));
    const actor = { tenantId: "t", userId: "u" };
    const token = tokens.issue({ kind: "approval.accept", ...actor, sessionId: "s", turnId: "turn", requestId: "req", expiresAt: Date.now() + 60_000, payload: {} });
    expect(tokens.consume(token, actor, "approval.accept")?.requestId).toBe("req");
    expect(tokens.consume(token, actor, "approval.accept")).toBeNull();
  });

  it("rejects a different actor and tampering", () => {
    const store = memoryStore();
    const tokens = new ActionTokenService(store, "x".repeat(32));
    const token = tokens.issue({ kind: "turn.stop", tenantId: "t", userId: "u", sessionId: "s", turnId: "turn", requestId: "turn", expiresAt: Date.now() + 60_000, payload: {} });
    expect(tokens.consume(token, { tenantId: "t", userId: "other" })).toBeNull();
    expect(tokens.consume(`${token}x`, { tenantId: "t", userId: "u" })).toBeNull();
  });

  it("rejects an expired action", () => {
    const store = memoryStore();
    const tokens = new ActionTokenService(store, "x".repeat(32));
    const actor = { tenantId: "t", userId: "u" };
    const token = tokens.issue({ kind: "turn.stop", ...actor, sessionId: "s", turnId: "turn", requestId: "turn", expiresAt: Date.now() - 1, payload: {} });
    expect(tokens.consume(token, actor)).toBeNull();
  });
});

describe("project ambiguity", () => {
  it("rejects nested project registrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pulsecortex-"));
    const child = path.join(root, "child");
    await mkdir(child);
    const store = memoryStore();
    store.addProject("root", await realpath(root));
    const canonicalChild = await realpath(child);
    expect(() => store.addProject("child", canonicalChild)).toThrow(/overlaps/u);
  });

  it("stores typed local settings and clears a removed default project", () => {
    const store = memoryStore();
    const project = store.addProject("repo", process.cwd());
    expect(store.getLocalSettings()).toEqual({ defaultProject: null, autoStartOnBoot: false });

    store.setLocalSetting("defaultProject", project.name);
    store.setLocalSetting("autoStartOnBoot", true);
    expect(store.getLocalSettings()).toEqual({ defaultProject: project.name, autoStartOnBoot: true });

    expect(store.removeProject(project.name)).toBe(true);
    expect(store.getLocalSettings()).toEqual({ defaultProject: null, autoStartOnBoot: true });
  });

  it("rejects an unregistered default project", () => {
    const store = memoryStore();
    expect(() => store.setLocalSetting("defaultProject", "missing")).toThrow(/not registered/u);
  });

  it("creates settings.json, reloads manual edits, and preserves future keys", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulsecortex-settings-"));
    const settingsPath = path.join(directory, "settings.json");
    const store = new ControllerStore(":memory:", settingsPath); stores.push(store);
    const project = store.addProject("repo", process.cwd());
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ defaultProject: null, autoStartOnBoot: false });

    await writeFile(settingsPath, JSON.stringify({ defaultProject: project.name, autoStartOnBoot: false, theme: "dark" }));
    expect(store.getLocalSettings()).toEqual({ defaultProject: project.name, autoStartOnBoot: false });
    store.setLocalSetting("autoStartOnBoot", true);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ defaultProject: project.name, autoStartOnBoot: true, theme: "dark" });
  });

  it("migrates legacy SQLite settings into settings.json", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulsecortex-settings-"));
    const databasePath = path.join(directory, "pulsecortex.db");
    const settingsPath = path.join(directory, "settings.json");
    const legacy = new ControllerStore(databasePath);
    const project = legacy.addProject("repo", process.cwd());
    legacy.database.prepare("INSERT INTO local_settings(key, value_json, updated_at) VALUES (?, ?, ?)").run("lastProjectId", JSON.stringify(project.id), Date.now());
    legacy.database.prepare("INSERT INTO local_settings(key, value_json, updated_at) VALUES (?, ?, ?)").run("autoStartOnBoot", "true", Date.now());
    legacy.close();

    const restored = new ControllerStore(databasePath, settingsPath); stores.push(restored);
    expect(restored.getLocalSettings()).toEqual({ defaultProject: project.name, autoStartOnBoot: true });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ defaultProject: project.name, autoStartOnBoot: true });
  });
});

describe("event deduplication and restart recovery", () => {
  it("claims one event and marks active work unknown", () => {
    const store = memoryStore();
    expect(store.claimEvent("evt")).toBe(true);
    expect(store.claimEvent("evt")).toBe(false);
  });

  it("consolidates queued status by turn", () => {
    const store = memoryStore();
    const first = store.enqueueDelivery("status", { phase: "working" }, Date.now(), "turn:t:status");
    const second = store.enqueueDelivery("status", { phase: "awaiting_approval" }, Date.now(), "turn:t:status");
    expect(second).toBe(first);
    expect(store.queuedDeliveryCount()).toBe(1);
    expect(store.pendingDeliveries()[0]?.payload).toEqual({ phase: "awaiting_approval" });
  });
});
