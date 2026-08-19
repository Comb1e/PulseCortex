import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardActionEvent, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { ControllerStore } from "@pulsecortex/persistence";
import { FeishuAdapter } from "./adapter.js";
import { approvalCard, choiceCard, questionCard, resolvedApprovalCard, resolvedQuestionCard, statusCard } from "./cards.js";

const stores: ControllerStore[] = [];
afterEach(() => { while (stores.length) stores.pop()?.close(); });
function store(): ControllerStore { const value = new ControllerStore(":memory:"); stores.push(value); return value; }
const channel = { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), send: vi.fn(), updateCard: vi.fn(), recallMessage: vi.fn() };

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

  it("normalizes raw form values and rejects malformed fields", async () => {
    const db = store();
    const { code } = db.createPairingCode();
    db.consumePairingCode(code, { tenantId: "tenant", userId: "owner" });
    db.setOwnerChat({ tenantId: "tenant", userId: "owner" }, "chat");
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel });
    const handler = vi.fn(); adapter.onAction(handler);
    const base = { messageId: "message", chatId: "chat", operator: { openId: "owner" }, action: { tag: "button", value: { kind: "input.answer", token: "signed" } }, raw: { token: "form-event", header: { tenant_key: "tenant" }, action: { form_value: { choice: "2", note: "hello" } } } } as unknown as CardActionEvent;
    await adapter.acceptAction(base);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ formValues: { choice: "2", note: "hello" } }));

    const malformed = { messageId: "message", chatId: "chat", operator: { openId: "owner" }, action: { tag: "button", value: { kind: "input.answer", token: "signed" } }, raw: { token: "bad-form-event", header: { tenant_key: "tenant" }, action: { form_value: { choice: 2 } } } } as unknown as CardActionEvent;
    await adapter.acceptAction(malformed);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("Feishu card rendering", () => {
  it("reports every delivered message without action tokens", async () => {
    const db = store();
    const { code } = db.createPairingCode();
    db.consumePairingCode(code, { tenantId: "tenant", userId: "owner" });
    db.setOwnerChat({ tenantId: "tenant", userId: "owner" }, "chat");
    const outbound: unknown[] = [];
    const testChannel = { ...channel, send: vi.fn().mockResolvedValue({ messageId: "sent" }), updateCard: vi.fn().mockResolvedValue(undefined) };
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel: testChannel, onOutboundMessage: (message) => outbound.push(message) });

    await adapter.sendText("hello");
    await adapter.sendStatus({ sessionId: "session", turnId: "turn", title: "Task", projectName: "app", phase: "working", startedAt: 0, updatedAt: 1, safeSummary: "Working", recentCommands: [], actionTokens: { stop: "secret-stop", logs: "secret-logs", diff: "secret-diff" } });

    expect(outbound).toHaveLength(2);
    expect(JSON.stringify(outbound)).toContain("hello");
    expect(JSON.stringify(outbound)).not.toContain("secret-stop");
  });

  it("offers auto approve only for command requests", () => {
    const approval = approvalCard({ approvalId: "a", sessionId: "s", turnId: "t", kind: "network", title: "Network", network: [{ host: "example.com", protocol: "https" }], actionTokens: { accept: "one", decline: "no", cancel: "stop" }, expiresAt: Date.now() + 60_000 });
    const json = JSON.stringify(approval);
    expect(json).toContain('"schema":"2.0"');
    expect(json).toContain('"type":"callback"');
    expect(json).toContain("Allow once");
    expect(json).not.toContain("Auto approve");

    const command = approvalCard({ approvalId: "c", sessionId: "s", turnId: "t", kind: "command", title: "Command", command: "pnpm test", actionTokens: { accept: "one", autoApprove: "auto", decline: "no", cancel: "stop" }, expiresAt: Date.now() + 60_000 });
    const commandJson = JSON.stringify(command);
    expect(commandJson).toContain("Auto approve");
    expect(commandJson).toContain("approval.acceptForSession");
  });

  it("replaces an approval with a static executed-choice card", () => {
    const card = resolvedApprovalCard({ title: "Command approval requested", decision: "accept", resolvedAt: 1 });
    const json = JSON.stringify(card);
    expect(json).toContain("Choice executed");
    expect(json).toContain("Allowed once");
    expect(json).not.toContain('"tag":"button"');

    const autoApproved = JSON.stringify(resolvedApprovalCard({ title: "Command approval requested", decision: "acceptForSession", resolvedAt: 1 }));
    expect(autoApproved).toContain("Auto approve enabled");
    expect(autoApproved).not.toContain('"tag":"button"');
  });

  it("renders complete question forms and static resolutions", () => {
    const view = { sessionId: "s", turnId: "t", requestId: "r", questionId: "q", title: "Question", question: "A complete question with all source text", options: Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index}`, description: `Description ${index}` })), freeformAccepted: true, submissionToken: "secret-token" } as const;
    const card = questionCard(view);
    const json = JSON.stringify(card);
    expect(json).toContain("Option 9");
    expect(json).toContain("Description 9");
    expect(json).toContain('"text_size":"notation"');
    expect(json).toContain('"tag":"form"');
    expect(json).toContain('"action_type":"form_submit"');
    expect(json).toContain("secret-token");
    expect(JSON.stringify(resolvedQuestionCard({ title: "Question", question: view.question, status: "selected", answer: "Option 9", note: "Context", resolvedAt: 1 }))).not.toContain('"tag":"button"');
    expect(JSON.stringify(resolvedQuestionCard({ title: "Question", question: view.question, status: "withdrawn", resolvedAt: 1 }))).not.toContain('"tag":"form"');
  });

  it("returns question references and omits submission tokens from outbound reports", async () => {
    const db = store();
    const { code } = db.createPairingCode();
    db.consumePairingCode(code, { tenantId: "tenant", userId: "owner" });
    db.setOwnerChat({ tenantId: "tenant", userId: "owner" }, "chat");
    const outbound: unknown[] = [];
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel: { ...channel, send: vi.fn().mockResolvedValue({ messageId: "question-message" }), updateCard }, onOutboundMessage: (message) => outbound.push(message) });
    const view = { sessionId: "s", turnId: "t", requestId: "r", questionId: "q", title: "Question", question: "Choose", options: [{ label: "A" }], freeformAccepted: false, submissionToken: "secret-token" };
    const ref = await adapter.sendQuestion(view);
    await adapter.updateQuestion(ref, { title: "Question", question: "Choose", status: "selected", answer: "A", resolvedAt: 1 });
    expect(ref).toEqual({ messageId: "question-message", chatId: "chat" });
    expect(JSON.stringify(outbound)).not.toContain("secret-token");
    expect(updateCard).toHaveBeenCalledWith("question-message", expect.any(Object));
  });

  it("recalls a resolved approval so the working card returns to the bottom", async () => {
    const db = store();
    const recallMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel: { ...channel, recallMessage } });

    await adapter.removeApproval({ messageId: "approval-message", chatId: "chat" });

    expect(recallMessage).toHaveBeenCalledWith("approval-message");
  });

  it("replaces the working card with the final result card", async () => {
    const db = store();
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const adapter = new FeishuAdapter({ appId: "id", appSecret: "secret", store: db, channel: { ...channel, updateCard } });

    await adapter.updateResult({ messageId: "status-message", chatId: "chat" }, {
      sessionId: "session", turnId: "turn", title: "Task", projectName: "app", status: "completed", summary: "Done", changedFileCount: 1, testSummary: "Passed", actionTokens: { diff: "d", logs: "l", continue: "c", newTask: "n" },
    });

    expect(updateCard).toHaveBeenCalledOnce();
    expect(updateCard.mock.calls[0]?.[0]).toBe("status-message");
    expect(JSON.stringify(updateCard.mock.calls[0]?.[1])).toContain("New task");
  });

  it("renders bounded status actions", () => {
    const card = statusCard({ sessionId: "s", turnId: "t", title: "Task", projectName: "app", phase: "working", startedAt: 0, updatedAt: 10_000, safeSummary: "Working", recentCommands: ["pnpm test"], actionTokens: { stop: "s", logs: "l", diff: "d" } });
    expect(JSON.stringify(card)).toContain("pnpm test");
    expect(JSON.stringify(card)).toContain("**Session:** s");
  });

  it("renders built-in instruction presets as callback choices", () => {
    const card = choiceCard({
      title: "Choose Codex instructions",
      actionKind: "instructions.select",
      choices: [{ label: "Plan", description: "Mode: plan\nReasoning: medium", token: "signed", value: "Plan" }],
    });
    const json = JSON.stringify(card);
    expect(json).toContain("instructions.select");
    expect(json).toContain("Reasoning: medium");
    expect(json).toContain("signed");
  });

  it("partitions each Codex reply in the status card", () => {
    const card = statusCard({ sessionId: "s", turnId: "t", title: "Task", projectName: "app", phase: "working", startedAt: 0, updatedAt: 10_000, safeSummary: "First reply\n\nSecond reply", replies: ["First reply", "Second reply"], recentCommands: [], actionTokens: { stop: "s", logs: "l", diff: "d" } });
    const json = JSON.stringify(card);
    expect(json.match(/"tag":"hr"/gu)).toHaveLength(3);
    expect(json).not.toContain("First reply\\n\\nSecond reply");
  });

  it("shows only the final Codex reply on a completed status card", () => {
    const card = statusCard({ sessionId: "s", turnId: "t", title: "Task", projectName: "app", phase: "completed", startedAt: 0, updatedAt: 10_000, safeSummary: "First reply\\n\\nFinal answer", replies: ["First reply", "Final answer"], recentCommands: [], actionTokens: { stop: "s", logs: "l", diff: "d" } });
    const json = JSON.stringify(card);
    expect(json).toContain("Final answer");
    expect(json).not.toContain("First reply");
  });
});
