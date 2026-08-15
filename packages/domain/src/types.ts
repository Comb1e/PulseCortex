export type SessionId = string;
export type TurnId = string;
export type ApprovalId = string;
export type Unsubscribe = () => void;

export interface Project {
  id: string;
  name: string;
  canonicalPath: string;
  createdAt: number;
}

export interface OwnerIdentity {
  tenantId: string;
  userId: string;
}

export interface MessageRef {
  messageId: string;
  chatId: string;
}

export interface SessionOptions {
  model?: string;
  title?: string;
}

export interface AgentCapabilities {
  cliVersion: string;
  protocolMajor: number;
  userAgent: string;
  supportsSteer: boolean;
  supportsApprovals: boolean;
}

export type TurnPhase =
  | "starting"
  | "working"
  | "awaiting_approval"
  | "awaiting_input"
  | "stopping"
  | "completed"
  | "failed"
  | "interrupted_unknown";

export interface SessionView {
  sessionId: SessionId;
  turnId: TurnId;
  title: string;
  projectName: string;
  phase: TurnPhase;
  startedAt: number;
  updatedAt: number;
  safeSummary: string;
  recentCommands: string[];
  pendingApproval?: { id: ApprovalId; kind: ApprovalKind; summary: string };
  actionTokens: { stop: string; logs: string; diff: string };
}

export type ApprovalKind = "command" | "file" | "filesystem" | "network";

export interface NetworkDestination {
  host: string;
  protocol: string;
  port?: number;
}

export interface ApprovalView {
  approvalId: ApprovalId;
  sessionId: SessionId;
  turnId: TurnId;
  kind: ApprovalKind;
  title: string;
  reason?: string;
  command?: string;
  files?: string[];
  paths?: string[];
  network?: NetworkDestination[];
  actionTokens: { accept: string; decline: string; cancel: string };
  expiresAt: number;
}

export interface TurnResultView {
  sessionId: SessionId;
  turnId: TurnId;
  title: string;
  projectName: string;
  status: "completed" | "failed" | "stopped" | "interrupted_unknown";
  summary: string;
  changedFileCount: number;
  testSummary: string;
  actionTokens: { diff: string; logs: string; continue: string; newTask: string };
}

export interface ChoiceView {
  title: string;
  description?: string;
  actionKind: "project.select" | "session.select";
  choices: Array<{ label: string; description?: string; token: string; value: string }>;
}

export interface QuestionView {
  sessionId: SessionId;
  turnId: TurnId;
  requestId: string;
  title: string;
  question: string;
  options: Array<{ label: string; description?: string; token: string; value: string }>;
  freeformAccepted: boolean;
}

export interface OutputView {
  title: string;
  content: string;
  page: number;
  totalPages: number;
  actionKind: "logs.show" | "diff.show";
  previousToken?: string;
  nextToken?: string;
}

export interface ChannelActor extends OwnerIdentity {
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
}

export type CommandName =
  | "pair"
  | "projects"
  | "new"
  | "sessions"
  | "resume"
  | "send"
  | "status"
  | "stop"
  | "logs"
  | "diff"
  | "help";

export interface ChannelCommand {
  eventId: string;
  messageId: string;
  actor: ChannelActor;
  name: CommandName | "text" | "unknown";
  args: string[];
  text: string;
  receivedAt: number;
}

export type ChannelActionKind =
  | "approval.accept"
  | "approval.decline"
  | "turn.stop"
  | "logs.show"
  | "diff.show"
  | "session.continue"
  | "task.new"
  | "project.select"
  | "session.select"
  | "input.answer";

export interface ChannelAction {
  eventId: string;
  actor: ChannelActor;
  kind: ChannelActionKind;
  token: string;
  value?: string;
  receivedAt: number;
}

export interface InputOption {
  label: string;
  description?: string;
}

export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  options: InputOption[];
  allowFreeform: boolean;
}

export type AgentEvent =
  | { type: "turn.started"; sessionId: SessionId; turnId: TurnId; occurredAt: number }
  | { type: "agent.message.delta"; sessionId: SessionId; turnId: TurnId; delta: string; occurredAt: number }
  | { type: "command.started"; sessionId: SessionId; turnId: TurnId; commandId: string; command: string; occurredAt: number }
  | { type: "command.completed"; sessionId: SessionId; turnId: TurnId; commandId: string; exitCode?: number; occurredAt: number }
  | { type: "approval.requested"; sessionId: SessionId; turnId: TurnId; approvalId: ApprovalId; kind: ApprovalKind; title: string; reason?: string; command?: string; files?: string[]; paths?: string[]; network?: NetworkDestination[]; occurredAt: number }
  | { type: "input.requested"; sessionId: SessionId; turnId: TurnId; requestId: string; questions: InputQuestion[]; occurredAt: number }
  | { type: "diff.updated"; sessionId: SessionId; turnId: TurnId; diff: string; occurredAt: number }
  | { type: "turn.completed"; sessionId: SessionId; turnId: TurnId; status: "completed" | "stopped"; occurredAt: number }
  | { type: "turn.failed"; sessionId: SessionId; turnId: TurnId; error: string; occurredAt: number }
  | { type: "driver.crashed"; error: string; occurredAt: number };

export interface StoredSession {
  id: SessionId;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastTurnId: TurnId | null;
  state: TurnPhase | "idle";
  botCreated: boolean;
}
