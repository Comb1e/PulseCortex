import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentCapabilities, AgentDriver, AgentEvent, ApprovalId, NetworkDestination, Project, SessionId, SessionOptions, TurnId, Unsubscribe,
} from "@pulsecortex/domain";
import { isPathInside, summarizeCommand } from "@pulsecortex/domain";
import type { CommandLogStore } from "@pulsecortex/persistence";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
import type { AdditionalFileSystemPermissions } from "./generated/v2/AdditionalFileSystemPermissions";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification";
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import { SUPPORTED_CODEX_CLI_SERIES, SUPPORTED_PROTOCOL_MAJOR, type JsonRpcNotification, type JsonRpcRequest } from "./protocol.js";
import { JsonlRpcTransport, type TransportOptions } from "./transport.js";
import { resolveCodexInvocation } from "./launcher.js";

const execFileAsync = promisify(execFile);

interface PendingServerRequest { rpcId: string | number; method: string; params: Record<string, unknown> }

export interface CodexDriverOptions extends TransportOptions {
  verifyVersion?: boolean;
  commandLogs?: CommandLogStore;
  supportedCliSeries?: string;
}

function now(): number { return Date.now(); }
function textInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> { return [{ type: "text", text, text_elements: [] }]; }

function parseVersion(output: string): string {
  const match = output.match(/(\d+\.\d+\.\d+)/u);
  if (!match?.[1]) throw new Error(`Unable to parse Codex CLI version from: ${output.trim()}`);
  return match[1];
}

export async function detectCodexVersion(executable?: string): Promise<{ version: string; compatible: boolean }> {
  const invocation = resolveCodexInvocation(executable);
  const { stdout } = await execFileAsync(invocation.executable, [...invocation.prefixArgs, "--version"], { windowsHide: true });
  const version = parseVersion(stdout);
  return { version, compatible: version.startsWith(`${SUPPORTED_CODEX_CLI_SERIES}.`) || version === SUPPORTED_CODEX_CLI_SERIES };
}

function extractPaths(params: PermissionsRequestApprovalParams): string[] {
  const fs = params.permissions.fileSystem;
  if (!fs) return [];
  const paths = [...(fs.read ?? []), ...(fs.write ?? [])];
  for (const entry of fs.entries ?? []) {
    const value = entry.path;
    if (typeof value === "string") paths.push(value);
    else if (value && typeof value === "object" && "path" in value) paths.push(String((value as { path: unknown }).path));
  }
  return [...new Set(paths)];
}

function requestedPathInside(root: string, candidate: string): boolean {
  return isPathInside(root, path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate));
}

function filesystemPermissionIsSafe(permission: AdditionalFileSystemPermissions | null | undefined, root: string): boolean {
  if (!permission) return true;
  if ([...(permission.read ?? []), ...(permission.write ?? [])].some((candidate) => !requestedPathInside(root, candidate))) return false;
  for (const entry of permission.entries ?? []) {
    if (entry.access === "deny") continue;
    if (entry.path.type === "path") { if (!requestedPathInside(root, entry.path.path)) return false; continue; }
    if (entry.path.type === "special" && entry.path.value.kind === "project_roots") continue;
    return false;
  }
  return true;
}

function networkDestinations(params: CommandExecutionRequestApprovalParams): NetworkDestination[] {
  if (params.networkApprovalContext) return [{ host: params.networkApprovalContext.host, protocol: params.networkApprovalContext.protocol }];
  return (params.proposedNetworkPolicyAmendments ?? []).map((item) => ({ host: item.host, protocol: "network" }));
}

export class CodexAppServerDriver implements AgentDriver {
  private readonly transport: JsonlRpcTransport;
  private readonly handlers = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, PendingServerRequest>();
  private readonly activeTurns = new Map<SessionId, TurnId>();
  private readonly projectRoots = new Map<SessionId, string>();
  private readonly eventBuffers = new Map<SessionId, AgentEvent[]>();
  private cliVersion = "unknown";
  private started = false;

  constructor(private readonly options: CodexDriverOptions = {}) {
    this.transport = new JsonlRpcTransport(options);
    this.transport.on("notification", (message: JsonRpcNotification) => this.handleNotification(message));
    this.transport.on("request", (message: JsonRpcRequest) => this.handleRequest(message));
    this.transport.on("crash", (error: Error) => this.handleCrash(error));
    this.transport.on("protocolError", (error: Error) => { void this.handleProtocolError(error); });
  }

  async start(): Promise<AgentCapabilities> {
    if (this.started) throw new Error("Codex driver already started");
    if (this.options.verifyVersion !== false) {
      const detected = await detectCodexVersion(this.options.executable);
      this.cliVersion = detected.version;
      const supported = this.options.supportedCliSeries ?? SUPPORTED_CODEX_CLI_SERIES;
      if (!this.cliVersion.startsWith(`${supported}.`) && this.cliVersion !== supported) {
        throw new Error(`Unsupported Codex CLI ${this.cliVersion}; PulseCortex protocol snapshot requires ${supported}.x`);
      }
    } else this.cliVersion = this.options.supportedCliSeries ?? `${SUPPORTED_CODEX_CLI_SERIES}.0`;
    this.transport.start();
    try {
      const initialized = await this.transport.request<InitializeResponse>("initialize", {
        clientInfo: { name: "pulsecortex", title: "PulseCortex", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.transport.notify("initialized");
      this.started = true;
      return { cliVersion: this.cliVersion, protocolMajor: SUPPORTED_PROTOCOL_MAJOR, userAgent: initialized.userAgent, supportsSteer: true, supportsApprovals: true };
    } catch (error) {
      await this.transport.stop();
      throw error;
    }
  }

  async stop(): Promise<void> { this.started = false; this.eventBuffers.clear(); await this.transport.stop(); }

  async createSession(project: Project, options: SessionOptions): Promise<SessionId> {
    this.assertStarted();
    const response = await this.transport.request<ThreadStartResponse>("thread/start", {
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      model: options.model ?? null,
      serviceName: "PulseCortex",
      threadSource: "pulsecortex",
      ephemeral: false,
    });
    if (!isPathInside(project.canonicalPath, response.cwd)) throw new Error("Codex returned a working directory outside the registered project");
    this.projectRoots.set(response.thread.id, project.canonicalPath);
    return response.thread.id;
  }

  async resumeSession(id: SessionId, project: Project): Promise<void> {
    this.assertStarted();
    const response = await this.transport.request<ThreadResumeResponse>("thread/resume", {
      threadId: id, cwd: project.canonicalPath, runtimeWorkspaceRoots: [project.canonicalPath], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", excludeTurns: true,
    });
    if (response.thread.id !== id || !isPathInside(project.canonicalPath, response.cwd)) throw new Error("Codex resume did not match the registered session and project");
    this.projectRoots.set(id, project.canonicalPath);
  }

  async startTurn(id: SessionId, prompt: string): Promise<TurnId> {
    this.assertSession(id);
    if (this.activeTurns.has(id)) throw new Error("This session already has an active turn");
    const root = this.projectRoots.get(id)!;
    this.eventBuffers.set(id, []);
    try {
      const response = await this.transport.request<TurnStartResponse>("turn/start", {
        threadId: id,
        input: textInput(prompt),
        cwd: root,
        runtimeWorkspaceRoots: [root],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      });
      this.activeTurns.set(id, response.turn.id);
      setImmediate(() => this.flushEventBuffer(id));
      return response.turn.id;
    } catch (error) {
      this.eventBuffers.delete(id);
      throw error;
    }
  }

  async steerTurn(id: SessionId, text: string): Promise<void> {
    const turnId = this.activeTurns.get(id);
    if (!turnId) throw new Error("No active turn to steer");
    await this.transport.request("turn/steer", { threadId: id, expectedTurnId: turnId, input: textInput(text) });
  }

  async interruptTurn(id: SessionId): Promise<void> {
    const turnId = this.activeTurns.get(id);
    if (!turnId) throw new Error("No active turn to interrupt");
    await this.transport.request("turn/interrupt", { threadId: id, turnId });
  }

  async resolveApproval(id: ApprovalId, decision: "accept" | "decline" | "cancel"): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Approval is stale or already resolved");
    this.pending.delete(id);
    if (pending.method === "item/permissions/requestApproval") {
      if (decision === "accept") {
        const requested = pending.params["permissions"] as Record<string, unknown>;
        this.transport.respond(pending.rpcId, { permissions: { ...(requested["network"] ? { network: requested["network"] } : {}), ...(requested["fileSystem"] ? { fileSystem: requested["fileSystem"] } : {}) }, scope: "turn" });
      } else this.transport.respondError(pending.rpcId, -32001, decision === "cancel" ? "Permission request cancelled" : "Permission request declined");
    } else if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
      this.transport.respond(pending.rpcId, { decision: decision === "accept" ? "approved" : decision === "decline" ? { denied: { rejection: "Denied by PulseCortex owner" } } : "abort" });
    } else this.transport.respond(pending.rpcId, { decision });
  }

  async resolveInput(id: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.method !== "item/tool/requestUserInput") throw new Error("Input request is stale or already resolved");
    this.pending.delete(id);
    this.transport.respond(pending.rpcId, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) });
  }

  subscribe(handler: (event: AgentEvent) => void): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  private handleRequest(request: JsonRpcRequest): void {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const sessionId = String(params["threadId"] ?? params["conversationId"] ?? "");
    const turnId = String(params["turnId"] ?? this.activeTurns.get(sessionId) ?? "");
    const baseId = String(params["approvalId"] ?? params["itemId"] ?? params["callId"] ?? request.id);
    const approvalId = `${sessionId}:${turnId}:${baseId}`;
    if (request.method === "item/tool/requestUserInput") {
      const input = request.params as ToolRequestUserInputParams;
      if (input.questions.some((question) => question.isSecret)) {
        this.transport.respondError(request.id, -32002, "Remote secret input is disabled by PulseCortex");
        void this.transport.request("turn/interrupt", { threadId: sessionId, turnId }).catch(() => undefined);
        this.emit({ type: "turn.failed", sessionId, turnId, error: "Codex requested secret input; remote entry is disabled", occurredAt: now() });
        return;
      }
      this.pending.set(approvalId, { rpcId: request.id, method: request.method, params });
      this.emit({ type: "input.requested", sessionId, turnId, requestId: approvalId, questions: input.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, options: (q.options ?? []).map((option) => ({ label: option.label, description: option.description ?? undefined })), allowFreeform: q.isOther })), occurredAt: now() });
      return;
    }
    if (request.method === "item/commandExecution/requestApproval") {
      const input = request.params as CommandExecutionRequestApprovalParams;
      const network = networkDestinations(input);
      const root = this.projectRoots.get(sessionId);
      if (input.additionalPermissions?.network?.enabled && network.length === 0) {
        this.transport.respondError(request.id, -32004, "Broad network permission is disabled; use a destination-specific network request");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied a broad network grant without a destination.", occurredAt: now() });
        return;
      }
      if (!root || !filesystemPermissionIsSafe(input.additionalPermissions?.fileSystem, root)) {
        this.transport.respondError(request.id, -32003, "Filesystem permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied filesystem access outside the registered project.", occurredAt: now() });
        return;
      }
      this.pending.set(approvalId, { rpcId: request.id, method: request.method, params });
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: network.length ? "network" : "command", title: network.length ? "Network access requested" : "Command approval requested", ...(input.reason ? { reason: input.reason } : {}), ...(input.command ? { command: summarizeCommand(input.command) } : {}), ...(network.length ? { network } : {}), occurredAt: now() });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      const input = request.params as FileChangeRequestApprovalParams;
      const root = this.projectRoots.get(sessionId);
      if (input.grantRoot && root && !requestedPathInside(root, input.grantRoot)) {
        this.transport.respondError(request.id, -32003, "Write permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied a write root outside the registered project.", occurredAt: now() });
        return;
      }
      this.pending.set(approvalId, { rpcId: request.id, method: request.method, params });
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: "file", title: "File change approval requested", ...(input.reason ? { reason: input.reason } : {}), ...(input.grantRoot ? { paths: [input.grantRoot] } : {}), occurredAt: now() });
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      const input = request.params as PermissionsRequestApprovalParams;
      if (input.permissions.network?.enabled) {
        this.transport.respondError(request.id, -32004, "Broad network permission is disabled; use a destination-specific network request");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied a broad network grant without a destination.", occurredAt: now() });
        return;
      }
      const kind = input.permissions.network?.enabled ? "network" : "filesystem";
      const paths = extractPaths(input);
      const root = this.projectRoots.get(sessionId);
      if (!root || !filesystemPermissionIsSafe(input.permissions.fileSystem, root) || paths.some((candidate) => !requestedPathInside(root, candidate))) {
        this.transport.respondError(request.id, -32003, "Filesystem permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied filesystem access outside the registered project.", occurredAt: now() });
        return;
      }
      this.pending.set(approvalId, { rpcId: request.id, method: request.method, params });
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind, title: kind === "network" ? "Network permission requested" : "Filesystem permission requested", ...(input.reason ? { reason: input.reason } : {}), ...(paths.length ? { paths } : {}), ...(kind === "network" ? { network: [{ host: "unspecified destination", protocol: "network" }] } : {}), occurredAt: now() });
      return;
    }
    if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      const root = this.projectRoots.get(sessionId);
      if (request.method === "applyPatchApproval" && (!root || Object.keys((params["fileChanges"] as object | undefined) ?? {}).some((candidate) => !requestedPathInside(root, candidate)))) {
        this.transport.respondError(request.id, -32003, "File change outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, delta: " PulseCortex denied a file change outside the registered project.", occurredAt: now() });
        return;
      }
      this.pending.set(approvalId, { rpcId: request.id, method: request.method, params });
      const command = Array.isArray(params["command"]) ? (params["command"] as string[]).join(" ") : undefined;
      const fileChanges = params["fileChanges"] && typeof params["fileChanges"] === "object" ? Object.keys(params["fileChanges"] as object) : [];
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: command ? "command" : "file", title: command ? "Command approval requested" : "File change approval requested", ...(command ? { command: summarizeCommand(command) } : {}), ...(fileChanges.length ? { files: fileChanges } : {}), occurredAt: now() });
      return;
    }
    this.transport.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
  }

  private handleNotification(message: JsonRpcNotification): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const sessionId = String(params["threadId"] ?? "");
    const turnId = String(params["turnId"] ?? (params["turn"] as Record<string, unknown> | undefined)?.["id"] ?? this.activeTurns.get(sessionId) ?? "");
    switch (message.method) {
      case "turn/started": this.activeTurns.set(sessionId, turnId); this.emit({ type: "turn.started", sessionId, turnId, occurredAt: now() }); break;
      case "item/agentMessage/delta": this.emit({ type: "agent.message.delta", sessionId, turnId, delta: String(params["delta"] ?? ""), occurredAt: now() }); break;
      case "turn/diff/updated": this.emit({ type: "diff.updated", sessionId, turnId, diff: String(params["diff"] ?? ""), occurredAt: now() }); break;
      case "item/commandExecution/outputDelta": void this.options.commandLogs?.append(turnId, "stdout", String(params["delta"] ?? "")).catch(() => undefined); break;
      case "item/started": this.handleItemStarted(message.params as ItemStartedNotification); break;
      case "item/completed": this.handleItemCompleted(message.params as ItemCompletedNotification); break;
      case "turn/completed": {
        const input = message.params as TurnCompletedNotification;
        this.activeTurns.delete(input.threadId);
        if (input.turn.status === "failed") this.emit({ type: "turn.failed", sessionId: input.threadId, turnId: input.turn.id, error: input.turn.error?.message ?? "Codex turn failed", occurredAt: now() });
        else this.emit({ type: "turn.completed", sessionId: input.threadId, turnId: input.turn.id, status: input.turn.status === "interrupted" ? "stopped" : "completed", occurredAt: now() });
        break;
      }
      case "error": {
        const error = params["error"] as Record<string, unknown> | undefined;
        if (!params["willRetry"]) this.emit({ type: "turn.failed", sessionId, turnId, error: String(error?.["message"] ?? "Codex turn error"), occurredAt: now() });
        break;
      }
    }
  }

  private handleItemStarted(input: ItemStartedNotification): void {
    if (input.item.type === "commandExecution") this.emit({ type: "command.started", sessionId: input.threadId, turnId: input.turnId, commandId: input.item.id, command: summarizeCommand(input.item.command), occurredAt: input.startedAtMs });
  }

  private handleItemCompleted(input: ItemCompletedNotification): void {
    if (input.item.type === "commandExecution") this.emit({ type: "command.completed", sessionId: input.threadId, turnId: input.turnId, commandId: input.item.id, ...(input.item.exitCode === null ? {} : { exitCode: input.item.exitCode }), occurredAt: input.completedAtMs });
  }

  private emit(event: AgentEvent): void {
    if (event.type !== "driver.crashed") {
      const buffered = this.eventBuffers.get(event.sessionId);
      if (buffered) { buffered.push(event); return; }
    }
    for (const handler of this.handlers) handler(event);
  }
  private flushEventBuffer(sessionId: SessionId): void {
    const events = this.eventBuffers.get(sessionId);
    if (!events) return;
    this.eventBuffers.delete(sessionId);
    for (const event of events) this.emit(event);
  }
  private handleCrash(error: Error): void {
    if (!this.started) return;
    this.started = false;
    this.activeTurns.clear();
    this.pending.clear();
    this.eventBuffers.clear();
    this.emit({ type: "driver.crashed", error: error.message, occurredAt: now() });
  }
  private async handleProtocolError(error: Error): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.activeTurns.clear();
    this.pending.clear();
    this.eventBuffers.clear();
    await this.transport.stop();
    this.emit({ type: "driver.crashed", error: error.message, occurredAt: now() });
  }
  private assertStarted(): void { if (!this.started) throw new Error("Codex driver is not started"); }
  private assertSession(id: SessionId): void { this.assertStarted(); if (!this.projectRoots.has(id)) throw new Error("Session is not loaded by PulseCortex"); }
}
