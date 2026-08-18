import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCapabilities, AgentDriver, AgentEvent, AgentInstructionPreset, AgentSessionInfo, ApprovalId, ApprovalResolutionView, ApprovalView, ChannelAction, ChannelCommand, ChoiceView, MessageRef, MessagingAdapter, OutputView, Project, QuestionView, SessionId, SessionOptions, SessionView, TurnId, TurnResultView, Unsubscribe } from "@pulsecortex/domain";
import { CommandLogStore, ControllerStore } from "@pulsecortex/persistence";
import { SessionCoordinator } from "./coordinator.js";

class FakeDriver implements AgentDriver {
  handlers = new Set<(event: AgentEvent) => void>();
  decisions: Array<{ id: string; decision: string }> = [];
  resumed: Array<{ id: SessionId; project: Project }> = [];
  started: Array<{ id: SessionId; prompt: string }> = [];
  steered: Array<{ id: SessionId; text: string }> = [];
  instructionPresets: AgentInstructionPreset[] = [{ id: "Plan", label: "Plan", mode: "plan", reasoningEffort: "medium" }, { id: "Default", label: "Default", mode: "default" }];
  selectedInstructionPresets: Array<{ id: SessionId; presetId: string }> = [];
  discovered: AgentSessionInfo[] = [];
  resumeError: Error | null = null;
  async start(): Promise<AgentCapabilities> { return { cliVersion: "0.147.0", protocolMajor: 2, userAgent: "fake", supportsSteer: true, supportsApprovals: true, supportsNamespaceTools: true }; }
  async stop(): Promise<void> {}
  async createSession(_project: Project, _options: SessionOptions): Promise<SessionId> { return "session"; }
  async resumeSession(id: SessionId, project: Project): Promise<void> { this.resumed.push({ id, project }); if (this.resumeError) throw this.resumeError; }
  async listSessions(_projects: Project[]): Promise<AgentSessionInfo[]> { return this.discovered; }
  async listInstructionPresets(): Promise<AgentInstructionPreset[]> { return this.instructionPresets; }
  async selectInstructionPreset(id: SessionId, presetId: string): Promise<AgentInstructionPreset> {
    this.selectedInstructionPresets.push({ id, presetId });
    const preset = this.instructionPresets.find((candidate) => candidate.id === presetId);
    if (!preset) throw new Error("missing preset");
    return preset;
  }
  async startTurn(id: SessionId, prompt: string): Promise<TurnId> { this.started.push({ id, prompt }); return this.started.length === 1 ? "turn" : `turn-${this.started.length}`; }
  async steerTurn(id: SessionId, text: string): Promise<void> { this.steered.push({ id, text }); }
  async interruptTurn(_id: SessionId): Promise<void> {}
  async resolveApproval(id: ApprovalId, decision: "accept" | "acceptForSession" | "decline" | "cancel"): Promise<void> { this.decisions.push({ id, decision }); }
  async resolveInput(_id: string, _answers: Record<string, string>): Promise<void> {}
  subscribe(handler: (event: AgentEvent) => void): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  emit(event: AgentEvent): void { for (const handler of this.handlers) handler(event); }
}

class FakeMessaging implements MessagingAdapter {
  command?: (command: ChannelCommand) => Promise<void>;
  action?: (action: ChannelAction) => Promise<void>;
  approvals: ApprovalView[] = [];
  approvalUpdates: ApprovalResolutionView[] = [];
  approvalUpdateRefs: MessageRef[] = [];
  approvalRemovalRefs: MessageRef[] = [];
  statuses: SessionView[] = [];
  choices: ChoiceView[] = [];
  results: TurnResultView[] = [];
  resultUpdateRefs: MessageRef[] = [];
  outputs: OutputView[] = [];
  texts: string[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendStatus(view: SessionView): Promise<MessageRef> { this.statuses.push(view); return { messageId: "message", chatId: "chat" }; }
  async updateStatus(_ref: MessageRef, view: SessionView): Promise<void> { this.statuses.push(view); }
  async sendApproval(view: ApprovalView): Promise<MessageRef> { this.approvals.push(view); return { messageId: view.approvalId, chatId: "chat" }; }
  async updateApproval(ref: MessageRef, view: ApprovalResolutionView): Promise<void> { this.approvalUpdateRefs.push(ref); this.approvalUpdates.push(view); }
  async removeApproval(ref: MessageRef): Promise<void> { this.approvalRemovalRefs.push(ref); }
  async sendResult(view: TurnResultView): Promise<void> { this.results.push(view); }
  async updateResult(ref: MessageRef, view: TurnResultView): Promise<void> { this.resultUpdateRefs.push(ref); this.results.push(view); }
  async sendChoices(view: ChoiceView): Promise<void> { this.choices.push(view); }
  async sendQuestion(_view: QuestionView): Promise<void> {}
  async sendOutput(view: OutputView): Promise<void> { this.outputs.push(view); }
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
    expect(messaging.approvalUpdates).toEqual([expect.objectContaining({ title: "Run tests", decision: "accept" })]);
    expect(messaging.approvalRemovalRefs).toEqual([]);
    expect(db.inspectAudit().some((row) => row["event_type"] === "action.rejected")).toBe(true);
  });

  it("cancels a pending approval card when Codex resolves the request", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "run a command", receivedAt: Date.now() });
    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "withdrawn", kind: "command", title: "Run command", command: "pnpm test", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(1));

    driver.emit({ type: "request.resolved", sessionId: "session", turnId: "turn", requestId: "withdrawn", occurredAt: Date.now() });

    await vi.waitFor(() => expect(messaging.approvalUpdates).toContainEqual(expect.objectContaining({ title: "Run command", decision: "cancel" })));
    await vi.waitFor(() => expect(messaging.statuses.at(-1)?.phase).toBe("working"));
    expect(db.inspectAudit().some((row) => row["event_type"] === "request.resolved")).toBe(true);
  });

  it("updates the starting card when Codex starts during its initial send", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const originalSendStatus = messaging.sendStatus.bind(messaging);
    messaging.sendStatus = async (view) => { sendStarted(); await sendGate; return originalSendStatus(view); };
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    const starting = messaging.command!({ eventId: "start-race", messageId: "start-race", actor, name: "text", args: [], text: "work", receivedAt: Date.now() });
    await started;
    driver.emit({ type: "turn.started", sessionId: "session", turnId: "turn", occurredAt: Date.now() });
    releaseSend();
    await starting;
    await vi.waitFor(() => expect(messaging.statuses.at(-1)?.phase).toBe("working"));
    expect(messaging.statuses.map((view) => view.phase)).toEqual(["starting", "working"]);
  });

  it("enables Codex auto approve from command cards only", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "run commands", receivedAt: Date.now() });

    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "command", kind: "command", title: "Run command", command: "pnpm test", canAutoApprove: true, occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(1));
    const autoApprove = messaging.approvals[0]!.actionTokens.autoApprove;
    expect(autoApprove).toBeTruthy();
    await messaging.action!({ eventId: "auto", actor, kind: "approval.acceptForSession", token: autoApprove!, receivedAt: Date.now() });

    expect(driver.decisions).toEqual([{ id: "command", decision: "acceptForSession" }]);
    expect(messaging.approvalUpdates).toEqual([expect.objectContaining({ decision: "acceptForSession" })]);

    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "network", kind: "network", title: "Network access", network: [{ host: "example.com", protocol: "https" }], canAutoApprove: false, occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(2));
    expect(messaging.approvals[1]!.actionTokens.autoApprove).toBeUndefined();
  });

  it.each([
    ["accept", "approval.accept"],
    ["decline", "approval.decline"],
  ] as const)("keeps a pending approval actionable after /send (%s)", async (decision, actionKind) => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "run a command", receivedAt: Date.now() });
    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "approval", kind: "command", title: "Run command", command: "pnpm test", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(1));

    await messaging.command!({ eventId: "send", messageId: "send", actor, name: "send", args: ["follow", "up"], text: "/send follow up", receivedAt: Date.now() });

    expect(driver.steered).toHaveLength(0);
    expect(messaging.texts.at(-1)).toContain("pending approval card");
    const token = decision === "accept" ? messaging.approvals[0]!.actionTokens.accept : messaging.approvals[0]!.actionTokens.decline;
    await messaging.action!({ eventId: decision, actor, kind: actionKind, token, receivedAt: Date.now() });
    expect(driver.decisions).toEqual([{ id: "approval", decision }]);
    expect(messaging.approvalUpdates).toEqual([expect.objectContaining({ title: "Run command", decision })]);
  });

  it("keeps a pending approval actionable after its card token expires", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start-expired", messageId: "start-expired", actor, name: "text", args: [], text: "run a command", receivedAt: Date.now() });
    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "approval-expired", kind: "command", title: "Run command", command: "pnpm test", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(1));
    const token = messaging.approvals[0]!.actionTokens.accept;
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      vi.advanceTimersByTime(61_000);
      await messaging.action!({ eventId: "approve-expired", actor, kind: "approval.accept", token, receivedAt: Date.now() });
    } finally {
      vi.useRealTimers();
    }
    expect(driver.decisions).toEqual([{ id: "approval-expired", decision: "accept" }]);
  });

  it("resolves multiple simultaneous approvals and updates each card", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "run both commands", receivedAt: Date.now() });

    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "first", kind: "command", title: "Run first command", command: "pnpm test", occurredAt: Date.now() });
    driver.emit({ type: "approval.requested", sessionId: "session", turnId: "turn", approvalId: "second", kind: "command", title: "Run second command", command: "pnpm build", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.approvals).toHaveLength(2));

    await messaging.action!({ eventId: "approve-first", actor, kind: "approval.accept", token: messaging.approvals[0]!.actionTokens.accept, receivedAt: Date.now() });
    expect(messaging.statuses.at(-1)?.phase).toBe("awaiting_approval");
    await messaging.action!({ eventId: "approve-second", actor, kind: "approval.accept", token: messaging.approvals[1]!.actionTokens.accept, receivedAt: Date.now() });

    expect(driver.decisions).toEqual([{ id: "first", decision: "accept" }, { id: "second", decision: "accept" }]);
    expect(messaging.approvalUpdates).toEqual([
      expect.objectContaining({ title: "Run first command", decision: "accept" }),
      expect.objectContaining({ title: "Run second command", decision: "accept" }),
    ]);
    expect(messaging.approvalUpdateRefs.map((ref) => ref.messageId)).toEqual(["first", "second"]);
    expect(messaging.statuses.at(-1)?.phase).toBe("working");
  });

  it("keeps separate Codex replies in the status view", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "work", receivedAt: Date.now() });

    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply-1", delta: "First ", occurredAt: Date.now() });
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply-1", delta: "reply", occurredAt: Date.now() });
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply-2", delta: "Second reply", occurredAt: Date.now() });
    await messaging.command!({ eventId: "status", messageId: "status", actor, name: "status", args: [], text: "/status", receivedAt: Date.now() });

    expect(messaging.statuses.at(-1)?.replies).toEqual(["First reply", "Second reply"]);
  });

  it("uses only the last Codex reply as the completed result", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "work", receivedAt: Date.now() });
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply-1", delta: "Progress update", occurredAt: Date.now() });
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply-2", delta: "Final answer", occurredAt: Date.now() });
    driver.emit({ type: "turn.completed", sessionId: "session", turnId: "turn", status: "completed", occurredAt: Date.now() });

    await vi.waitFor(() => expect(messaging.results).toHaveLength(1));
    expect(messaging.results[0]?.summary).toBe("Final answer");
  });

  it("opens logs for the result card's turn after the session advances", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "first", messageId: "first", actor, name: "text", args: [], text: "first task", receivedAt: Date.now() });
    await logs.append("turn", "stdout", "first turn output\n");
    driver.emit({ type: "turn.completed", sessionId: "session", turnId: "turn", status: "completed", occurredAt: Date.now() });
    await vi.waitFor(() => expect(messaging.results).toHaveLength(1));
    expect(messaging.resultUpdateRefs).toEqual([{ messageId: "message", chatId: "chat" }]);
    expect(messaging.statuses.some((view) => view.phase === "completed")).toBe(false);
    const oldLogsToken = messaging.results[0]!.actionTokens.logs;

    await messaging.command!({ eventId: "second", messageId: "second", actor, name: "text", args: [], text: "second task", receivedAt: Date.now() });
    await logs.append("turn-2", "stdout", "second turn output\n");
    await messaging.action!({ eventId: "old-logs", actor, kind: "logs.show", token: oldLogsToken, receivedAt: Date.now() });

    expect(messaging.outputs.at(-1)?.content).toBe("first turn output\n");
  });

  it("combines Codex messages and commands in chronological logs", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "start", messageId: "start", actor, name: "text", args: [], text: "work", receivedAt: Date.now() });
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply", delta: "I will run tests.\n", occurredAt: Date.now() });
    driver.emit({ type: "command.started", sessionId: "session", turnId: "turn", commandId: "command", command: "pnpm test", occurredAt: Date.now() });
    await logs.append("turn", "stdout", "all tests passed\n");
    driver.emit({ type: "agent.message.delta", sessionId: "session", turnId: "turn", messageId: "reply", delta: "The tests are green.\n", occurredAt: Date.now() });

    await vi.waitFor(async () => expect(await logs.read("turn")).toBe("I will run tests.\n$ pnpm test\nall tests passed\nThe tests are green.\n"));
  });

  it("runs and addresses multiple Codex sessions independently", async () => {
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
    expect(driver.started.at(-1)).toEqual({ id: "other-session", prompt: "wrong target" });

    await messaging.command!({ eventId: "selected", messageId: "selected", actor, name: "text", args: [], text: "message the selected session", receivedAt: Date.now() });
    expect(driver.steered.at(-1)).toEqual({ id: "other-session", text: "message the selected session" });
  });

  it("discovers and steers an allowlisted Codex session started by another client", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "live-codex", projectId: project.id, title: "Current Codex", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "live-turn", createdAt: 1, updatedAt: 2, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "sessions", messageId: "sessions", actor, name: "sessions", args: [], text: "/sessions", receivedAt: Date.now() });
    expect(db.getSession("live-codex")).toMatchObject({ botCreated: false, state: "working", lastTurnId: "live-turn" });
    const choice = messaging.choices[0]!.choices[0]!;
    expect(choice.value).toBe("live-codex");
    expect(driver.resumed[0]?.id).toBe("live-codex");

    await messaging.action!({ eventId: "select-live", actor, kind: "session.select", token: choice.token, receivedAt: Date.now() });
    await messaging.command!({ eventId: "send-live", messageId: "send-live", actor, name: "send", args: ["phone", "message"], text: "/send phone message", receivedAt: Date.now() });
    expect(driver.steered.at(-1)).toEqual({ id: "live-codex", text: "phone message" });
  });

  it("selects and announces the sole running Codex session during startup", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "startup-codex", projectId: project.id, title: "Already running", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "startup-turn", createdAt: 1, updatedAt: 2, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await coordinator.initialize();

    expect(messaging.texts.at(-1)).toContain("Using running Codex session Already running in repo");
    expect(messaging.texts.at(-1)).toContain("/send <message>");
    await messaging.command!({ eventId: "send-default", messageId: "send-default", actor, name: "send", args: ["continue", "work"], text: "/send continue work", receivedAt: Date.now() });
    expect(driver.steered.at(-1)).toEqual({ id: "startup-codex", text: "continue work" });
  });

  it("restores the last project and uses it for the first task after startup", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("other", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const project = db.addProject("remembered", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.setLocalSetting("defaultProject", project.name);
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await coordinator.initialize();
    await messaging.command!({ eventId: "first-task", messageId: "first-task", actor, name: "text", args: [], text: "continue where I left off", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started.at(-1)).toEqual({ id: "session", prompt: "continue where I left off" });
  });

  it("creates a new session for /send when no session is selected", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("remembered", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.setLocalSetting("defaultProject", project.name);
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "send-new", messageId: "send-new", actor, name: "send", args: ["start", "fresh"], text: "/send start fresh\nwith details", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started).toEqual([{ id: "session", prompt: "start fresh\nwith details" }]);
  });

  it("creates a new session after choosing a project for /send", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const first = db.addProject("first", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const second = db.addProject("second", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.createSession({ id: "existing-first", projectId: first.id, title: "Existing first session" });
    db.createSession({ id: "existing", projectId: second.id, title: "Existing session" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [
      { id: "existing-first", projectId: first.id, title: "Existing first session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false },
      { id: "existing", projectId: second.id, title: "Existing session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false },
    ];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "send-new", messageId: "send-new", actor, name: "send", args: ["start", "fresh"], text: "/send start fresh", receivedAt: Date.now() });
    expect(messaging.choices.at(-1)?.description).toBe("Choose the project for this new session.");
    const choice = messaging.choices.at(-1)!.choices.find((item) => item.value === second.id)!;
    await messaging.action!({ eventId: "choose-second", actor, kind: "project.select", token: choice.token, receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(second.id);
    expect(driver.started.at(-1)).toEqual({ id: "session", prompt: "start fresh" });
    expect(driver.started.some((turn) => turn.id === "existing")).toBe(false);
  });

  it("opens the project card and retains the task when /new needs a project", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("first", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const second = db.addProject("second", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "new", messageId: "new", actor, name: "new", args: ["implement", "the", "feature"], text: "/new implement the feature", receivedAt: Date.now() });

    expect(messaging.texts.some((text) => text.includes("Unknown project"))).toBe(false);
    expect(messaging.choices.at(-1)?.description).toBe("Choose the project for this new session.");
    const choice = messaging.choices.at(-1)!.choices.find((item) => item.value === second.id)!;
    await messaging.action!({ eventId: "choose-second", actor, kind: "project.select", token: choice.token, receivedAt: Date.now() });
    expect(db.getSession("session")?.projectId).toBe(second.id);
    expect(driver.started).toEqual([{ id: "session", prompt: "implement the feature" }]);
  });

  it("creates an empty new session after choosing a project for bare /new", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.addProject("other", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.createSession({ id: "existing", projectId: project.id, title: "Existing session" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "existing", projectId: project.id, title: "Existing session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "new", messageId: "new", actor, name: "new", args: [], text: "/new", receivedAt: Date.now() });
    const choice = messaging.choices.at(-1)!.choices.find((item) => item.value === project.id)!;
    await messaging.action!({ eventId: "choose-project", actor, kind: "project.select", token: choice.token, receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started).toHaveLength(0);
    expect(messaging.texts.at(-1)).toBe("Session created for repo. Send the task when ready.");
  });

  it("prefers a running session from the remembered project during startup", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("remembered", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const other = db.addProject("other", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    db.setLocalSetting("defaultProject", project.name);
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [
      { id: "remembered-session", projectId: project.id, title: "Remembered session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false },
      { id: "other-session", projectId: other.id, title: "Other session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 3, botCreated: false },
    ];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await coordinator.initialize();
    await messaging.command!({ eventId: "send-remembered", messageId: "send-remembered", actor, name: "send", args: ["hello"], text: "/send hello", receivedAt: Date.now() });

    expect(messaging.texts.some((text) => text.includes("Remembered session in remembered"))).toBe(true);
    expect(driver.started.at(-1)).toEqual({ id: "remembered-session", prompt: "hello" });
  });

  it("detects an idle controllable Codex session launched after startup", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);
    await coordinator.initialize();

    driver.discovered = [{ id: "idle-codex", projectId: project.id, title: "Idle terminal", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 3, botCreated: false }];
    await coordinator.syncRunningSessions();

    expect(messaging.texts.at(-1)).toContain("Using running Codex session Idle terminal in repo");
    await messaging.command!({ eventId: "send-idle", messageId: "send-idle", actor, name: "send", args: ["start", "from", "Feishu"], text: "/send start from Feishu", receivedAt: Date.now() });
    expect(driver.started.at(-1)).toEqual({ id: "idle-codex", prompt: "start from Feishu" });
  });

  it("makes a newly launched Codex the default when another session was selected", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    db.createSession({ id: "previous-default", projectId: project.id, title: "Previous default" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "resume-old", messageId: "resume-old", actor, name: "resume", args: ["previous-default"], text: "/resume previous-default", receivedAt: Date.now() });
    driver.discovered = [{ id: "new-working-codex", projectId: project.id, title: "New working Codex", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "new-turn", createdAt: 1, updatedAt: 3, botCreated: false }];

    await coordinator.syncRunningSessions();

    expect(messaging.texts.at(-1)).toContain("Using running Codex session New working Codex in repo");
    await messaging.command!({ eventId: "send-new-default", messageId: "send-new-default", actor, name: "send", args: ["continue", "from", "Feishu"], text: "/send continue from Feishu", receivedAt: Date.now() });
    expect(driver.steered.at(-1)).toEqual({ id: "new-working-codex", text: "continue from Feishu" });
  });

  it("creates a new session when only an uncontrollable standalone session exists", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "foreign-codex", projectId: project.id, title: "Foreign runtime", state: "working", loaded: false, canAcceptDirectInput: false, createdAt: 1, updatedAt: 3, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await coordinator.initialize();
    expect(messaging.texts.at(-1)).toContain("launched outside the PulseCortex shared app-server");
    expect(messaging.texts.at(-1)).toContain("pnpm pulsectl codex repo");
    await messaging.command!({ eventId: "projects-foreign", messageId: "projects-foreign", actor, name: "projects", args: [], text: "/projects", receivedAt: Date.now() });
    await messaging.action!({ eventId: "choose-foreign", actor, kind: "project.select", token: messaging.choices[0]!.choices[0]!.token, receivedAt: Date.now() });
    expect(messaging.texts.at(-1)).toContain("cannot receive Feishu messages");
    expect(db.getSession("session")).toBeNull();
    await messaging.command!({ eventId: "send-foreign", messageId: "send-foreign", actor, name: "send", args: ["hello"], text: "/send hello", receivedAt: Date.now() });
    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.steered).toHaveLength(0);
    expect(driver.started).toEqual([{ id: "session", prompt: "hello" }]);
  });

  it("uses a running session in the chosen project as the default", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const otherProject = db.addProject("other", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [
      { id: "chosen-codex", projectId: project.id, title: "Chosen project session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 3, botCreated: false },
      { id: "older-codex", projectId: project.id, title: "Older project session", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "older-turn", createdAt: 1, updatedAt: 2, botCreated: false },
      { id: "other-codex", projectId: otherProject.id, title: "Other project session", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "other-turn", createdAt: 1, updatedAt: 4, botCreated: false },
    ];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "projects", messageId: "projects", actor, name: "projects", args: [], text: "/projects", receivedAt: Date.now() });
    const projectChoice = messaging.choices[0]!.choices.find((choice) => choice.value === project.id)!;
    await messaging.action!({ eventId: "choose-project", actor, kind: "project.select", token: projectChoice.token, receivedAt: Date.now() });

    expect(messaging.texts.at(-1)).toContain("Using running Codex session Chosen project session in repo");
    expect(db.getLocalSettings().defaultProject).toBe(project.name);
    expect(db.getSession("session")).toBeNull();
    await messaging.command!({ eventId: "send-project", messageId: "send-project", actor, name: "send", args: ["project", "follow-up"], text: "/send project follow-up", receivedAt: Date.now() });
    expect(driver.started.at(-1)).toEqual({ id: "chosen-codex", prompt: "project follow-up" });
  });

  it("creates a new session in the chosen project without repeating its name", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "selected-session", projectId: project.id, title: "Selected session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "projects", messageId: "projects", actor, name: "projects", args: [], text: "/projects", receivedAt: Date.now() });
    await messaging.action!({ eventId: "choose-project", actor, kind: "project.select", token: messaging.choices[0]!.choices[0]!.token, receivedAt: Date.now() });
    await messaging.command!({ eventId: "new", messageId: "new", actor, name: "new", args: ["implement", "the", "feature"], text: "/new implement the feature", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started.at(-1)).toEqual({ id: "session", prompt: "implement the feature" });
  });

  it("creates an empty new session in the chosen project", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "selected-session", projectId: project.id, title: "Selected session", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "projects", messageId: "projects", actor, name: "projects", args: [], text: "/projects", receivedAt: Date.now() });
    await messaging.action!({ eventId: "choose-project", actor, kind: "project.select", token: messaging.choices[0]!.choices[0]!.token, receivedAt: Date.now() });
    await messaging.command!({ eventId: "new", messageId: "new", actor, name: "new", args: [], text: "/new", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started).toHaveLength(0);
    expect(messaging.texts.at(-1)).toBe("Session created for repo. Send the task when ready.");
  });

  it("refreshes a stored session before sending when another client started its turn", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    db.createSession({ id: "stored-live", projectId: project.id, title: "Stored session" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.discovered = [{ id: "stored-live", projectId: project.id, title: "Stored session", state: "working", loaded: true, canAcceptDirectInput: true, activeTurnId: "terminal-turn", createdAt: 1, updatedAt: 2, botCreated: true }];
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "send-live", messageId: "send-live", actor, name: "send", args: ["stored-live", "from", "phone"], text: "/send stored-live from phone", receivedAt: Date.now() });

    expect(driver.started).toHaveLength(0);
    expect(driver.steered).toEqual([{ id: "stored-live", text: "from phone" }]);
  });

  it("paginates session choices three at a time and bounds preview text", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const longTitle = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    for (let index = 0; index < 5; index += 1) db.createSession({ id: `session-${index}`, projectId: project.id, title: index === 0 ? longTitle : `Session ${index}` });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "sessions", messageId: "sessions", actor, name: "sessions", args: [], text: "/sessions", receivedAt: Date.now() });
    expect(messaging.choices[0]?.choices).toHaveLength(3);
    expect(messaging.choices[0]?.nextToken).toBeTruthy();
    expect(Math.max(...messaging.choices[0]!.choices.map((choice) => choice.label.split(/\s+/u).length))).toBeLessThanOrEqual(100);

    await messaging.action!({ eventId: "more", actor, kind: "sessions.more", token: messaging.choices[0]!.nextToken!, receivedAt: Date.now() });
    expect(messaging.choices[1]?.choices).toHaveLength(2);
    expect(messaging.choices[1]?.nextToken).toBeUndefined();
    expect(messaging.choices[1]?.previousToken).toBeTruthy();
    const truncated = messaging.choices.flatMap((view) => view.choices).find((choice) => choice.value === "session-0")!.label;
    expect(truncated.split(/\s+/u)).toHaveLength(100);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("selects Codex built-in instructions for the chosen session", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver();
    driver.discovered = [{ id: "instruction-session", projectId: project.id, title: "Instruction task", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false }];
    const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "sessions", messageId: "sessions", actor, name: "sessions", args: [], text: "/sessions", receivedAt: Date.now() });
    await messaging.action!({ eventId: "select-session", actor, kind: "session.select", token: messaging.choices[0]!.choices[0]!.token, receivedAt: Date.now() });
    await messaging.command!({ eventId: "instructions", messageId: "instructions", actor, name: "instructions", args: [], text: "/instructions", receivedAt: Date.now() });

    const presetCard = messaging.choices.at(-1)!;
    expect(presetCard).toMatchObject({ title: "Choose Codex instructions", actionKind: "instructions.select" });
    expect(presetCard.choices.map((choice) => choice.label)).toEqual(["Plan", "Default"]);
    await messaging.action!({ eventId: "select-plan", actor, kind: "instructions.select", token: presetCard.choices[0]!.token, receivedAt: Date.now() });
    expect(driver.selectedInstructionPresets).toEqual([{ id: "instruction-session", presetId: "Plan" }]);
    expect(messaging.texts.at(-1)).toContain("Using Codex's Plan instructions");
  });

  it("creates a session before showing instructions when none exist", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "instructions", messageId: "instructions", actor, name: "instructions", args: [], text: "/instruction", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(driver.started).toHaveLength(0);
    expect(messaging.texts).toHaveLength(0);
    expect(messaging.choices.at(-1)).toMatchObject({ title: "Choose Codex instructions", actionKind: "instructions.select" });
    expect(messaging.choices.at(-1)?.description).toContain("New repo task");
  });

  it("creates a new session for instructions when existing sessions are not selected", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver();
    driver.discovered = [
      { id: "existing-one", projectId: project.id, title: "Existing one", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, botCreated: false },
      { id: "existing-two", projectId: project.id, title: "Existing two", state: "idle", loaded: true, canAcceptDirectInput: true, createdAt: 1, updatedAt: 3, botCreated: false },
    ];
    const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "instructions", messageId: "instructions", actor, name: "instructions", args: [], text: "/instructions", receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(project.id);
    expect(messaging.texts).toHaveLength(0);
    expect(messaging.choices.at(-1)).toMatchObject({
      title: "Choose Codex instructions",
      description: expect.stringContaining("New repo task"),
    });
  });

  it("shows instructions after choosing a project when no sessions exist", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    db.addProject("first", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const second = db.addProject("second", await mkdtemp(path.join(os.tmpdir(), "pulse-project-")));
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "instructions", messageId: "instructions", actor, name: "instructions", args: [], text: "/instruction", receivedAt: Date.now() });
    expect(messaging.choices.at(-1)).toMatchObject({ title: "Choose a project", description: "Choose the project for this new session." });
    const projectChoice = messaging.choices.at(-1)!.choices.find((choice) => choice.value === second.id)!;
    await messaging.action!({ eventId: "choose-second", actor, kind: "project.select", token: projectChoice.token, receivedAt: Date.now() });

    expect(db.getSession("session")?.projectId).toBe(second.id);
    expect(messaging.choices.at(-1)).toMatchObject({ title: "Choose Codex instructions", actionKind: "instructions.select" });
    expect(messaging.texts).toHaveLength(0);
  });

  it("reports a session owned by another Codex runtime instead of failing silently", async () => {
    const db = new ControllerStore(":memory:"); stores.push(db);
    const { code } = db.createPairingCode();
    const actor = { tenantId: "tenant", userId: "owner", chatId: "chat", chatType: "p2p" as const };
    db.consumePairingCode(code, actor); db.setOwnerChat(actor, actor.chatId);
    const project = db.addProject("repo", process.cwd());
    db.createSession({ id: "foreign", projectId: project.id, title: "Foreign session" });
    const logs = new CommandLogStore(await mkdtemp(path.join(os.tmpdir(), "pulse-logs-")));
    const driver = new FakeDriver(); const messaging = new FakeMessaging();
    driver.resumeError = new Error("thread foreign already has an active writer");
    const coordinator = new SessionCoordinator(db, logs, driver, messaging, "x".repeat(32), { statusUpdateIntervalMs: 10_000, approvalTtlMs: 60_000 }, pino({ level: "silent" }));
    coordinators.push(coordinator);

    await messaging.command!({ eventId: "sessions", messageId: "sessions", actor, name: "sessions", args: [], text: "/sessions", receivedAt: Date.now() });
    const choice = messaging.choices[0]!.choices[0]!;
    await messaging.action!({ eventId: "select", actor, kind: "session.select", token: choice.token, receivedAt: Date.now() });

    expect(messaging.texts.at(-1)).toContain("open in a separate Codex runtime");
    expect(db.inspectAudit().some((row) => row["event_type"] === "session.select.failed")).toBe(true);
  });
});
