import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardActionEvent, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { ControllerStore } from "@pulsecortex/persistence";
import { FeishuAdapter } from "./adapter.js";
import { approvalCard, statusCard } from "./cards.js";

const stores: ControllerStore[] = [];
afterEach(() => { while (stores.length) stores.pop()?.close(); });
function store(): ControllerStore { const value = new ControllerStore(":memory:"); stores.push(value); return value; }
const channel = { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), send: vi.fn(), updateCard: vi.fn() };

function message(content: string, user = "owner"): NormalizedMessage {
  return { messageId: `m-${content}`, chatId: "chat", chatType: "p2p", senderId: user, content, rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(), raw: { sender: { tenant_key: "tenant" } } };
}

describe("Feishu inbound contract", () => {
  it("accepts pairing once and rejects group/unknown owner messages", async () => {
    const db = store();
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel });
    const handler = vi.fn();
    adapter.onCommand(handler);
    await adapter.acceptMessage(message("/pair 123456"));
    expect(handler).toHaveBeenCalledOnce();
    const { code } = db.createPairingCode();
    expect(db.consumePairingCode(code, { tenantId: "tenant", userId: "owner" })).toBe(true);
    db.setOwnerChat({ tenantId: "tenant", userId: "owner" }, "chat");
    await adapter.acceptMessage(message("/status", "intruder"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("deduplicates card callbacks", async () => {
    const db = store();
    const { code } = db.createPairingCode();
    db.consumePairingCode(code, { tenantId: "tenant", userId: "owner" });
    db.setOwnerChat({ tenantId: "tenant", userId: "owner" }, "chat");
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel });
    const handler = vi.fn(); adapter.onAction(handler);
    const action = { messageId: "message", chatId: "chat", operator: { openId: "owner" }, action: { tag: "button", value: { kind: "turn.stop", token: "signed" } }, raw: { token: "event-token" } } as CardActionEvent;
    await adapter.acceptAction(action); await adapter.acceptAction(action);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("Feishu card rendering", () => {
  it("uses v2 callback behaviors and never offers session approval", () => {
    const approval = approvalCard({ approvalId: "a", sessionId: "s", turnId: "t", kind: "network", title: "Network", network: [{ host: "example.com", protocol: "https" }], actionTokens: { accept: "one", decline: "no", cancel: "stop" }, expiresAt: Date.now() + 60_000 });
    const json = JSON.stringify(approval);
    expect(json).toContain('"schema":"2.0"');
    expect(json).toContain('"type":"callback"');
    expect(json).toContain("Allow once");
    expect(json).not.toContain("Allow session");
  });

  it("renders bounded status actions", () => {
    const card = statusCard({ sessionId: "s", turnId: "t", title: "Task", projectName: "app", phase: "working", startedAt: 0, updatedAt: 10_000, safeSummary: "Working", recentCommands: ["pnpm test"], actionTokens: { stop: "s", logs: "l", diff: "d" } });
    expect(JSON.stringify(card)).toContain("pnpm test");
    expect(JSON.stringify(card)).toContain("**Session:** s");
  });
});
