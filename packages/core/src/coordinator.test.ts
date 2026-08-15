import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCapabilities, AgentDriver, AgentEvent, ApprovalId, ApprovalView, ChannelAction, ChannelCommand, ChoiceView, MessageRef, MessagingAdapter, OutputView, Project, QuestionView, SessionId, SessionOptions, SessionView, TurnId, TurnResultView, Unsubscribe } from "@pulsecortex/domain";
import { CommandLogStore, ControllerStore } from "@pulsecortex/persistence";
import { SessionCoordinator } from "./coordinator.js";

class FakeDriver implements AgentDriver {
  handlers = new Set<(event: AgentEvent) => void>();
  decisions: Array<{ id: string; decision: string }> = [];
  resumed: Array<{ id: SessionId; project: Project }> = [];
  started: Array<{ id: SessionId; prompt: string }> = [];
  steered: Array<{ id: SessionId; text: string }> = [];
  async start(): Promise<AgentCapabilities> { return { cliVersion: "0.147.0", protocolMajor: 2, userAgent: "fake", supportsSteer: true, supportsApprovals: true }; }
  async stop(): Promise<void> {}
  async createSession(_project: Project, _options: SessionOptions): Promise<SessionId> { return "session"; }
  async resumeSession(id: SessionId, project: Project): Promise<void> { this.resumed.push({ id, project }); }
  async startTurn(id: SessionId, prompt: string): Promise<TurnId> { this.started.push({ id, prompt }); return "turn"; }
  async steerTurn(id: SessionId, text: string): Promise<void> { this.steered.push({ id, text }); }
  async interruptTurn(_id: SessionId): Promise<void> {}
  async resolveApproval(id: ApprovalId, decision: "accept" | "decline" | "cancel"): Promise<void> { this.decisions.push({ id, decision }); }
  async resolveInput(_id: string, _answers: Record<string, string>): Promise<void> {}
  subscribe(handler: (event: AgentEvent) => void): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  emit(event: AgentEvent): void { for (const handler of this.handlers) handler(event); }
}

class FakeMessaging implements MessagingAdapter {
  command?: (command: ChannelCommand) => Promise<void>;
  action?: (action: ChannelAction) => Promise<void>;
  approvals: ApprovalView[] = [];
  statuses: SessionView[] = [];
  texts: string[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendStatus(view: SessionView): Promise<MessageRef> { this.statuses.push(view); return { messageId: "message", chatId: "chat" }; }
  async updateStatus(_ref: MessageRef, view: SessionView): Promise<void> { this.statuses.push(view); }
  async sendApproval(view: ApprovalView): Promise<MessageRef> { this.approvals.push(view); return { messageId: "approval", chatId: "chat" }; }
  async sendResult(_view: TurnResultView): Promise<void> {}
  async sendChoices(_view: ChoiceView): Promise<void> {}
  async sendQuestion(_view: QuestionView): Promise<void> {}
  async sendOutput(_view: OutputView): Promise<void> {}
  async sendText(text: string): Promise<void> { this.texts.push(text); }
  onCommand(handler: (command: ChannelCommand) => Promise<void>): void { this.command = handler; }
  onAction(handler: (action: ChannelAction) => Promise<void>): void { this.action = handler; }
}

const stores: ControllerStore[] = [];
const coordinators: SessionCoordinator[] = [];
afterEach(async () => { while (coordinators.length) await coordinators.pop()?.stop(); while (stores.length) stores.pop()?.close(); });

describe("session coordinator", () => {
  it("starts an allowlisted turn and consumes an owner-bound approval only once", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "m", messageId: "m", actor, name: "text", args: [], text: "do the work", receivedAt: Date.now() });
    expect(db.getSession("session")?.projectId).toBe(db.getProject("repo")?.id);
    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "approval", kind: "command", title: "Run tests", command: "pnpm test", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(1));
    const token = messaging.approvals[0]!.actionTokens.accept;
    const action: ChannelAction = { eventId: "a", actor, kind: "approval.accept", token, receivedAt: Date.now() };
    await messaging.action!(action);
    await messaging.action!({ ...action, eventId: "a-replay" });
    expect(driver.decisions).toEqual([{ id: "approval", decision: "accept" }]);
    expect(db.inspectAudit().some((row) => row["event_type"] === "action.rejected")).toBe(true);
  });

  it("sends a Feishu message to the addressed session only", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    db.createSession({ id: "target-session", projectId: project.id, title: "Target" });
    db.createSession({ id: "other-session", projectId: project.id, title: "Other" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "send", args: ["target-session", "do", "the", "work"], text: "/send target-session do the work\nwith  spacing", receivedAt: Date.now() });
    expect(driver.started).toEqual([{ id: "target-session", prompt: "do the work\nwith  spacing" }]);
    expect(driver.resumed[0]?.id).toBe("target-session");

    await messaging.command!({ eventId: "steer", messageId: "steer", actor, name: "send", args: ["target-session", "keep", "going"], text: "/send target-session keep going", receivedAt: Date.now() });
    expect(driver.steered).toEqual([{ id: "target-session", text: "keep going" }]);
    expect(messaging.texts).toContain("Message sent to target-session.");

    await messaging.command!({ eventId: "other", messageId: "other", actor, name: "send", args: ["other-session", "wrong", "target"], text: "/send other-session wrong target", receivedAt: Date.now() });
    expect(driver.steered).toHaveLength(1);
    expect(messaging.texts.at(-1)).toContain("target-session");
  });
});
