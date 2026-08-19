import type { Logger } from "pino";
import {
  isActiveState,
  paginate,
  redact,
  type AgentDriver,
  type AgentEvent,
  type ApprovalResolutionView,
  type ApprovalView,
  type ChannelAction,
  type ChannelCommand,
  type ChoiceView,
  type MessagingAdapter,
  type MessageRef,
  type OutputView,
  type Project,
  type QuestionResolutionView,
  type QuestionView,
  type InputQuestion,
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
  questions: PendingQuestionState[];
  answers: Record<string, string>;
}

interface PendingQuestionState {
  question: InputQuestion;
  view: QuestionView;
  ref?: MessageRef;
}

interface PendingApprovalState {
  id: string;
  kind: ApprovalView["kind"];
  summary: string;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  ref?: MessageRef;
}

interface RuntimeTurn {
  session: StoredSession;
  project: Project;
  turnId: string;
  phase: TurnPhase;
  startedAt: number;
  safeSummary: string;
  completedPlan: string | null;
  replies: Array<{ id: string; text: string }>;
  recentCommands: string[];
  diff: string;
  changedFileCount: number;
  testSummary: string;
  statusRef: MessageRef | null;
  actionTokens: SessionView["actionTokens"];
  pendingApprovals: Map<string, PendingApprovalState>;
  pendingInput?: PendingInputState;
  dirty: boolean;
}

interface ProjectSession {
  session: StoredSession;
  project: Project;
  updatedAt: number;
}

interface SessionRefreshResult {
  newlyControllable: ProjectSession[];
}

type DeliveryKind = "text" | "status" | "status.update" | "approval" | "approval.update" | "approval.remove" | "result" | "result.update" | "choices" | "question" | "question.update" | "output";
const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const IMPLEMENT_PLAN_PROMPT = "Implement the plan.";
const FRESH_IMPLEMENT_PLAN_PROMPT = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";
const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed: add sections if relevant, and omit those that do not apply to this project.

Document Requirements
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections
Project Structure & Module Organization
- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands
- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions
- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines
- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines
- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

const SELECTABLE_CODEX_BUILTIN_COMMANDS = [
  { id: "init", label: "/init", description: "Create an AGENTS.md file with instructions for Codex" },
  { id: "compact", label: "/compact", description: "Summarize the conversation to free context" },
] as const;

const HELP = `PulseCortex commands:
/projects - choose a locally registered project
/new [task] - create a Codex session in the chosen project (or use /new <project> [task])
/sessions - discover and select allowlisted Codex sessions
/instructions - run available Codex built-in commands or choose instructions for the selected session
/resume [session-id] - resume a session
/send <message> - message the selected session, or create one if none is selected
/send <session-id> <message> - message a specific session
/status - show the selected session's active turn
/stop - interrupt the selected session's active turn
/logs - show chronological Codex logs
/diff - show the current unified diff
/help - show this help

Ordinary direct messages start work or steer the selected session.`;

export class SessionCoordinator {
  private readonly runtimes = new Map<string, RuntimeTurn>();
  private controllableSessions = new Map<string, ProjectSession>();
  private uncontrollableSessions = new Map<string, ProjectSession>();
  private selectedSession: StoredSession | null = null;
  private selectedProjectId: string | null = null;
  private pendingPrompt: string | null = null;
  private pendingPromptCreatesSession = false;
  private pendingInstructionChoices = false;
  private readonly tokens: ActionTokenService;
  private readonly redactions: RegExp[];
  private readonly statusTimer: NodeJS.Timeout;
  private readonly deliveryTimer: NodeJS.Timeout;
  private readonly discoveryTimer: NodeJS.Timeout;
  private readonly statusFlushes = new Map<string, Promise<void>>();
  private sessionRefresh: Promise<SessionRefreshResult> | null = null;
  private initialization: Promise<void> | null = null;
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
    const defaultProject = store.getLocalSettings().defaultProject;
    this.selectedProjectId = defaultProject ? store.getProject(defaultProject)?.id ?? null : null;
    this.messaging.onCommand(async (command) => this.handleCommand(command));
    this.messaging.onAction(async (action) => this.handleAction(action));
    this.driver.subscribe((event) => { void this.handleAgentEvent(event).catch((error) => this.logger.error({ err: error }, "agent event handling failed")); });
    this.statusTimer = setInterval(() => { void this.flushStatuses(); }, options.statusUpdateIntervalMs);
    this.statusTimer.unref();
    this.deliveryTimer = setInterval(() => { void this.flushDeliveries(); }, 5_000);
    this.deliveryTimer.unref();
    this.discoveryTimer = setInterval(() => {
      void this.syncRunningSessions().catch((error) => this.logger.warn({ errorMessage: redact((error as Error).message, this.redactions) }, "Running Codex discovery failed"));
    }, SESSION_DISCOVERY_INTERVAL_MS);
    this.discoveryTimer.unref();
  }

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    const operation = this.syncRunningSessions();
    this.initialization = operation;
    try { await operation; }
    catch (error) { this.initialization = null; throw error; }
  }

  async notifyStartup(): Promise<void> {
    const message = `PulseCortex started and is ready to receive Feishu messages.\nDefault project: ${this.selectedProject()?.name ?? "none"}.`;
    await this.safeSend("text", message, () => this.messaging.sendText(message));
  }

  async syncRunningSessions(): Promise<void> {
    const { newlyControllable } = await this.refreshSessions();
    if (newlyControllable.length) {
      const preferred = this.selectedProjectId
        ? newlyControllable.filter((candidate) => candidate.project.id === this.selectedProjectId)
        : newlyControllable;
      if (preferred.length === 1 || (this.selectedProjectId && preferred.length > 1)) {
        const running = preferred.sort((left, right) => right.updatedAt - left.updatedAt)[0]!;
        this.selectedSession = running.session;
        this.rememberProject(running.project.id);
        const message = runningSessionSelectedMessage(running);
        await this.safeSend("text", message, () => this.messaging.sendText(message));
      } else if (!this.selectedProjectId && newlyControllable.length > 1) {
        const message = `Detected ${newlyControllable.length} controllable Codex sessions in registered projects. Use /sessions to choose the default.`;
        await this.safeSend("text", message, () => this.messaging.sendText(message));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.statusTimer);
    clearInterval(this.deliveryTimer);
    clearInterval(this.discoveryTimer);
    for (const runtime of this.runtimes.values()) {
      for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.expiryTimer);
    }
    await Promise.all(this.statusFlushes.values());
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
      case "instructions": await this.sendInstructionChoices(); break;
      case "resume": await this.handleResume(command.args[0]); break;
      case "send": await this.handleSend(command); break;
      case "status": await this.handleStatus(); break;
      case "stop": await this.stopActiveTurn("command"); break;
      case "logs": await this.sendPagedOutput("logs.show", this.selectedSession?.id, 1); break;
      case "diff": await this.sendPagedOutput("diff.show", this.selectedSession?.id, 1); break;
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
      case "approval.acceptForSession": await this.resolveApproval(record, "acceptForSession", action.actor); break;
      case "approval.decline": await this.resolveApproval(record, "decline", action.actor); break;
      case "turn.stop": await this.stopActiveTurn("action", record); break;
      case "logs.show": await this.sendPagedOutput("logs.show", record.sessionId, Number(record.payload["page"] ?? 1), record.turnId); break;
      case "diff.show": await this.sendPagedOutput("diff.show", record.sessionId, Number(record.payload["page"] ?? 1), record.turnId); break;
      case "project.select": await this.selectProject(record.requestId); break;
      case "session.select": await this.resumeStoredSession(record.requestId); break;
      case "instructions.command": await this.selectBuiltinCommand(record.sessionId, record.requestId); break;
      case "instructions.select": await this.selectInstructionPreset(record.sessionId, record.requestId); break;
      case "plan.select": await this.selectPostPlanAction(record, action.value); break;
      case "session.continue": await this.resumeStoredSession(record.sessionId); break;
      case "task.new": await this.promptForNewSession(null); break;
      case "sessions.more": await this.sendSessionChoices(Number(record.payload["page"] ?? 1), false); break;
      case "input.answer": await this.answerStructuredInput(record, action.formValues); break;
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
    const firstArg = args[0]?.trim();
    const explicitlyNamedProject = firstArg ? this.store.getProject(firstArg) : null;
    const project = explicitlyNamedProject ?? this.selectedProject();
    if (!project) {
      await this.promptForNewSession(args.join(" ").trim() || null);
      return;
    }
    const prompt = (explicitlyNamedProject ? args.slice(1) : args).join(" ").trim();
    await this.createSelectedSession(project, prompt || null);
  }

  private async handleResume(id?: string): Promise<void> {
    if (!id) { await this.sendSessionChoices(); return; }
    await this.resumeStoredSession(id);
  }

  private async handleSend(command: ChannelCommand): Promise<void> {
    const body = command.text.match(/^\/\S+(?:\s+([\s\S]*))?$/u)?.[1]?.trim() ?? "";
    if (!body) { await this.messaging.sendText("Usage: /send <message> or /send <session-id> <message>"); return; }
    await this.refreshSessions();
    this.selectSoleControllableSession();
    const addressedMessage = body.match(/^(\S+)\s+([\s\S]+)$/u);
    const addressedSession = addressedMessage ? this.store.getSession(addressedMessage[1]!) : null;
    const selectedRuntime = this.selectedRuntime();
    const session = addressedSession ?? (this.selectedSession ? this.store.getSession(this.selectedSession.id) : null) ?? selectedRuntime?.session ?? null;
    const text = addressedSession ? addressedMessage![2]!.trim() : body;
    if (!session) { await this.createSessionForUnselectedSend(text); return; }
    const runtime = this.runtimes.get(session.id);
    if (runtime) {
      this.selectedSession = runtime.session;
      this.rememberProject(runtime.project.id);
      if (runtime.pendingInput) { await this.answerFreeformInput(runtime, text); return; }
      if (await this.blockSteerWhileApprovalsPending(runtime)) return;
      if (!isActiveState(runtime.phase)) { await this.messaging.sendText("That turn is finishing. Try again shortly."); return; }
      await this.steerRuntime(runtime, text, `Message sent to ${session.id}.`);
      return;
    }
    this.selectedSession = session;
    this.rememberProject(session.projectId);
    await this.startTurn(session, text);
  }

  private async handleStatus(): Promise<void> {
    const runtime = this.selectedRuntime();
    if (runtime) {
      const view = this.makeStatusView(runtime);
      await this.safeSend("status", view, async () => { runtime.statusRef = await this.messaging.sendStatus(view); }, view, `turn:${view.turnId}:status`);
      return;
    }
    const session = this.selectedSession ?? this.store.listSessions(1)[0];
    if (!session) { await this.messaging.sendText("No sessions yet. Use /new <project>."); return; }
    await this.messaging.sendText(`No active turn. Last session: ${session.title} (${session.state}).`);
  }

  private async handleText(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.refreshSessions();
    this.selectSoleControllableSession();
    const runtime = this.selectedRuntime();
    if (runtime?.pendingInput) { await this.answerFreeformInput(runtime, text); return; }
    if (runtime && await this.blockSteerWhileApprovalsPending(runtime)) return;
    if (runtime && isActiveState(runtime.phase)) {
      await this.steerRuntime(runtime, text, "Steering update sent.");
      return;
    }
    if (this.selectedSession) {
      const selectedId = this.selectedSession.id;
      const liveRuntime = this.runtimes.get(selectedId);
      if (liveRuntime?.pendingInput) { await this.answerFreeformInput(liveRuntime, text); return; }
      if (liveRuntime && await this.blockSteerWhileApprovalsPending(liveRuntime)) return;
      if (liveRuntime && isActiveState(liveRuntime.phase)) { await this.steerRuntime(liveRuntime, text, "Steering update sent."); return; }
      const refreshed = this.store.getSession(selectedId);
      if (refreshed) { this.selectedSession = refreshed; await this.startTurn(refreshed, text); return; }
      this.selectedSession = null;
    }
    const selectedProject = this.selectedProject();
    if (selectedProject) { await this.createSelectedSession(selectedProject, text); return; }
    const projects = this.store.listProjects();
    if (projects.length === 1) { await this.createSelectedSession(projects[0]!, text); return; }
    this.pendingPrompt = text;
    this.pendingPromptCreatesSession = false;
    await this.sendProjectChoices("Choose the project for this task.");
  }

  private async blockSteerWhileApprovalsPending(runtime: RuntimeTurn): Promise<boolean> {
    if (!runtime.pendingApprovals.size) return false;
    const noun = runtime.pendingApprovals.size === 1 ? "approval card" : "approval cards";
    await this.messaging.sendText(`Use Allow once, Auto approve (when available), or Deny on the pending ${noun} before sending another message.`);
    return true;
  }

  private async steerRuntime(runtime: RuntimeTurn, text: string, acknowledgement: string): Promise<void> {
    await this.driver.steerTurn(runtime.session.id, text);
    this.store.audit({ eventType: "turn.steered", summary: "Owner steered active turn", sessionId: runtime.session.id, turnId: runtime.turnId, sensitiveData: text });
    await this.messaging.sendText(acknowledgement);
  }

  private async createSelectedSession(project: Project, prompt: string | null, announceEmpty = true, titleOverride?: string): Promise<StoredSession> {
    this.rememberProject(project.id);
    const title = redact(titleOverride?.trim() || prompt?.trim() || `New ${project.name} task`, this.redactions).slice(0, 120);
    const id = await this.driver.createSession(project, { title });
    const session = this.store.createSession({ id, projectId: project.id, title });
    this.selectedSession = session;
    if (prompt) await this.startTurn(session, prompt);
    else if (announceEmpty) await this.messaging.sendText(`Session created for ${project.name}. Send the task when ready.`);
    return session;
  }

  private async createSessionForUnselectedSend(prompt: string): Promise<void> {
    this.pendingPrompt = null;
    this.pendingPromptCreatesSession = false;
    const project = this.selectedProject();
    if (project) { await this.createSelectedSession(project, prompt); return; }
    const projects = this.store.listProjects();
    if (projects.length === 1) { await this.createSelectedSession(projects[0]!, prompt); return; }
    if (projects.length > 1) { await this.promptForNewSession(prompt); return; }
    await this.sendProjectChoices("Choose the project for this new session.");
  }

  private async promptForNewSession(prompt: string | null): Promise<void> {
    this.pendingPrompt = prompt;
    this.pendingPromptCreatesSession = true;
    await this.sendProjectChoices("Choose the project for this new session.");
  }

  private async startTurn(session: StoredSession, prompt: string): Promise<void> {
    if (this.runtimes.has(session.id)) throw new Error("This session already has an active turn");
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error("Session project is no longer registered");
    this.rememberProject(project.id);
    await this.driver.resumeSession(session.id, project, { managed: session.botCreated });
    const turnId = await this.driver.startTurn(session.id, prompt);
    this.store.createTurn({ id: turnId, sessionId: session.id, prompt });
    const runtime = this.makeRuntime(session, project, turnId, "starting", Date.now(), "Codex is starting...");
    this.runtimes.set(session.id, runtime);
    this.selectedSession = runtime.session;
    await this.flushStatus(session.id, true);
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === "driver.crashed") {
      for (const runtime of [...this.runtimes.values()]) await this.failRuntime(runtime, `Codex app-server crashed: ${event.error}`);
      void this.restartDriver();
      return;
    }
    const runtime = this.runtimes.get(event.sessionId);
    if (!runtime || event.sessionId !== runtime.session.id || event.turnId !== runtime.turnId) return;
    switch (event.type) {
      case "turn.started": runtime.phase = "working"; runtime.safeSummary = "Codex is working..."; runtime.dirty = true; this.store.updateTurn(runtime.turnId, { state: "working" }); await this.flushStatus(runtime.session.id, true); break;
      case "agent.message.delta":
        void this.commandLogs.append(runtime.turnId, "message", event.delta).catch(() => undefined);
        this.appendReply(runtime, event.messageId ?? "default", event.delta); runtime.dirty = true; break;
      case "plan.completed":
        void this.commandLogs.append(runtime.turnId, "message", event.text).catch(() => undefined);
        runtime.completedPlan = redact(event.text, this.redactions); runtime.safeSummary = runtime.completedPlan.slice(0, 1_500); runtime.dirty = true; break;
      case "command.started":
        void this.commandLogs.append(runtime.turnId, "command", `$ ${event.command}\n`).catch(() => undefined);
        runtime.recentCommands = [...runtime.recentCommands.slice(-4), event.command]; if (!runtime.pendingApprovals.size) runtime.phase = "working"; runtime.dirty = true; break;
      case "command.completed": {
        const command = runtime.recentCommands.at(-1) ?? "";
        if (/\b(test|check|lint|build)\b/iu.test(command)) runtime.testSummary = event.exitCode === 0 ? `Passed: ${command}` : `Failed (${String(event.exitCode ?? "unknown")}): ${command}`;
        runtime.dirty = true; break;
      }
      case "approval.requested": await this.handleApprovalEvent(runtime, event); break;
      case "input.requested": await this.handleInputEvent(runtime, event); break;
      case "request.resolved": await this.handleResolvedRequest(runtime, event.requestId); break;
      case "diff.updated": runtime.diff = redact(event.diff, this.redactions); runtime.changedFileCount = countChangedFiles(runtime.diff); runtime.dirty = true; break;
      case "turn.completed": await this.completeRuntime(runtime, event.status); break;
      case "turn.failed": await this.failRuntime(runtime, event.error); break;
    }
  }

  private async handleResolvedRequest(runtime: RuntimeTurn, requestId: string): Promise<void> {
    const approval = runtime.pendingApprovals.get(requestId);
    if (approval) {
      clearTimeout(approval.expiryTimer);
      await this.resolveApprovalCard(approval, "cancel");
      runtime.pendingApprovals.delete(requestId);
    }
    if (runtime.pendingInput?.requestId === requestId) await this.withdrawPendingInput(runtime);
    runtime.phase = runtime.pendingApprovals.size ? "awaiting_approval" : runtime.pendingInput ? "awaiting_input" : "working";
    runtime.safeSummary = runtime.phase === "working" ? "Codex withdrew the pending request and is continuing..." : runtime.safeSummary;
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: runtime.phase });
    this.store.audit({ eventType: "request.resolved", summary: requestId, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(runtime.session.id, true);
  }

  private async handleApprovalEvent(runtime: RuntimeTurn, event: Extract<AgentEvent, { type: "approval.requested" }>): Promise<void> {
    runtime.phase = "awaiting_approval";
    const expiresAt = Date.now() + this.options.approvalTtlMs;
    const expiryTimer = setTimeout(() => {
      void this.expireApproval(runtime.session.id, runtime.turnId, event.approvalId).catch((error) => this.logger.warn({ sessionId: runtime.session.id, turnId: runtime.turnId, errorMessage: redact((error as Error).message, this.redactions) }, "Could not expire Codex approval"));
    }, this.options.approvalTtlMs);
    expiryTimer.unref();
    const pending: PendingApprovalState = { id: event.approvalId, kind: event.kind, summary: event.title, expiresAt, expiryTimer };
    runtime.pendingApprovals.set(event.approvalId, pending);
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "awaiting_approval" });
    this.store.addMilestone(runtime.session.id, runtime.turnId, event.type, { approvalId: event.approvalId, kind: event.kind, title: event.title });
    this.store.audit({ eventType: "approval.requested", summary: `${event.kind}: ${event.title}`, sessionId: runtime.session.id, turnId: runtime.turnId });
    const owner = this.requireOwner();
    const view: ApprovalView = {
      approvalId: event.approvalId, sessionId: runtime.session.id, turnId: runtime.turnId, kind: event.kind, title: event.title,
      ...(event.reason ? { reason: redact(event.reason, this.redactions) } : {}), ...(event.command ? { command: event.command } : {}), ...(event.files ? { files: event.files } : {}), ...(event.paths ? { paths: event.paths } : {}), ...(event.network ? { network: event.network } : {}),
      actionTokens: {
        accept: this.issueForOwner(owner, "approval.accept", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, {}),
        ...(event.kind === "command" && event.canAutoApprove === true ? { autoApprove: this.issueForOwner(owner, "approval.acceptForSession", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, {}) } : {}),
        decline: this.issueForOwner(owner, "approval.decline", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, {}),
        cancel: this.issueForOwner(owner, "turn.stop", runtime.session.id, runtime.turnId, event.approvalId, expiresAt, { approvalId: event.approvalId }),
      }, expiresAt,
    };
    await this.safeSend("approval", view, async () => {
      const ref = await this.messaging.sendApproval(view);
      if (runtime.pendingApprovals.get(event.approvalId) === pending) pending.ref = ref;
    });
    await this.flushStatus(runtime.session.id, true);
  }

  private async resolveApproval(record: InteractionRecord, decision: "accept" | "acceptForSession" | "decline", actor: { tenantId: string; userId: string }): Promise<void> {
    const runtime = this.runtimes.get(record.sessionId);
    const pending = runtime?.pendingApprovals.get(record.requestId);
    if (!runtime || !pending || record.sessionId !== runtime.session.id || record.turnId !== runtime.turnId) return;
    if (decision === "acceptForSession" && pending.kind !== "command") {
      this.store.audit({ eventType: "approval.rejected", summary: "Auto approve is restricted to command requests", actor, sessionId: runtime.session.id, turnId: runtime.turnId });
      return;
    }
    clearTimeout(pending.expiryTimer);
    runtime.pendingApprovals.delete(record.requestId);
    await this.driver.resolveApproval(record.requestId, decision);
    await this.resolveApprovalCard(pending, decision);
    const pendingCount = runtime.pendingApprovals.size;
    runtime.phase = pendingCount ? "awaiting_approval" : "working";
    runtime.safeSummary = pendingCount
      ? `${pendingCount} approval request${pendingCount === 1 ? "" : "s"} still pending.`
      : decision === "accept" ? "Approval granted once. Codex is continuing..." : decision === "acceptForSession" ? "Command auto approve enabled for this session. Codex is continuing..." : "Request denied. Codex is continuing...";
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: runtime.phase });
    this.store.audit({ eventType: "approval.decided", summary: decision, actor, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(runtime.session.id, true);
  }

  private async expireApproval(sessionId: string, turnId: string, approvalId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    const pending = runtime?.pendingApprovals.get(approvalId);
    if (!runtime || !pending || runtime.turnId !== turnId || pending.expiresAt > Date.now()) return;
    runtime.pendingApprovals.delete(approvalId);
    await this.driver.resolveApproval(approvalId, "decline").catch(() => undefined);
    await this.resolveApprovalCard(pending, "decline");
    runtime.phase = runtime.pendingApprovals.size ? "awaiting_approval" : runtime.pendingInput ? "awaiting_input" : "working";
    runtime.safeSummary = runtime.pendingApprovals.size ? `${runtime.pendingApprovals.size} approval request${runtime.pendingApprovals.size === 1 ? "" : "s"} still pending.` : "Approval expired and was denied. Codex is continuing...";
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: runtime.phase });
    this.store.audit({ eventType: "approval.expired", summary: pending.kind, sessionId, turnId });
    await this.flushStatus(sessionId, true);
  }

  private async handleInputEvent(runtime: RuntimeTurn, event: Extract<AgentEvent, { type: "input.requested" }>): Promise<void> {
    if (runtime.pendingInput) await this.withdrawPendingInput(runtime);
    runtime.phase = "awaiting_input";
    const owner = this.requireOwner();
    const questions = event.questions.map((question): PendingQuestionState => {
      const expiresAt = Date.now() + this.options.approvalTtlMs;
      const view: QuestionView = {
        sessionId: runtime.session.id, turnId: runtime.turnId, requestId: event.requestId, questionId: question.id, title: question.header, question: redact(question.question, this.redactions), freeformAccepted: question.allowFreeform,
        options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
        submissionToken: this.issueForOwner(owner, "input.answer", runtime.session.id, runtime.turnId, event.requestId, expiresAt, { questionId: question.id }),
      };
      return { question, view };
    });
    const pending: PendingInputState = { requestId: event.requestId, questions, answers: {} };
    runtime.pendingInput = pending;
    runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "awaiting_input" });
    this.store.addMilestone(runtime.session.id, runtime.turnId, event.type, { requestId: event.requestId, questionIds: event.questions.map((q) => q.id) });
    for (const state of questions) {
      const { view } = state;
      await this.safeSend("question", view, async () => {
        const ref = await this.messaging.sendQuestion(view);
        if (runtime.pendingInput === pending && pending.questions.includes(state)) state.ref = ref;
      });
    }
    await this.flushStatus(runtime.session.id, true);
  }

  private async answerStructuredInput(record: InteractionRecord, formValues?: Record<string, string>): Promise<void> {
    const runtime = this.runtimes.get(record.sessionId);
    const pending = runtime?.pendingInput;
    if (!runtime || !pending || pending.requestId !== record.requestId || record.turnId !== runtime.turnId) return;
    const questionId = String(record.payload["questionId"] ?? "");
    const state = pending.questions.find((item) => item.question.id === questionId);
    const selectedIndex = formValues?.["choice"];
    if (!state || questionId in pending.answers || selectedIndex === undefined || !/^(?:0|[1-9]\d*)$/u.test(selectedIndex)) return;
    const option = state.question.options[Number(selectedIndex)];
    if (!option) return;
    const note = (formValues?.["note"] ?? "").trim().slice(0, 1_000);
    const answer = note ? `${option.label}\n\nNote: ${note}` : option.label;
    pending.answers[questionId] = answer;
    await this.resolveQuestionCard(state, {
      title: state.view.title, question: state.view.question, status: "selected", answer: option.label, ...(note ? { note } : {}), resolvedAt: Date.now(),
    });
    await this.finishInputIfComplete(runtime);
  }

  private async answerFreeformInput(runtime: RuntimeTurn, text: string): Promise<void> {
    const pending = runtime.pendingInput;
    if (!pending) return;
    const state = pending.questions.find((item) => !(item.question.id in pending.answers) && item.question.allowFreeform);
    if (!state) { await this.messaging.sendText("Please submit one of the choices on the question card."); return; }
    pending.answers[state.question.id] = text;
    await this.resolveQuestionCard(state, { title: state.view.title, question: state.view.question, status: "custom", answer: text, resolvedAt: Date.now() });
    await this.finishInputIfComplete(runtime);
  }

  private async finishInputIfComplete(runtime: RuntimeTurn): Promise<void> {
    const pending = runtime.pendingInput;
    if (!pending || pending.questions.some((state) => !(state.question.id in pending.answers))) return;
    await this.driver.resolveInput(pending.requestId, pending.answers);
    this.store.audit({ eventType: "input.answered", summary: `${pending.questions.length} agent question(s) answered`, sessionId: runtime.session.id, turnId: runtime.turnId });
    delete runtime.pendingInput; runtime.phase = "working"; runtime.safeSummary = "Answer sent. Codex is continuing..."; runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "working" });
    await this.flushStatus(runtime.session.id, true);
  }

  private async stopActiveTurn(source: string, record?: InteractionRecord): Promise<void> {
    const runtime = record ? this.runtimes.get(record.sessionId) : this.selectedRuntime();
    if (!runtime || !isActiveState(runtime.phase)) { await this.messaging.sendText("No active turn to stop."); return; }
    if (record && (record.sessionId !== runtime.session.id || record.turnId !== runtime.turnId)) return;
    runtime.phase = "stopping"; runtime.safeSummary = "Stopping Codex..."; runtime.dirty = true;
    this.store.updateTurn(runtime.turnId, { state: "stopping" });
    for (const pending of runtime.pendingApprovals.values()) {
      clearTimeout(pending.expiryTimer);
      await this.driver.resolveApproval(pending.id, "cancel").catch(() => undefined);
      await this.resolveApprovalCard(pending, "cancel");
    }
    runtime.pendingApprovals.clear();
    if (runtime.pendingInput) await this.withdrawPendingInput(runtime);
    await this.driver.interruptTurn(runtime.session.id);
    this.store.audit({ eventType: "turn.stopped", summary: `Stop requested from ${source}`, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.flushStatus(runtime.session.id, true);
  }

  private async completeRuntime(runtime: RuntimeTurn, status: "completed" | "stopped"): Promise<void> {
    for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.expiryTimer);
    if (runtime.pendingInput) await this.withdrawPendingInput(runtime);
    runtime.phase = "completed"; runtime.safeSummary ||= status === "stopped" ? "Turn stopped." : "Turn completed."; runtime.dirty = false;
    this.store.updateTurn(runtime.turnId, { state: "completed", safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary, completed: true });
    this.store.addMilestone(runtime.session.id, runtime.turnId, "turn.completed", { status, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary });
    this.store.audit({ eventType: "turn.completed", summary: status, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.statusFlushes.get(runtime.session.id);
    await this.sendResult(runtime, status === "stopped" ? "stopped" : "completed");
    if (this.selectedSession?.id === runtime.session.id) this.selectedSession = { ...runtime.session, state: "completed", lastTurnId: runtime.turnId, updatedAt: Date.now() };
    this.runtimes.delete(runtime.session.id);
    if (status === "completed" && runtime.completedPlan !== null) {
      await this.sendPostPlanChoices(runtime.session, runtime.turnId, runtime.completedPlan).catch((error) => {
        this.logger.warn({ sessionId: runtime.session.id, turnId: runtime.turnId, errorMessage: redact((error as Error).message, this.redactions).slice(0, 500) }, "Could not send post-plan mode choices");
      });
    }
  }

  private async failRuntime(runtime: RuntimeTurn, error: string): Promise<void> {
    for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.expiryTimer);
    if (runtime.pendingInput) await this.withdrawPendingInput(runtime);
    runtime.phase = "failed"; runtime.safeSummary = redact(error, this.redactions).slice(0, 1_500); runtime.dirty = false;
    this.store.updateTurn(runtime.turnId, { state: "failed", safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary, completed: true });
    this.store.addMilestone(runtime.session.id, runtime.turnId, "turn.failed", { error: runtime.safeSummary });
    this.store.audit({ eventType: "turn.failed", summary: runtime.safeSummary, sessionId: runtime.session.id, turnId: runtime.turnId });
    await this.statusFlushes.get(runtime.session.id);
    await this.sendResult(runtime, "failed");
    if (this.selectedSession?.id === runtime.session.id) this.selectedSession = { ...runtime.session, state: "failed", lastTurnId: runtime.turnId, updatedAt: Date.now() };
    this.runtimes.delete(runtime.session.id);
  }

  private async sendResult(runtime: RuntimeTurn, status: TurnResultView["status"]): Promise<void> {
    const expiresAt = Date.now() + 14 * 86_400_000;
    const view: TurnResultView = {
      sessionId: runtime.session.id, turnId: runtime.turnId, title: runtime.session.title, projectName: runtime.project.name, status, summary: status === "failed" ? runtime.safeSummary : status === "completed" ? runtime.completedPlan?.slice(0, 1_500) ?? (this.latestReply(runtime) || runtime.safeSummary) : this.replySummary(runtime) || runtime.safeSummary, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary,
      actionTokens: {
        diff: this.issue("diff.show", runtime.session.id, runtime.turnId, runtime.turnId, expiresAt, { page: 1 }),
        logs: this.issue("logs.show", runtime.session.id, runtime.turnId, runtime.turnId, expiresAt, { page: 1 }),
        continue: this.issue("session.continue", runtime.session.id, runtime.turnId, runtime.session.id, expiresAt, {}),
        newTask: this.issue("task.new", runtime.session.id, runtime.turnId, runtime.session.id, expiresAt, {}),
      },
    };
    const queueKey = `turn:${runtime.turnId}:status`;
    if (runtime.statusRef) {
      const payload = { ref: runtime.statusRef, view };
      await this.safeSend("result.update", payload, () => this.messaging.updateResult(runtime.statusRef!, view), payload, queueKey);
    } else {
      await this.safeSend("result", view, () => this.messaging.sendResult(view), view, queueKey);
    }
  }

  private async sendPostPlanChoices(session: StoredSession, turnId: string, plan: string): Promise<void> {
    const presets = await this.driver.listInstructionPresets();
    const defaultPreset = presets.find((preset) => preset.mode === "default");
    const planPreset = presets.find((preset) => preset.mode === "plan");
    if (!defaultPreset || !planPreset) return;
    const expiresAt = Date.now() + 15 * 60_000;
    const token = this.issue("plan.select", session.id, turnId, turnId, expiresAt, { plan, defaultPresetId: defaultPreset.id, planPresetId: planPreset.id });
    const view: ChoiceView = {
      title: "Choose how Codex should proceed",
      description: `The plan for ${session.title} is complete.`,
      actionKind: "plan.select",
      choices: [
        { label: "Yes, implement this plan", description: "Switch to Default and start coding.", value: "implement", token },
        { label: "Yes, clear context and implement", description: "Start a fresh Default-mode session with the approved plan.", value: "fresh", token },
        { label: "No, stay in Plan mode", description: "Continue planning with the model.", value: "stay", token },
      ],
    };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async selectPostPlanAction(record: InteractionRecord, choice?: string): Promise<void> {
    const session = this.store.getSession(record.sessionId);
    if (!session) { await this.messaging.sendText("That Codex session is no longer available."); return; }
    const project = this.store.getProject(session.projectId);
    if (!project) { await this.messaging.sendText("The session project is no longer registered."); return; }
    if (this.runtimes.has(session.id)) { await this.messaging.sendText("That Codex session already has an active turn."); return; }
    const defaultPresetId = typeof record.payload["defaultPresetId"] === "string" ? record.payload["defaultPresetId"] : null;
    const planPresetId = typeof record.payload["planPresetId"] === "string" ? record.payload["planPresetId"] : null;
    try {
      switch (choice) {
        case "stay": {
          if (!planPresetId) throw new Error("Codex Plan mode is no longer available");
          await this.driver.resumeSession(session.id, project, { managed: session.botCreated });
          await this.driver.selectInstructionPreset(session.id, planPresetId);
          this.selectedSession = session;
          this.rememberProject(project.id);
          const message = "Staying in Plan mode. Send any changes or questions to continue refining the plan.";
          await this.safeSend("text", message, () => this.messaging.sendText(message));
          return;
        }
        case "implement":
          if (!defaultPresetId) throw new Error("Codex Default mode is no longer available");
          await this.driver.resumeSession(session.id, project, { managed: session.botCreated });
          await this.driver.selectInstructionPreset(session.id, defaultPresetId);
          await this.startTurn(session, IMPLEMENT_PLAN_PROMPT);
          return;
        case "fresh": {
          if (!defaultPresetId) throw new Error("Codex Default mode is no longer available");
          const plan = typeof record.payload["plan"] === "string" ? record.payload["plan"].trim() : "";
          if (!plan) throw new Error("The approved plan is no longer available");
          const freshSession = await this.createSelectedSession(project, null, false, `Implement ${session.title}`);
          await this.driver.selectInstructionPreset(freshSession.id, defaultPresetId);
          await this.startTurn(freshSession, `${FRESH_IMPLEMENT_PLAN_PROMPT}\n\n${plan}`);
          return;
        }
        default:
          throw new Error("That post-plan choice is no longer available");
      }
    } catch (error) {
      const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
      this.store.audit({ eventType: "plan.select.failed", summary: errorMessage, sessionId: session.id, turnId: record.turnId });
      this.logger.warn({ sessionId: session.id, turnId: record.turnId, choice, errorMessage }, "Could not apply post-plan choice");
      await this.safeSend("text", `Could not apply the post-plan choice: ${errorMessage}`, () => this.messaging.sendText(`Could not apply the post-plan choice: ${errorMessage}`));
    }
  }

  private async sendProjectChoices(description?: string): Promise<void> {
    const projects = this.store.listProjects();
    if (!projects.length) { await this.messaging.sendText("No projects are registered. Add one locally with: pulsectl project add <name> <path>"); return; }
    const expiresAt = Date.now() + 15 * 60_000;
    const view: ChoiceView = { title: "Choose a project", ...(description ? { description } : {}), actionKind: "project.select", choices: projects.map((project) => ({ label: project.name, description: project.canonicalPath, value: project.id, token: this.issue("project.select", "new", "new", project.id, expiresAt, { purpose: "new" }) })) };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async selectProject(projectId: string): Promise<void> {
    const project = this.store.getProject(projectId); if (!project) return;
    if (this.selectedSession?.projectId !== project.id) this.selectedSession = null;
    this.rememberProject(project.id);
    const showInstructionChoices = this.pendingInstructionChoices; this.pendingInstructionChoices = false;
    if (showInstructionChoices) {
      await this.createSelectedSession(project, null, false);
      await this.sendInstructionChoices();
      return;
    }
    const prompt = this.pendingPrompt; this.pendingPrompt = null;
    const createNewSession = this.pendingPromptCreatesSession; this.pendingPromptCreatesSession = false;
    if (createNewSession) { await this.createSelectedSession(project, prompt); return; }
    await this.refreshSessions();
    const running = [...this.controllableSessions.values()]
      .filter((candidate) => candidate.project.id === project.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (running) {
      this.selectedSession = running.session;
      const runtime = this.runtimes.get(running.session.id);
      if (prompt) {
        if (runtime?.pendingInput) await this.answerFreeformInput(runtime, prompt);
        else if (runtime) await this.steerRuntime(runtime, prompt, `Using running Codex session ${running.session.id} in ${project.name}. Your message was sent.`);
        else await this.startTurn(running.session, prompt);
      } else {
        const message = runningSessionSelectedMessage(running);
        await this.safeSend("text", message, () => this.messaging.sendText(message));
      }
      return;
    }
    const standalone = [...this.uncontrollableSessions.values()]
      .filter((candidate) => candidate.project.id === project.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (standalone) {
      await this.messaging.sendText(standaloneSessionMessage(standalone));
      return;
    }
    await this.createSelectedSession(project, prompt);
  }

  private async sendSessionChoices(page = 1, refresh = true): Promise<void> {
    if (refresh) await this.refreshSessions();
    const sessions = this.store.listSessions(100);
    if (!sessions.length) { await this.messaging.sendText("No Codex sessions were found in registered projects."); return; }
    const pageSize = 3;
    const totalPages = Math.ceil(sessions.length / pageSize);
    const boundedPage = Math.min(totalPages, Math.max(1, Math.floor(page)));
    const visible = sessions.slice((boundedPage - 1) * pageSize, boundedPage * pageSize);
    const expiresAt = Date.now() + 15 * 60_000;
    const view: ChoiceView = {
      title: `Select a Codex session (${boundedPage}/${totalPages})`, actionKind: "session.select",
      choices: visible.map((session) => ({ label: truncateWords(session.title, 100), description: `ID: ${session.id}\n${session.state} - ${new Date(session.updatedAt).toLocaleString()}`, value: session.id, token: this.issue("session.select", session.id, session.lastTurnId ?? "none", session.id, expiresAt, {}) })),
      ...(boundedPage > 1 ? { previousToken: this.issue("sessions.more", "sessions", "none", "sessions", expiresAt, { page: boundedPage - 1 }) } : {}),
      ...(boundedPage < totalPages ? { nextToken: this.issue("sessions.more", "sessions", "none", "sessions", expiresAt, { page: boundedPage + 1 }) } : {}),
    };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async sendInstructionChoices(): Promise<void> {
    await this.refreshSessions();
    let session = this.selectedSession;
    if (!session) {
      const projects = this.store.listProjects();
      const project = this.selectedProject() ?? (projects.length === 1 ? projects[0]! : null);
      if (project) session = await this.createSelectedSession(project, null, false);
      else {
        this.pendingInstructionChoices = projects.length > 1;
        await this.sendProjectChoices("Choose the project for this new session.");
        return;
      }
    }
    const expiresAt = Date.now() + 15 * 60_000;
    const commandView: ChoiceView = {
      title: "Run a Codex built-in command",
      description: `Choose a command to run in ${session.title}.`,
      actionKind: "instructions.command",
      choices: SELECTABLE_CODEX_BUILTIN_COMMANDS.map((command) => ({
        label: command.label,
        description: command.description,
        value: command.id,
        token: this.issue("instructions.command", session.id, session.lastTurnId ?? "none", command.id, expiresAt, {}),
      })),
    };
    await this.safeSend("choices", commandView, () => this.messaging.sendChoices(commandView));
    const presets = await this.driver.listInstructionPresets();
    if (!presets.length) {
      const message = "Codex did not report any built-in instruction presets.";
      await this.safeSend("text", message, () => this.messaging.sendText(message));
      return;
    }
    const view: ChoiceView = {
      title: "Choose Codex instructions",
      description: `Select the built-in instructions for ${session.title}. The choice applies to subsequent turns.`,
      actionKind: "instructions.select",
      choices: presets.map((preset) => ({
        label: preset.label,
        description: [`Mode: ${preset.mode}`, ...(preset.model ? [`Model: ${preset.model}`] : []), ...(preset.reasoningEffort ? [`Reasoning: ${preset.reasoningEffort}`] : [])].join("\n"),
        value: preset.id,
        token: this.issue("instructions.select", session.id, session.lastTurnId ?? "none", preset.id, expiresAt, {}),
      })),
    };
    await this.safeSend("choices", view, () => this.messaging.sendChoices(view));
  }

  private async selectBuiltinCommand(sessionId: string, commandId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      await this.messaging.sendText("That Codex session is no longer available.");
      return;
    }
    if (this.runtimes.has(session.id)) {
      await this.messaging.sendText("Codex built-in commands are unavailable while a turn is active.");
      return;
    }
    const project = this.store.getProject(session.projectId);
    if (!project) {
      await this.messaging.sendText("The session project is no longer registered.");
      return;
    }
    try {
      switch (commandId) {
        case "init":
          await this.startTurn(session, CODEX_INIT_PROMPT);
          return;
        case "compact": {
          await this.driver.resumeSession(session.id, project, { managed: session.botCreated });
          await this.driver.compactSession(session.id);
          this.selectedSession = session;
          this.rememberProject(project.id);
          const message = `Compacted ${session.title}.`;
          await this.safeSend("text", message, () => this.messaging.sendText(message));
          return;
        }
        default:
          throw new Error("That Codex built-in command is no longer available");
      }
    } catch (error) {
      const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
      this.store.audit({ eventType: "instructions.command.failed", summary: errorMessage, sessionId: session.id, ...(session.lastTurnId ? { turnId: session.lastTurnId } : {}) });
      this.logger.warn({ sessionId: session.id, commandId, errorMessage }, "Could not run Codex built-in command");
      const message = `Could not run the Codex built-in command: ${errorMessage}`;
      await this.safeSend("text", message, () => this.messaging.sendText(message));
    }
  }

  private async selectInstructionPreset(sessionId: string, presetId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      await this.messaging.sendText("That Codex session is no longer available.");
      return;
    }
    try {
      const preset = await this.driver.selectInstructionPreset(session.id, presetId);
      const message = `Using Codex's ${preset.label} instructions for ${session.title}. The choice applies to subsequent turns.`;
      await this.safeSend("text", message, () => this.messaging.sendText(message));
    } catch (error) {
      const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
      this.store.audit({ eventType: "instructions.select.failed", summary: errorMessage, sessionId: session.id, ...(session.lastTurnId ? { turnId: session.lastTurnId } : {}) });
      this.logger.warn({ sessionId: session.id, errorMessage }, "Could not select Codex instructions");
      const message = `Could not select Codex instructions: ${errorMessage}`;
      await this.safeSend("text", message, () => this.messaging.sendText(message));
    }
  }

  private async resumeStoredSession(id: string): Promise<void> {
    await this.refreshSessions();
    const session = this.store.getSession(id);
    if (!session) { await this.messaging.sendText("That session is unavailable or is outside the registered projects."); return; }
    const runtime = this.runtimes.get(session.id);
    if (runtime) {
      this.selectedSession = runtime.session;
      this.rememberProject(runtime.project.id);
      await this.messaging.sendText(`Selected active session ${session.title}. New messages will steer it.`);
      return;
    }
    const project = this.store.getProject(session.projectId); if (!project) { await this.messaging.sendText("The session project is no longer registered."); return; }
    try { await this.driver.resumeSession(session.id, project, { managed: session.botCreated }); }
    catch (error) {
      const errorMessage = redact((error as Error).message, this.redactions).slice(0, 500);
      this.store.audit({ eventType: "session.select.failed", summary: errorMessage, sessionId: session.id, ...(session.lastTurnId ? { turnId: session.lastTurnId } : {}) });
      this.logger.warn({ sessionId: session.id, errorMessage }, "Could not select Codex session");
      await this.messaging.sendText(sessionSelectionFailure(session.title, errorMessage));
      return;
    }
    this.selectedSession = session;
    this.rememberProject(project.id);
    await this.messaging.sendText(`Resumed ${session.title}. Send a message to start the next turn.`);
  }

  private async refreshSessions(): Promise<SessionRefreshResult> {
    if (this.sessionRefresh) return this.sessionRefresh;
    const operation = this.performSessionRefresh();
    this.sessionRefresh = operation;
    try { return await operation; }
    finally { if (this.sessionRefresh === operation) this.sessionRefresh = null; }
  }

  private async performSessionRefresh(): Promise<SessionRefreshResult> {
    const projects = this.store.listProjects();
    const discovered = await this.driver.listSessions(projects);
    const previousControllable = this.controllableSessions;
    const currentControllable = new Map<string, ProjectSession>();
    const currentUncontrollable = new Map<string, ProjectSession>();
    const newlyControllable: ProjectSession[] = [];
    for (const info of discovered) {
      const session = this.store.upsertDiscoveredSession(info);
      const project = this.store.getProject(info.projectId);
      if (!project) continue;
      const controllable = info.loaded && info.canAcceptDirectInput;
      const candidate = { session, project, updatedAt: info.updatedAt };
      if (controllable) {
        currentControllable.set(info.id, candidate);
        if (!previousControllable.has(info.id) && !this.runtimes.has(info.id) && this.selectedSession?.id !== info.id) newlyControllable.push(candidate);
      } else if (isActiveState(info.state)) {
        currentUncontrollable.set(info.id, candidate);
      }
      if (this.selectedSession?.id === info.id) this.selectedSession = session;
      if (!controllable || !info.activeTurnId || info.state === "idle" || !isActiveState(info.state) || this.runtimes.has(info.id)) continue;
      try { await this.driver.resumeSession(info.id, project, { managed: info.botCreated }); }
      catch (error) {
        this.logger.debug({ sessionId: info.id, errorMessage: redact((error as Error).message, this.redactions).slice(0, 500) }, "Active Codex session is owned by another runtime");
        continue;
      }
      this.store.attachTurn({ id: info.activeTurnId, sessionId: info.id, state: info.state, startedAt: info.updatedAt });
      const runtime = this.makeRuntime(session, project, info.activeTurnId, info.state, info.updatedAt, "Connected to a running Codex turn.");
      this.runtimes.set(info.id, runtime);
    }
    this.controllableSessions = currentControllable;
    this.uncontrollableSessions = currentUncontrollable;
    return { newlyControllable };
  }

  private async sendPagedOutput(kind: "logs.show" | "diff.show", sessionId: string | undefined, requestedPage: number, requestedTurnId?: string): Promise<void> {
    if (!sessionId) { await this.messaging.sendText("No session selected."); return; }
    const session = this.store.getSession(sessionId); const turnId = requestedTurnId ?? this.runtimes.get(sessionId)?.turnId ?? session?.lastTurnId;
    if (!session || !turnId) { await this.messaging.sendText("No turn output is available."); return; }
    const turn = this.store.getTurn(turnId);
    if (!turn || String(turn["session_id"]) !== sessionId) { await this.messaging.sendText("That turn output is no longer available."); return; }
    const view = await this.makeOutputView(kind, sessionId, turnId, requestedPage);
    await this.safeSend("output", view, () => this.messaging.sendOutput(view), { actionKind: kind, sessionId, turnId, page: view.page });
  }

  private makeStatusView(runtime: RuntimeTurn): SessionView {
    const pendingApproval = [...runtime.pendingApprovals.values()].at(-1);
    return { sessionId: runtime.session.id, turnId: runtime.turnId, title: runtime.session.title, projectName: runtime.project.name, phase: runtime.phase, startedAt: runtime.startedAt, updatedAt: Date.now(), safeSummary: runtime.safeSummary, ...(runtime.replies.length ? { replies: runtime.replies.map((reply) => reply.text) } : {}), recentCommands: runtime.recentCommands, ...(pendingApproval ? { pendingApproval: { id: pendingApproval.id, kind: pendingApproval.kind, summary: pendingApproval.summary } } : {}), actionTokens: runtime.actionTokens };
  }

  private appendReply(runtime: RuntimeTurn, messageId: string, delta: string): void {
    const safeDelta = redact(delta, this.redactions);
    const current = runtime.replies.at(-1);
    if (current?.id === messageId) current.text += safeDelta;
    else runtime.replies.push({ id: messageId, text: safeDelta });
    while (this.replySummary(runtime).length > 1_500 && runtime.replies.length > 1) runtime.replies.shift();
    const newest = runtime.replies.at(-1);
    if (newest && this.replySummary(runtime).length > 1_500) newest.text = newest.text.slice(-1_500);
    runtime.safeSummary = this.replySummary(runtime);
  }

  private replySummary(runtime: RuntimeTurn): string {
    return runtime.replies.map((reply) => reply.text).join("\n\n");
  }

  private latestReply(runtime: RuntimeTurn): string {
    return runtime.replies.findLast((reply) => reply.text.trim())?.text ?? "";
  }

  private async resolveApprovalCard(pending: PendingApprovalState, decision: ApprovalResolutionView["decision"]): Promise<void> {
    if (!pending.ref) return;
    const resolution: ApprovalResolutionView = { title: pending.summary, decision, resolvedAt: Date.now() };
    await this.safeSend("approval.update", { ref: pending.ref, resolution }, () => this.messaging.updateApproval(pending.ref!, resolution), { ref: pending.ref, resolution }, `approval:${pending.id}:resolution`);
    if (pending.kind !== "command" && this.messaging.removeApproval) {
      await this.safeSend("approval.remove", { ref: pending.ref }, () => this.messaging.removeApproval!(pending.ref!), { ref: pending.ref }, `approval:${pending.id}:remove`);
    }
  }

  private async resolveQuestionCard(state: PendingQuestionState, resolution: QuestionResolutionView): Promise<void> {
    if (!state.ref) return;
    const payload = { ref: state.ref, resolution };
    await this.safeSend("question.update", payload, () => this.messaging.updateQuestion(state.ref!, resolution), payload, `question:${state.view.requestId}:${state.question.id}:resolution`);
  }

  private async withdrawPendingInput(runtime: RuntimeTurn): Promise<void> {
    const pending = runtime.pendingInput;
    if (!pending) return;
    const resolvedAt = Date.now();
    for (const state of pending.questions) {
      if (!(state.question.id in pending.answers)) {
        await this.resolveQuestionCard(state, { title: state.view.title, question: state.view.question, status: "withdrawn", resolvedAt });
      }
    }
    if (runtime.pendingInput === pending) delete runtime.pendingInput;
  }

  private makeRuntime(session: StoredSession, project: Project, turnId: string, phase: TurnPhase, startedAt: number, safeSummary: string): RuntimeTurn {
    const expiresAt = Date.now() + 14 * 86_400_000;
    return {
      session: { ...session, lastTurnId: turnId, state: phase, updatedAt: Date.now() }, project, turnId, phase, startedAt, safeSummary, completedPlan: null,
      replies: [], recentCommands: [], diff: "", changedFileCount: 0, testSummary: "", statusRef: null, pendingApprovals: new Map(),
      actionTokens: {
        stop: this.issue("turn.stop", session.id, turnId, turnId, expiresAt, {}),
        logs: this.issue("logs.show", session.id, turnId, turnId, expiresAt, { page: 1 }),
        diff: this.issue("diff.show", session.id, turnId, turnId, expiresAt, { page: 1 }),
      },
      dirty: true,
    };
  }

  private async flushStatuses(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map(async (sessionId) => this.flushStatus(sessionId)));
  }

  private async flushStatus(sessionId: string, force = false): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || (!runtime.dirty && !force)) return;
    const pending = this.statusFlushes.get(sessionId);
    if (pending) { await pending; return; }
    runtime.dirty = false;
    const view = this.makeStatusView(runtime);
    this.store.updateTurn(runtime.turnId, { state: runtime.phase, safeSummary: runtime.safeSummary, diff: runtime.diff, changedFileCount: runtime.changedFileCount, testSummary: runtime.testSummary });
    const flush = (async () => {
      const queueKey = `turn:${runtime.turnId}:status`;
      if (runtime.statusRef) await this.safeSend("status.update", { ref: runtime.statusRef, view }, () => this.messaging.updateStatus(runtime.statusRef!, view), { ref: runtime.statusRef, view }, queueKey);
      else await this.safeSend("status", view, async () => { runtime.statusRef = await this.messaging.sendStatus(view); }, view, queueKey);
    })().finally(() => { this.statusFlushes.delete(sessionId); });
    this.statusFlushes.set(sessionId, flush);
    await flush;
    // Events can update the view while the adapter is sending it. Keep those
    // changes on the same card instead of leaving an orphaned starting card.
    if (this.runtimes.get(sessionId) === runtime && runtime.dirty) await this.flushStatus(sessionId);
  }

  private selectedRuntime(): RuntimeTurn | null {
    if (this.selectedSession) return this.runtimes.get(this.selectedSession.id) ?? null;
    const candidates = [...this.runtimes.values()].filter((runtime) => !this.selectedProjectId || runtime.project.id === this.selectedProjectId);
    return candidates.length === 1 && this.controllableSessions.size <= 1 ? candidates[0]! : null;
  }

  private selectedProject(): Project | null {
    return this.selectedProjectId ? this.store.getProject(this.selectedProjectId) : null;
  }

  private selectSoleControllableSession(): void {
    if (this.selectedSession) return;
    const candidates = [...this.controllableSessions.values()].filter((candidate) => !this.selectedProjectId || candidate.project.id === this.selectedProjectId);
    if (candidates.length !== 1) return;
    this.selectedSession = candidates[0]!.session;
    this.rememberProject(candidates[0]!.project.id);
  }

  private rememberProject(projectId: string): void {
    if (this.selectedProjectId === projectId) return;
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("The selected project is no longer registered");
    this.store.setLocalSetting("defaultProject", project.name);
    this.selectedProjectId = projectId;
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
      case "status": {
        const view = payload as unknown as SessionView;
        const ref = await this.messaging.sendStatus(view);
        const runtime = this.runtimes.get(view.sessionId);
        if (runtime?.turnId === view.turnId) runtime.statusRef = ref;
        break;
      }
      case "status.update": { const value = payload as unknown as { ref: MessageRef; view: SessionView }; await this.messaging.updateStatus(value.ref, value.view); break; }
      case "approval": {
        const view = payload as unknown as ApprovalView;
        const ref = await this.messaging.sendApproval(view);
        const runtime = this.runtimes.get(view.sessionId);
        const pending = runtime?.pendingApprovals.get(view.approvalId);
        if (runtime?.turnId === view.turnId && pending) pending.ref = ref;
        break;
      }
      case "approval.update": { const value = payload as unknown as { ref: MessageRef; resolution: ApprovalResolutionView }; await this.messaging.updateApproval(value.ref, value.resolution); break; }
      case "approval.remove": {
        const value = payload as unknown as { ref: MessageRef };
        if (this.messaging.removeApproval) await this.messaging.removeApproval(value.ref);
        break;
      }
      case "result": await this.messaging.sendResult(payload as unknown as TurnResultView); break;
      case "result.update": { const value = payload as unknown as { ref: MessageRef; view: TurnResultView }; await this.messaging.updateResult(value.ref, value.view); break; }
      case "choices": await this.messaging.sendChoices(payload as unknown as ChoiceView); break;
      case "question": {
        const view = payload as unknown as QuestionView;
        const runtime = this.runtimes.get(view.sessionId);
        const state = runtime?.pendingInput?.requestId === view.requestId
          ? runtime.pendingInput.questions.find((item) => item.question.id === view.questionId)
          : undefined;
        if (!state || runtime?.turnId !== view.turnId) break;
        state.ref = await this.messaging.sendQuestion(view);
        break;
      }
      case "question.update": { const value = payload as unknown as { ref: MessageRef; resolution: QuestionResolutionView }; await this.messaging.updateQuestion(value.ref, value.resolution); break; }
      case "output": {
        if ("content" in payload) await this.messaging.sendOutput(payload as unknown as OutputView);
        else await this.messaging.sendOutput(await this.makeOutputView(payload["actionKind"] as "logs.show" | "diff.show", String(payload["sessionId"]), String(payload["turnId"]), Number(payload["page"] ?? 1)));
        break;
      }
    }
  }

  private async makeOutputView(kind: "logs.show" | "diff.show", sessionId: string, turnId: string, requestedPage: number): Promise<OutputView> {
    const runtime = this.runtimes.get(sessionId);
    const activeDiff = runtime?.turnId === turnId ? runtime.diff : "";
    const storedDiff = String(this.store.getTurn(turnId)?.["diff_text"] ?? "");
    const content = kind === "logs.show" ? await this.commandLogs.read(turnId) : activeDiff || storedDiff || "No diff recorded.";
    const page = paginate(redact(content, this.redactions), requestedPage);
    const expiresAt = Date.now() + 15 * 60_000;
    return {
      title: kind === "logs.show" ? "Codex logs" : "Unified diff", content: page.text, page: page.page, totalPages: page.totalPages, actionKind: kind,
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

function truncateWords(value: string, limit: number): string {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.length > limit ? `${words.slice(0, limit).join(" ")}...` : words.join(" ");
}

function sessionSelectionFailure(title: string, errorMessage: string): string {
  const name = redact(title).slice(0, 120);
  if (/active writer|already (?:has|owned by).*writer|already loaded/iu.test(errorMessage)) return `Cannot select ${name}: it is open in a separate Codex runtime. Close that session and relaunch it with the PulseCortex Codex integration.`;
  if (/no rollout found/iu.test(errorMessage)) return `Cannot select ${name}: its saved Codex history is no longer available.`;
  return `Cannot select ${name}: Codex could not resume this session. Check the local PulseCortex log for details.`;
}

function runningSessionSelectedMessage(running: ProjectSession): string {
  const title = redact(running.session.title).slice(0, 120);
  const project = redact(running.project.name).slice(0, 120);
  return `Using running Codex session ${title} in ${project} (${running.session.id}) by default. Send /send <message> to message it.`;
}

function standaloneSessionMessage(running: ProjectSession): string {
  const title = redact(running.session.title).slice(0, 120);
  const project = redact(running.project.name).slice(0, 120);
  return `Detected active Codex session ${title} in ${project} (${running.session.id}), but it was launched outside the PulseCortex shared app-server and cannot receive Feishu messages. Close it and relaunch with pnpm pulsectl codex ${project}, or install the PulseCortex shell integration and run codex again.`;
}
