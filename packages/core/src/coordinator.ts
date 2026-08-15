import type { Logger } from "pino";
import {
  isActiveState,
  paginate,
  redact,
  type AgentDriver,
  type AgentEvent,
  type ApprovalView,
  type ChannelAction,
  type ChannelCommand,
  type ChoiceView,
  type MessagingAdapter,
  type MessageRef,
  type OutputView,
  type Project,
  type QuestionView,
  type SessionView,
  type StoredSession,
  type TurnPhase,
  type TurnResultView,
} from "@pulsecortex/domain";
import { ActionTokenService, CommandLogStore, ControllerStore, type InteractionRecord } from "@pulsecortex/persistence";

interface CoordinatorOptions {
  statusUpdateIntervalMs: number;
  approvalTtlMs: number;
  redactionPatterns?: RegExp[];
}

interface PendingInputState {
  requestId: string;
  questions: AgentEvent & { type: "input.requested" } extends infer E ? E extends { questions: infer Q } ? Q : never : never;
  answers: Record<string, string>;
}

interface RuntimeTurn {
  session: StoredSession;
  project: Project;
  turnId: string;
  phase: TurnPhase;
  startedAt: number;
  safeSummary: string;
  recentCommands: string[];
  diff: string;
  changedFileCount: number;
  testSummary: string;
  statusRef: MessageRef | null;
  actionTokens: SessionView["actionTokens"];
  pendingApproval?: { id: string; kind: ApprovalView["kind"]; summary: string };
  pendingInput?: PendingInputState;
  dirty: boolean;
}

type DeliveryKind = "text" | "status" | "status.update" | "approval" | "result" | "choices" | "question" | "output";

const HELP = `PulseCortex commands:
/projects - choose a locally registered project
/new <project> [task] - create a bot-owned Codex session
/sessions - list bot-created sessions
/resume [session-id] - resume a session
/send <session-id> <message> - message a specific session
/status - show the active turn
/stop - interrupt the active turn
/logs - show bounded command output
/diff - show the current unified diff
/help - show this help

Ordinary direct messages start work or steer the active turn.`;

export class SessionCoordinator {
  private runtime: RuntimeTurn | null = null;
  private selectedSession: StoredSession | null = null;
  private pendingPrompt: string | null = null;
  private readonly tokens: ActionTokenService;
  private readonly redactions: RegExp[];
  private readonly statusTimer: NodeJS.Timeout;
  private readonly deliveryTimer: NodeJS.Timeout;
  private statusFlush: Promise<void> | null = null;
  private driverRestart: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly store: ControllerStore,
    private readonly commandLogs: CommandLogStore,
    private readonly driver: AgentDriver,
    private readonly messaging: MessagingAdapter,
    signingKey: string,
    private readonly options: CoordinatorOptions,
    private readonly logger: Logger,
  ) {
    this.tokens = new ActionTokenService(store, signingKey);
    this.redactions = options.redactionPatterns ?? [];
    this.messaging.onCommand(async (command) => this.handleCommand(command));
    this.messaging.onAction(async (action) => this.handleAction(action));
    this.driver.subscribe((event) => { void this.handleAgentEvent(event).catch((error) => this.logger.error({ err: error }, "agent event handling failed")); });
    this.statusTimer = setInterval(() => { void this.flushStatus(); }, options.statusUpdateIntervalMs);
    this.statusTimer.unref();
    this.deliveryTimer = setInterval(() => { void this.flushDeliveries(); }, 5_000);
    this.deliveryTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.statusTimer);
    clearInterval(this.deliveryTimer);
    await this.statusFlush;
  }

  async handleCommand(command: ChannelCommand): Promise<void> {
    if (command.actor.chatType !== "p2p") return;
    if (command.name === "pair") { await this.handlePair(command); return; }
    if (!this.store.isOwner(command.actor)) return;
    this.store.setOwnerChat(command.actor, command.actor.chatId);
    switch (command.name) {
      case "projects": await this.sendProjectChoices(); break;
      case "new": await this.handleNew(command.args); break;
      case "sessions": await this.sendSessionChoices(); break;
      case "resume": await this.handleResume(command.args[0]); break;
      case "send": await this.handleSend(command); break;
      case "status": await this.handleStatus(); break;
      case "stop": await this.stopActiveTurn("command"); break;
      case "logs": await this.sendPagedOutput("logs.show", this.runtime?.session.id ?? this.selectedSession?.id, 1); break;
      case "diff": await this.sendPagedOutput("diff.show", this.runtime?.session.id ?? this.selectedSession?.id, 1); break;
      case "help": await this.safeSend("text", HELP, () => this.messaging.sendText(HELP)); break;
      case "unknown": await this.safeSend("text", "Unknown command. Use /help.", () => this.messaging.sendText("Unknown command. Use /help.")); break;
      case "text": await this.handleText(command.text); break;
      default: break;
    }
  }

  async handleAction(action: ChannelAction): Promise<void> {
    if (!this.store.isOwner(action.actor)) return;
    const record = this.tokens.consume(action.token, action.actor, action.kind);
    if (!record) { this.store.audit({ eventType: "action.rejected", summary: `Stale, forged, or replayed action ${action.kind}`, actor: action.actor }); return; }
    this.store.audit({ eventType: "action.consumed", summary: action.kind, actor: action.actor, sessionId: record.sessionId, turnId: record.turnId });
    switch (action.kind) {
      case "approval.accept": await this.resolveApproval(record, "accept", action.actor); break;
      case "approval.decline": await this.resolveApproval(record, "decline", action.actor); break;
      case "turn.stop": await this.stopActiveTurn("action", record); break;
      case "logs.show": await this.sendPagedOutput("logs.show", record.sessionId, Number(record.payload["page"] ?? 1)); break;
      case "diff.show": await this.sendPagedOutput("diff.show", record.sessionId, Number(record.payload["page"] ?? 1)); break;
      case "project.select": await this.selectProject(record.requestId); break;
      case "session.select": await this.resumeStoredSession(record.requestId); break;
      case "session.continue": await this.resumeStoredSession(record.sessionId); break;
      case "task.new": await this.sendProjectChoices(); break;
      case "input.answer": await this.answerStructuredInput(record); break;
    }
  }

  async flushDeliveries(): Promise<void> {
    if (this.stopped) return;
    for (const delivery of this.store.pendingDeliveries()) {
      try {
        await this.deliver(delivery.kind as DeliveryKind, delivery.payload as Record<string, unknown>);
        this.store.completeDelivery(delivery.id);
        this.store.audit({ eventType: "delivery.succeeded", summary: `${delivery.kind} delivered after ${delivery.attempts} retries` });
      } catch (error) {
        const delay = Math.min(300_000, 1_000 * 2 ** Math.min(8, delivery.attempts)) * (0.5 + Math.random() * 0.5);
        const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
        this.store.failDelivery(delivery.id, errorMessage, Date.now() + delay);
        this.logger.warn({ errorMessage, deliveryId: delivery.id }, "queued delivery failed");
      }
    }
  }

  private async handlePair(command: ChannelCommand): Promise<void> {
    if (this.store.getOwner() || command.args.length !== 1) return;
    const paired = this.store.consumePairingCode(command.args[0]!, command.actor);
    if (!paired) return;
    this.store.setOwnerChat(command.actor, command.actor.chatId);
    await this.safeSend("text", "PulseCortex paired. Use /projects to begin.", () => this.messaging.sendText("PulseCortex paired. Use /projects to begin."));
  }

  private async handleNew(args: string[]): Promise<void> {
    if (this.runtime && isActiveState(this.runtime.phase)) { await this.messaging.sendText("A turn is already active. Send text to steer it or use /stop."); return; }
    const projectName = args[0];
    if (!projectName) { await this.sendProjectChoices(); return; }
    const project = this.store.getProject(projectName);
    if (!project) { await this.messaging.sendText(`Unknown project '${redact(projectName)}'. Use /projects.`); return; }
    const prompt = args.slice(1).join(" ").trim();
    await this.createSelectedSession(project, prompt || null);
  }

  private async handleResume(id?: string): Promise<void> {
    if (this.runtime && isActiveState(this.runtime.phase)) { await this.messaging.sendText("Stop the active turn before resuming another session."); return; }
    if (!id) { await this.sendSessionChoices(); return; }
    await this.resumeStoredSession(id);
  }

  private async handleSend(command: ChannelCommand): Promise<void> {
    const addressedMessage = command.text.match(/^\/\S+\s+(\S+)\s+([\s\S]+)$/u);
    const sessionId = addressedMessage?.[1];
    const text = addressedMessage?.[2]?.trim() ?? "";
    if (!sessionId || !text) { await this.messaging.sendText("Usage: /send <session-id> <message>"); return; }
    const session = this.store.getSession(sessionId);
    if (!session) { await this.messaging.sendText("That session is unavailable or was not created by this bot."); return; }
    if (this.runtime) {
      if (this.runtime.session.id !== session.id) {
        await this.messaging.sendText(`Another session has the active turn (${this.runtime.session.id}). Use /stop before messaging ${session.id}.`);
        return;
      }
      if (this.runtime.pendingInput) { await this.answerFreeformInput(text); return; }
      if (!isActiveState(this.runtime.phase)) { await this.messaging.sendText("That turn is finishing. Try again shortly."); return; }
      await this.steerRuntime(text, `Message sent to ${session.id}.`);
      return;
    }
    this.selectedSession = session;
    await this.startTurn(session, text);
  }

  private async handleStatus(): Promise<void> {
    if (this.runtime) {
      const view = this.makeStatusView(this.runtime);
      await this.safeSend("status", view, async () => { this.runtime!.statusRef = await this.messaging.sendStatus(view); }, view, `turn:${view.turnId}:status`);
      return;
    }
    const session = this.selectedSession ?? this.store.listSessions(1)[0];
    if (!session) { await this.messaging.sendText("No sessions yet. Use /new <project>."); return; }
    await this.messaging.sendText(`No active turn. Last session: ${session.title} (${session.state}).`);
  }

  private async handleText(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.runtime?.pendingInput) { await this.answerFreeformInput(text); return; }
    if (this.runtime && isActiveState(this.runtime.phase)) {
      await this.steerRuntime(text, "Steering update sent.");
      return;
    }
    if (this.selectedSession) { await this.startTurn(this.selectedSession, text); return; }
    const projects = this.store.listProjects();
    if (projects.length === 1) { await this.createSelectedSession(projects[0]!, text); return; }
    this.pendingPrompt = text;
    await this.sendProjectChoices("Choose the project for this task.");
  }

  private async steerRuntime(text: string, acknowledgement: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    await this.driver.steerTurn(runtime.session.id, text);
    this.store.audit({ eventType: "turn.steered", summary: "Owner steered active turn", sessionId: runtime.session.id, turnId: runtime.turnId, sensitiveData: text });
    await this.messaging.sendText(acknowledgement);
  }

  private async createSelectedSession(project: Project, prompt: string | null): Promise<void> {
    const title = redact(prompt?.trim() || `New ${project.name} task`, this.redactions).slice(0, 120);
    const id = await this.driver.createSession(project, { title });
    const session = this.store.createSession({ id, projectId: project.id, title });
    this.selectedSession = session;
    if (prompt) await this.startTurn(session, prompt);
    else await this.messaging.sendText(`Session created for ${project.name}. Send the task when ready.`);
  }

  private async startTurn(session: StoredSession, prompt: string): Promise<void> {
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error("Session project is no longer registered");
    await this.driver.resumeSession(session.id, project).catch((error: unknown) => {
      if (!String((error as Error).message).includes("already")) throw error;
    });
    const turnId = await this.driver.startTurn(session.id, prompt);
    this.store.createTurn({ id: turnId, sessionId: session.id, prompt });
    const expiresAt = Date.now() + 14 * 86_400_000;
    this.runtime = {
      session: { ...session, lastTurnId: turnId, state: "starting", updatedAt: Date.now() }, project, turnId, phase: "starting", startedAt: Date.now(), safeSummary: "Codex is starting...", recentCommands: [], diff: "", changedFileCount: 0, testSummary: "", statusRef: null,
      actionTokens: {
        stop: this.issue("turn.stop", session.id, turnId, turnId, expiresAt, {}),
        logs: this.issue("logs.show", session.id, turnId, turnId, expiresAt, { page: 1 }),
        diff: this.issue("diff.show", session.id, turnId, turnId, expiresAt, { page: 1 }),
      },
      dirty: true,
    };
    const view = this.makeStatusView(this.runtime);
    await this.safeSend("status", view, async () => { if (this.runtime?.turnId === turnId) this.runtime.statusRef = await this.messaging.sendStatus(view); }, view, `turn:${turnId}:status`);
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === "driver.crashed") {
      if (this.runtime) await this.failRuntime(`Codex app-server crashed: ${event.error}`);
      void this.restartDriver();
      return;
    }
    const runtime = this.runtime;
    if (!runtime || event.sessionId !== runtime.session.id || event.turnId !== runtime.turnId) return;
    switch (event.type) {
      case "turn.started": runtime.phase = "working"; runtime.safeSummary = "Codex is working..."; runtime.dirty = true; this.store.updateTurn(runtime.turnId, { state: "working" }); await this.flushStatus(true); break;
      case "agent.message.delta": runtime.safeSummary = redact(`${runtime.safeSummary}${event.delta}`, this.redactions).slice(-1_500); runtime.dirty = true; break;
      case "command.started": runtime.recentCommands = [...runtime.recentCommands.slice(-4), event.command]; runtime.phase = "working"; runtime.dirty = true; break;
      case "command.completed": {
        const command = runtime.recentCommands.at(-1) ?? "";
        if (/\b(test|check|lint|build)\b/iu.test(command)) runtime.testSummary = event.exitCode === 0 ? `Passed: ${command}` : `Failed (${String(event.exitCode ?? "unknown")}): ${command}`;
        runtime.dirty = true; break;
      }
      case "approval.requested": await this.handleApprovalEvent(runtime, event); break;
      case "input.requested": await this.handleInputEvent(runtime, event); break;
      case "diff.updated": runtime.diff = redact(event.diff, this.redactions); runtime.changedFileCount = countChangedFiles(runtime.diff); runtime.dirty = true; break;
      case "turn.completed": await this.completeRuntime(event.status); break;
      case "turn.failed": await this.failRuntime(event.error); break;
    }
  }

  private async handleApprovalEvent(runtime: RuntimeTurn, event: Extract<AgentEvent, { type: "approval.requested" }>): Promise<void> {
    runtime.phase = "awaiting_approval";
    runtime.pendingApproval = { id: event.approvalId, kind: event.kind, summary: event.title };
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "awaiting_approval" });
    this.store.addMilestone(runtime.session.id, runtime.turnId, event.type, { approvalId: event.approvalId, kind: event.kind, title: event.title });
    this.store.audit({ eventType: "approval.requested", summary: `${event.kind}: ${event.title}`, sessionId: runtime.session.id, turnId: runtime.turnId });
    const owner = this.requireOwner();
    const expiresAt = Date.now() + this.options.approvalTtlMs;
    const view: ApprovalView = {
      approvalId: event.approvalId, sessionId: runtime.session.id, turnId: runtime.turnId, kind: event.kind, title: event.title,
      ...(event.reason ? { reason: redact(event.reason, this.redactions) } : {}), ...(event.command ? { command: event.command } : {}), ...(event.files ? { files: event.files } : {}), ...(event.paths ? { paths: event.paths } : {}), ...(event.network ? { network: event.network } : {}),
      actionTokens: {
        accept: this.issueForOwner(owner, "approval.accept", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, {}),
        decline: this.issueForOwner(owner, "approval.decline", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, {}),
        cancel: this.issueForOwner(owner, "turn.stop", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, { approvalId: event.approvalId }),
      }, expiresAt,
    };
    await this.safeSend("approval", view, () => this.messaging.sendApproval(view).then(() => undefined));
    await this.flushStatus(true);
  }

  private async resolveApproval(record: InteractionRecord, decision: "accept" | "decline", actor: { tenantId: string; userId: string }): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || record.sessionId !== runtime.session.id || record.turnId !== runtime.turnId || runtime.pendingApproval?.id !== record.requestId) return;
    await this.driver.resolveApproval(record.requestId, decision);
    delete runtime.pendingApproval;
    runtime.phase = "working";
    runtime.safeSummary = decision === "accept" ? "Approval granted once. Codex is continuing..." : "Request denied. Codex is continuing...";
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "working" });
    this.store.audit({ eventType: "approval.decided", summary: decision, actor, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(true);
  }

  private async handleInputEvent(runtime: RuntimeTurn, event: Extract<AgentEvent, { type: "input.requested" }>): Promise<void> {
    runtime.phase = "awaiting_input";
    runtime.pendingInput = { requestId: event.requestId, questions: event.questions, answers: {} };
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "awaiting_input" });
    this.store.addMilestone(runtime.session.id, runtime.turnId, event.type, { requestId: event.requestId, questionIds: event.questions.map((q) => q.id) });
    const owner = this.requireOwner();
    for (const question of event.questions) {
      const expiresAt = Date.now() + this.options.approvalTtlMs;
      const view: QuestionView = {
        sessionId: runtime.session.id, turnId: runtime.turnId, requestId: event.requestId, title: question.header, question: redact(question.question, this.redactions), freeformAccepted: question.allowFreeform,
        options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}), value: option.label, token: this.issueForOwner(owner, "input.answer", runtime.session.id, runtime.turnId, event.requestId, expiresAt, { questionId: question.id, answer: option.label }) })),
      };
      await this.safeSend("question", view, () => this.messaging.sendQuestion(view));
    }
    await this.flushStatus(true);
  }

  private async answerStructuredInput(record: InteractionRecord): Promise<void> {
    const pending = this.runtime?.pendingInput;
    if (!this.runtime || !pending || pending.requestId !== record.requestId) return;
    const questionId = String(record.payload["questionId"] ?? "");
    const answer = String(record.payload["answer"] ?? "");
    if (!pending.questions.some((question) => question.id === questionId)) return;
    pending.answers[questionId] = answer;
    await this.finishInputIfComplete();
  }

  private async answerFreeformInput(text: string): Promise<void> {
    const pending = this.runtime?.pendingInput;
    if (!pending) return;
    const question = pending.questions.find((item) => !(item.id in pending.answers) && item.allowFreeform);
    if (!question) { await this.messaging.sendText("Please use one of the answer buttons on the question card."); return; }
    pending.answers[question.id] = text;
    await this.finishInputIfComplete();
  }

  private async finishInputIfComplete(): Promise<void> {
    const runtime = this.runtime; const pending = runtime?.pendingInput;
    if (!runtime || !pending || pending.questions.some((question) => !(question.id in pending.answers))) return;
    await this.driver.resolveInput(pending.requestId, pending.answers);
    this.store.audit({ eventType: "input.answered", summary: `${pending.questions.length} agent question(s) answered`, sessionId: runtime.session.id, turnId: runtime.turnId });
    delete runtime.pendingInput; runtime.phase = "working"; runtime.safeSummary = "Answer sent. Codex is continuing..."; runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "working" });
    await this.flushStatus(true);
  }

  private async stopActiveTurn(source: string, record?: InteractionRecord): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !isActiveState(runtime.phase)) { await this.messaging.sendText("No active turn to stop."); return; }
    if (record && (record.sessionId !== runtime.session.id || record.turnId !== runtime.turnId)) return;
    runtime.phase = "stopping"; runtime.safeSummary = "Stopping Codex..."; runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "stopping" });
    if (runtime.pendingApproval) await this.driver.resolveApproval(runtime.pendingApproval.id, "cancel").catch(() => undefined);
    await this.driver.interruptTurn(runtime.session.id);
    this.store.audit({ eventType: "turn.stopped", summary: `Stop requested from ${source}`, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(true);
  }

  private async completeRuntime(status: "completed" | "stopped"): Promise<void> {
    const runtime = this.runtime; if (!runtime) return;
    runtime.phase = "completed"; runtime.safeSummary ||= status === "stopped" ? "Turn stopped." : "Turn completed."; runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "completed", safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary, completed: true });
    this.store.addMilestone(runtime.session.id, runtime.turnId, "turn.completed", { status, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary });
    this.store.audit({ eventType: "turn.completed", summary: status, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(true);
    await this.sendResult(runtime, status === "stopped" ? "stopped" : "completed");
    this.selectedSession = { ...runtime.session, state: "completed", lastTurnId: runtime.turnId, updatedAt: Date.now() };
    this.runtime = null;
  }

  private async failRuntime(error: string): Promise<void> {
    const runtime = this.runtime; if (!runtime) return;
    runtime.phase = "failed"; runtime.safeSummary = redact(error, this.redactions).slice(0, 1_500); runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "failed", safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary, completed: true });
    this.store.addMilestone(runtime.session.id, runtime.turnId, "turn.failed", { error: runtime.safeSummary });
    this.store.audit({ eventType: "turn.failed", summary: runtime.safeSummary, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(true);
    await this.sendResult(runtime, "failed");
    this.selectedSession = { ...runtime.session, state: "failed", lastTurnId: runtime.turnId, updatedAt: Date.now() };
    this.runtime = null;
  }

  private async sendResult(runtime: RuntimeTurn, status: TurnResultView["status"]): Promise<void> {
    const expiresAt = Date.now() + 14 * 86_400_000;
    const view: TurnResultView = {
      sessionId: runtime.session.id, turnId: runtime.turnId, title: runtime.session.title, projectName: runtime.project.name, status, summary: runtime.safeSummary, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary,
      actionTokens: {
        diff: this.issue("diff.show", runtime.session.id, runtime.turnId, runtime.turnId, expiresAt, { page: 1 }),
        logs: this.issue("logs.show", runtime.session.id, runtime.turnId, runtime.turnId, expiresAt, { page: 1 }),
        continue: this.issue("session.continue", runtime.session.id, runtime.turnId, runtime.session.id, expiresAt, {}),
        newTask: this.issue("task.new", runtime.session.id, runtime.turnId, runtime.session.id, expiresAt, {}),
      },
    };
    await this.safeSend("result", view, () => this.messaging.sendResult(view), view, `turn:${runtime.turnId}:result`);
  }

  private async sendProjectChoices(description?: string): Promise<void> {
    const projects = this.store.listProjects();
    if (!projects.length) { await this.messaging.sendText("No projects are registered. Add one locally with: pulsectl project add <name> <path>"); return; }
    const expiresAt = Date.now() + 15 * 60_000;
    const view: ChoiceView = { title: "Choose a project", ...(description ? { description } : {}), actionKind: "project.select", choices: projects.map((project) => ({ label: project.name, description: project.canonicalPath, value: project.id, token: this.issue("project.select", "new", "new", project.id, expiresAt, { purpose: "new" }) })) };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async selectProject(projectId: string): Promise<void> {
    if (this.runtime && isActiveState(this.runtime.phase)) return;
    const project = this.store.getProject(projectId); if (!project) return;
    const prompt = this.pendingPrompt; this.pendingPrompt = null;
    await this.createSelectedSession(project, prompt);
  }

  private async sendSessionChoices(): Promise<void> {
    const sessions = this.store.listSessions();
    if (!sessions.length) { await this.messaging.sendText("No bot-created sessions yet."); return; }
    const expiresAt = Date.now() + 15 * 60_000;
    const view: ChoiceView = { title: "Resume a session", actionKind: "session.select", choices: sessions.map((session) => ({ label: session.title, description: `ID: ${session.id}\n${session.state} - ${new Date(session.updatedAt).toLocaleString()}`, value: session.id, token: this.issue("session.select", session.id, session.lastTurnId ?? "none", session.id, expiresAt, {}) })) };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async resumeStoredSession(id: string): Promise<void> {
    if (this.runtime && isActiveState(this.runtime.phase)) return;
    const session = this.store.getSession(id); if (!session) { await this.messaging.sendText("That session is unavailable or was not created by this bot."); return; }
    const project = this.store.getProject(session.projectId); if (!project) { await this.messaging.sendText("The session project is no longer registered."); return; }
    await this.driver.resumeSession(session.id, project);
    this.selectedSession = session;
    await this.messaging.sendText(`Resumed ${session.title}. Send a message to start the next turn.`);
  }

  private async sendPagedOutput(kind: "logs.show" | "diff.show", sessionId: string | undefined, requestedPage: number): Promise<void> {
    if (!sessionId) { await this.messaging.sendText("No session selected."); return; }
    const session = this.store.getSession(sessionId); const turnId = this.runtime?.session.id === sessionId ? this.runtime.turnId : session?.lastTurnId;
    if (!session || !turnId) { await this.messaging.sendText("No turn output is available."); return; }
    const view = await this.makeOutputView(kind, sessionId, turnId, requestedPage);
    await this.safeSend("output", view, () => this.messaging.sendOutput(view), { actionKind: kind, sessionId, turnId, page: view.page });
  }

  private makeStatusView(runtime: RuntimeTurn): SessionView {
    return { sessionId: runtime.session.id, turnId: runtime.turnId, title: runtime.session.title, projectName: runtime.project.name, phase: runtime.phase, startedAt: runtime.startedAt, updatedAt: Date.now(), safeSummary: runtime.safeSummary, recentCommands: runtime.recentCommands, ...(runtime.pendingApproval ? { pendingApproval: runtime.pendingApproval } : {}), actionTokens: runtime.actionTokens };
  }

  private async flushStatus(force = false): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || (!runtime.dirty && !force) || this.statusFlush) return;
    runtime.dirty = false;
    const view = this.makeStatusView(runtime);
    this.store.updateTurn(runtime.turnId, { state: runtime.phase, safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary });
    this.statusFlush = (async () => {
      const queueKey = `turn:${runtime.turnId}:status`;
      if (runtime.statusRef) await this.safeSend("status.update", { ref: runtime.statusRef, view }, () => this.messaging.updateStatus(runtime.statusRef!, view), { ref: runtime.statusRef, view }, queueKey);
      else await this.safeSend("status", view, async () => { runtime.statusRef = await this.messaging.sendStatus(view); }, view, queueKey);
    })().finally(() => { this.statusFlush = null; });
    await this.statusFlush;
  }

  private issue(kind: string, sessionId: string, turnId: string, requestId: string, expiresAt: number, payload: Record<string, unknown>): string {
    return this.issueForOwner(this.requireOwner(), kind, sessionId, turnId, requestId, expiresAt, payload);
  }

  private issueForOwner(owner: { tenantId: string; userId: string }, kind: string, sessionId: string, turnId: string, requestId: string, expiresAt: number, payload: Record<string, unknown>): string {
    return this.tokens.issue({ kind, tenantId: owner.tenantId, userId: owner.userId, sessionId, turnId, requestId, expiresAt, payload });
  }

  private requireOwner(): { tenantId: string; userId: string } { const owner = this.store.getOwner(); if (!owner) throw new Error("No owner is paired"); return owner; }

  private async safeSend(kind: DeliveryKind, payload: unknown, operation: () => Promise<void>, queuePayload: unknown = payload, queueKey?: string): Promise<void> {
    try { await operation(); this.store.audit({ eventType: "delivery.succeeded", summary: kind }); }
    catch (error) {
      const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
      const id = this.store.enqueueDelivery(kind, queuePayload, Date.now(), queueKey);
      this.store.audit({ eventType: "delivery.queued", summary: `${kind}: ${errorMessage}` });
      this.logger.warn({ errorMessage, deliveryId: id, kind }, "Feishu delivery queued");
    }
  }

  private async deliver(kind: DeliveryKind, payload: Record<string, unknown>): Promise<void> {
    switch (kind) {
      case "text": await this.messaging.sendText(String(payload)); break;
      case "status": { const ref = await this.messaging.sendStatus(payload as unknown as SessionView); if (this.runtime?.turnId === (payload as unknown as SessionView).turnId) this.runtime.statusRef = ref; break; }
      case "status.update": { const value = payload as unknown as { ref: MessageRef; view: SessionView }; await this.messaging.updateStatus(value.ref, value.view); break; }
      case "approval": await this.messaging.sendApproval(payload as unknown as ApprovalView); break;
      case "result": await this.messaging.sendResult(payload as unknown as TurnResultView); break;
      case "choices": await this.messaging.sendChoices(payload as unknown as ChoiceView); break;
      case "question": await this.messaging.sendQuestion(payload as unknown as QuestionView); break;
      case "output": {
        if ("content" in payload) await this.messaging.sendOutput(payload as unknown as OutputView);
        else await this.messaging.sendOutput(await this.makeOutputView(payload["actionKind"] as "logs.show" | "diff.show", String(payload["sessionId"]), String(payload["turnId"]), Number(payload["page"] ?? 1)));
        break;
      }
    }
  }

  private async makeOutputView(kind: "logs.show" | "diff.show", sessionId: string, turnId: string, requestedPage: number): Promise<OutputView> {
    const activeDiff = this.runtime?.session.id === sessionId && this.runtime.turnId === turnId ? this.runtime.diff : "";
    const storedDiff = String(this.store.getTurn(turnId)?.["diff_text"] ?? "");
    const content = kind === "logs.show" ? await this.commandLogs.read(turnId) : activeDiff || storedDiff || "No diff recorded.";
    const page = paginate(redact(content, this.redactions), requestedPage);
    const expiresAt = Date.now() + 15 * 60_000;
    return {
      title: kind === "logs.show" ? "Command logs" : "Unified diff", content: page.text, page: page.page, totalPages: page.totalPages, actionKind: kind,
      ...(page.page > 1 ? { previousToken: this.issue(kind, sessionId, turnId, turnId, expiresAt, { page: page.page - 1 }) } : {}),
      ...(page.page < page.totalPages ? { nextToken: this.issue(kind, sessionId, turnId, turnId, expiresAt, { page: page.page + 1 }) } : {}),
    };
  }

  private async restartDriver(): Promise<void> {
    if (this.driverRestart || this.stopped) return this.driverRestart ?? Promise.resolve();
    this.driverRestart = (async () => {
      let attempt = 0;
      while (!this.stopped) {
        try {
          const capabilities = await this.driver.start();
          this.logger.info({ cliVersion: capabilities.cliVersion }, "Codex app-server restarted after crash");
          return;
        } catch (error) {
          const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, attempt++));
          this.logger.warn({ errorMessage: redact((error as Error).message, this.redactions), retryMs: delay }, "Codex app-server restart failed");
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    })().finally(() => { this.driverRestart = null; });
    return this.driverRestart;
  }
}

function countChangedFiles(diff: string): number {
  return new Set([...diff.matchAll(/^diff --git a\/(.+?) b\//gmu)].map((match) => match[1])).size;
}
