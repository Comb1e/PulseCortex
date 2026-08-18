import type {
  AgentCapabilities,
  AgentEvent,
  AgentSessionInfo,
  ApprovalId,
  ApprovalResolutionView,
  ApprovalView,
  ChoiceView,
  ChannelAction,
  ChannelCommand,
  MessageRef,
  OutputView,
  Project,
  SessionId,
  SessionOptions,
  SessionView,
  QuestionView,
  TurnId,
  TurnResultView,
  Unsubscribe,
} from "./types.js";

export interface MessagingAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendStatus(view: SessionView): Promise<MessageRef>;
  updateStatus(ref: MessageRef, view: SessionView): Promise<void>;
  sendApproval(request: ApprovalView): Promise<MessageRef>;
  updateApproval(ref: MessageRef, resolution: ApprovalResolutionView): Promise<void>;
  /** Remove a resolved approval prompt so the active status card is last in chat. */
  removeApproval?(ref: MessageRef): Promise<void>;
  sendResult(result: TurnResultView): Promise<void>;
  sendChoices(view: ChoiceView): Promise<void>;
  sendQuestion(view: QuestionView): Promise<void>;
  sendOutput(view: OutputView): Promise<void>;
  sendText(text: string): Promise<void>;
  onCommand(handler: (command: ChannelCommand) => Promise<void>): void;
  onAction(handler: (action: ChannelAction) => Promise<void>): void;
}

export interface AgentDriver {
  start(): Promise<AgentCapabilities>;
  stop(): Promise<void>;
  createSession(project: Project, options: SessionOptions): Promise<SessionId>;
  resumeSession(id: SessionId, project: Project): Promise<void>;
  listSessions(projects: Project[]): Promise<AgentSessionInfo[]>;
  startTurn(id: SessionId, prompt: string): Promise<TurnId>;
  steerTurn(id: SessionId, text: string): Promise<void>;
  interruptTurn(id: SessionId): Promise<void>;
  resolveApproval(id: ApprovalId, decision: "accept" | "decline" | "cancel"): Promise<void>;
  resolveInput(id: string, answers: Record<string, string>): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): Unsubscribe;
}
