import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentCapabilities, AgentDriver, AgentEvent, AgentInstructionPreset, AgentSessionInfo, ApprovalId, NetworkDestination, Project, ResumeSessionOptions, SessionId, SessionOptions, TurnId, Unsubscribe,
} from "@pulsecortex/domain";
import { canonicalProjectPath, isPathInside, summarizeCommand } from "@pulsecortex/domain";
import type { CommandLogStore } from "@pulsecortex/persistence";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { FunctionCallOutputBody } from "./generated/FunctionCallOutputBody";
import type { ReasoningEffort } from "./generated/ReasoningEffort";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
import type { CollaborationModeListResponse } from "./generated/v2/CollaborationModeListResponse";
import type { CollaborationModeMask } from "./generated/v2/CollaborationModeMask";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { AdditionalFileSystemPermissions } from "./generated/v2/AdditionalFileSystemPermissions";
import type { EnvironmentStatusResponse } from "./generated/v2/EnvironmentStatusResponse";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification";
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadResponse } from "./generated/v2/ModelProviderCapabilitiesReadResponse";
import type { RawResponseItemCompletedNotification } from "./generated/v2/RawResponseItemCompletedNotification";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadLoadedListResponse } from "./generated/v2/ThreadLoadedListResponse";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import {
  isSupportedCodexVersion, SUPPORTED_CODEX_CLI_REQUIREMENT, SUPPORTED_CODEX_CLI_SERIES, SUPPORTED_PROTOCOL_MAJOR,
  type JsonRpcNotification, type JsonRpcRequest,
} from "./protocol.js";
import { JsonlRpcTransport, type TransportOptions } from "./transport.js";
import { codexEnvironment, resolveCodexInvocation } from "./launcher.js";

const execFileAsync = promisify(execFile);

interface PendingServerRequest { rpcId: string | number; method: string; params: Record<string, unknown> }
interface SessionSettings { model: string; reasoningEffort: ReasoningEffort | null }

export interface CodexDriverDiagnostic {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  sessionId?: SessionId;
  details?: Record<string, unknown>;
}

export interface CodexDriverOptions extends TransportOptions {
  verifyVersion?: boolean;
  commandLogs?: CommandLogStore;
  permissionProfile?: string;
  supportedCliSeries?: string;
  onDiagnostic?: (diagnostic: CodexDriverDiagnostic) => void;
}

function now(): number { return Date.now(); }
function textInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> { return [{ type: "text", text, text_elements: [] }]; }

const MANAGED_THREAD_CONFIG = { features: { multi_agent: false } } as const;
const TOOL_ARGUMENT_ERROR_PREFIX = "failed to parse function arguments:";
const TOOL_CALL_WARNING_THRESHOLD = 5;

function functionCallOutputText(output: FunctionCallOutputBody): string {
  if (typeof output === "string") return output;
  return output.flatMap((item) => item.type === "input_text" ? [item.text] : []).join("\n");
}

function parseVersion(output: string): string {
  const match = output.match(/(\d+\.\d+\.\d+)/u);
  if (!match?.[1]) throw new Error(`Unable to parse Codex CLI version from: ${output.trim()}`);
  return match[1];
}

export async function detectCodexVersion(executable?: string): Promise<{ version: string; compatible: boolean }> {
  const invocation = resolveCodexInvocation(executable);
  const { stdout } = await execFileAsync(invocation.executable, [...invocation.prefixArgs, "--version"], { env: codexEnvironment(), windowsHide: true });
  const version = parseVersion(stdout);
  return { version, compatible: isSupportedCodexVersion(version) };
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

async function canonicalPotentialPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function requestedPathInside(root: string, candidate: string, cwd = root): Promise<boolean> {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  return isPathInside(root, await canonicalPotentialPath(resolved));
}

async function filesystemPermissionIsSafe(permission: AdditionalFileSystemPermissions | null | undefined, root: string, cwd: string): Promise<boolean> {
  if (!permission) return true;
  for (const candidate of [...(permission.read ?? []), ...(permission.write ?? [])]) {
    if (!await requestedPathInside(root, candidate, cwd)) return false;
  }
  for (const entry of permission.entries ?? []) {
    if (entry.access === "deny") continue;
    if (entry.path.type === "path") { if (!await requestedPathInside(root, entry.path.path, cwd)) return false; continue; }
    if (entry.path.type === "special" && entry.path.value.kind === "project_roots") continue;
    return false;
  }
  return true;
}

function networkDestinations(params: CommandExecutionRequestApprovalParams): NetworkDestination[] {
  if (params.networkApprovalContext) return [{ host: params.networkApprovalContext.host, protocol: params.networkApprovalContext.protocol }];
  return (params.proposedNetworkPolicyAmendments ?? []).map((item) => ({ host: item.host, protocol: "network" }));
}

function canAutoApproveCommand(pending: PendingServerRequest): boolean {
  if (pending.method === "execCommandApproval") return true;
  if (pending.method !== "item/commandExecution/requestApproval") return false;
  const params = pending.params as CommandExecutionRequestApprovalParams;
  const available = params.availableDecisions;
  return networkDestinations(params).length === 0
    && !params.additionalPermissions?.network?.enabled
    && !params.additionalPermissions?.fileSystem
    && (!available || available.includes("acceptForSession"));
}

export class CodexAppServerDriver implements AgentDriver {
  private readonly transport: JsonlRpcTransport;
  private readonly handlers = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, PendingServerRequest>();
  private readonly validatingServerRequests = new Set<string>();
  private readonly resolvedServerRequests = new Set<string>();
  private readonly activeTurns = new Map<SessionId, TurnId>();
  private readonly failedTurns = new Set<string>();
  private readonly projectRoots = new Map<SessionId, string>();
  private readonly sessionCwds = new Map<SessionId, string>();
  private readonly disconnectedEnvironments = new Map<SessionId, Set<string>>();
  private readonly directInputSessions = new Set<SessionId>();
  private readonly managedSessions = new Set<SessionId>();
  private readonly sessionSettings = new Map<SessionId, SessionSettings>();
  private readonly eventBuffers = new Map<SessionId, AgentEvent[]>();
  private readonly toolCallFailureStreaks = new Map<string, number>();
  private cliVersion = "unknown";
  private codexHome: string | null = null;
  private stderrBuffer = "";
  private started = false;

  constructor(private readonly options: CodexDriverOptions = {}) {
    this.transport = new JsonlRpcTransport(options);
    this.transport.on("notification", (message: JsonRpcNotification) => this.handleNotification(message));
    this.transport.on("request", (message: JsonRpcRequest) => {
      this.validatingServerRequests.add(String(message.id));
      void this.handleRequest(message).catch((error) => {
        this.transport.respondError(message.id, -32003, "PulseCortex could not validate the requested permission");
        this.reportDiagnostic("error", "Permission validation failed", undefined, { method: message.method, error: (error as Error).message });
      }).finally(() => this.validatingServerRequests.delete(String(message.id)));
    });
    this.transport.on("crash", (error: Error) => this.handleCrash(error));
    this.transport.on("protocolError", (error: Error) => { void this.handleProtocolError(error); });
    this.transport.on("stdout", (output: string) => this.reportDiagnostic("debug", "Codex app-server stdout", undefined, { output: output.trim() }));
    this.transport.on("stderr", (output: string) => this.handleStderr(output));
  }

  async start(): Promise<AgentCapabilities> {
    if (this.started) throw new Error("Codex driver already started");
    if (this.options.verifyVersion !== false) {
      const detected = await detectCodexVersion(this.options.executable);
      this.cliVersion = detected.version;
      const supported = this.options.supportedCliSeries ?? SUPPORTED_CODEX_CLI_SERIES;
      const compatible = this.options.supportedCliSeries
        ? this.cliVersion.startsWith(`${supported}.`) || this.cliVersion === supported
        : isSupportedCodexVersion(this.cliVersion);
      if (!compatible) {
        const requirement = this.options.supportedCliSeries ? `${supported}.x` : SUPPORTED_CODEX_CLI_REQUIREMENT;
        throw new Error(`Unsupported Codex CLI ${this.cliVersion}; PulseCortex protocol snapshot requires ${requirement}`);
      }
    } else this.cliVersion = this.options.supportedCliSeries ?? `${SUPPORTED_CODEX_CLI_SERIES}.0`;
    try {
      await this.transport.start();
      const initialized = await this.transport.request<InitializeResponse>("initialize", {
        clientInfo: { name: "pulsecortex", title: "PulseCortex", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.transport.notify("initialized");
      this.codexHome = initialized.codexHome;
      const providerCapabilities = await this.transport.request<ModelProviderCapabilitiesReadResponse>("modelProvider/capabilities/read", {});
      this.started = true;
      this.reportDiagnostic(providerCapabilities.namespaceTools ? "info" : "warn", providerCapabilities.namespaceTools
        ? "Codex model provider reports namespace-tool support"
        : "Codex model provider does not support namespace tools; PulseCortex-managed sessions use single-agent tools", undefined, providerCapabilities);
      return {
        cliVersion: this.cliVersion,
        protocolMajor: SUPPORTED_PROTOCOL_MAJOR,
        userAgent: initialized.userAgent,
        supportsSteer: true,
        supportsApprovals: true,
        supportsNamespaceTools: providerCapabilities.namespaceTools,
      };
    } catch (error) {
      await this.transport.stop();
      throw error;
    }
  }

  async stop(): Promise<void> { this.started = false; this.codexHome = null; this.stderrBuffer = ""; this.activeTurns.clear(); this.failedTurns.clear(); this.projectRoots.clear(); this.sessionCwds.clear(); this.disconnectedEnvironments.clear(); this.directInputSessions.clear(); this.managedSessions.clear(); this.sessionSettings.clear(); this.pending.clear(); this.validatingServerRequests.clear(); this.resolvedServerRequests.clear(); this.eventBuffers.clear(); this.toolCallFailureStreaks.clear(); await this.transport.stop(); }

  async createSession(project: Project, options: SessionOptions): Promise<SessionId> {
    this.assertStarted();
    const response = await this.transport.request<ThreadStartResponse>("thread/start", {
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: this.options.permissionProfile ?? ":workspace",
      config: MANAGED_THREAD_CONFIG,
      model: options.model ?? null,
      serviceName: "PulseCortex",
      threadSource: "pulsecortex",
      ephemeral: false,
      historyMode: "paginated",
      experimentalRawEvents: true,
    });
    if (!isPathInside(project.canonicalPath, response.cwd)) throw new Error("Codex returned a working directory outside the registered project");
    this.projectRoots.set(response.thread.id, project.canonicalPath);
    this.sessionCwds.set(response.thread.id, response.cwd);
    this.directInputSessions.add(response.thread.id);
    this.managedSessions.add(response.thread.id);
    this.sessionSettings.set(response.thread.id, { model: response.model, reasoningEffort: response.reasoningEffort });
    this.reportPermissionProfile(response.thread.id, response.activePermissionProfile?.id);
    return response.thread.id;
  }

  async resumeSession(id: SessionId, project: Project, options: ResumeSessionOptions): Promise<void> {
    await this.resumeSessionAtCwd(id, project, project.canonicalPath, options.managed);
  }

  private async resumeSessionAtCwd(id: SessionId, project: Project, cwd: string, managed: boolean): Promise<void> {
    this.assertStarted();
    const loadedRoot = this.projectRoots.get(id);
    if (loadedRoot) {
      if (!isPathInside(loadedRoot, project.canonicalPath) || !isPathInside(project.canonicalPath, loadedRoot)) throw new Error("Loaded session project does not match the registered project");
      this.setManaged(id, managed);
      if (this.directInputSessions.has(id)) return;
    }
    const response = await this.transport.request<ThreadResumeResponse>("thread/resume", {
      threadId: id,
      cwd,
      excludeTurns: false,
      ...(managed ? {
        runtimeWorkspaceRoots: [project.canonicalPath],
        approvalPolicy: "on-request" as const,
        approvalsReviewer: "user" as const,
        permissions: this.options.permissionProfile ?? ":workspace",
        config: MANAGED_THREAD_CONFIG,
      } : {}),
    });
    if (response.thread.id !== id || !isPathInside(project.canonicalPath, response.cwd)) throw new Error("Codex resume did not match the registered session and project");
    if (response.thread.canAcceptDirectInput === false) throw new Error("Codex rejoined the session without granting direct input");
    this.projectRoots.set(id, project.canonicalPath);
    this.sessionCwds.set(id, response.cwd);
    this.directInputSessions.add(id);
    this.setManaged(id, managed);
    this.sessionSettings.set(id, { model: response.model, reasoningEffort: response.reasoningEffort });
    if (managed) this.reportPermissionProfile(id, response.activePermissionProfile?.id);
    const activeTurn = response.thread.turns?.findLast((turn) => turn.status === "inProgress");
    if (activeTurn) this.activeTurns.set(id, activeTurn.id);
  }

  async listSessions(projects: Project[]): Promise<AgentSessionInfo[]> {
    this.assertStarted();
    if (!projects.length) return [];
    const loaded = new Set<string>();
    let loadedCursor: string | null = null;
    do {
      const response: ThreadLoadedListResponse = await this.transport.request<ThreadLoadedListResponse>("thread/loaded/list", { cursor: loadedCursor, limit: 100 });
      for (const id of response.data) loaded.add(id);
      loadedCursor = response.nextCursor;
    } while (loadedCursor);
    const writerLocked = await this.listWriterLockedThreads();
    for (const id of [...this.projectRoots.keys()]) {
      if (loaded.has(id)) continue;
      this.projectRoots.delete(id);
      this.sessionCwds.delete(id);
      this.disconnectedEnvironments.delete(id);
      this.directInputSessions.delete(id);
      this.managedSessions.delete(id);
      this.sessionSettings.delete(id);
      this.activeTurns.delete(id);
    }
    const sessions: AgentSessionInfo[] = [];
    let cursor: string | null = null;
    do {
      const response: ThreadListResponse = await this.transport.request<ThreadListResponse>("thread/list", {
        cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "appServer"], archived: false, useStateDbOnly: true,
      });
      for (const thread of response.data) {
        let canonicalCwd: string;
        try { canonicalCwd = await canonicalProjectPath(thread.cwd); }
        catch { continue; }
        const project = projects.find((candidate) => isPathInside(candidate.canonicalPath, canonicalCwd));
        if (!project) continue;
        const isLoaded = loaded.has(thread.id);
        const isExternallyRunning = !isLoaded && writerLocked.has(thread.id);
        const managed = thread.threadSource === "pulsecortex";
        if (isLoaded) {
          this.projectRoots.set(thread.id, project.canonicalPath);
          this.sessionCwds.set(thread.id, canonicalCwd);
          this.setManaged(thread.id, managed);
        }
        else this.directInputSessions.delete(thread.id);
        let detail: ThreadReadResponse | undefined;
        if (thread.status.type === "active" || (isLoaded && thread.canAcceptDirectInput !== true)) {
          detail = await this.transport.request<ThreadReadResponse>("thread/read", { threadId: thread.id, includeTurns: thread.status.type === "active" });
        }
        let canAcceptDirectInput = isLoaded && (detail?.thread.canAcceptDirectInput ?? thread.canAcceptDirectInput) === true;
        if (canAcceptDirectInput) this.directInputSessions.add(thread.id);
        else if (isLoaded) {
          this.directInputSessions.delete(thread.id);
          try {
            await this.resumeSessionAtCwd(thread.id, project, canonicalCwd, managed);
            detail = await this.transport.request<ThreadReadResponse>("thread/read", { threadId: thread.id, includeTurns: thread.status.type === "active" });
            canAcceptDirectInput = this.directInputSessions.has(thread.id) && detail.thread.canAcceptDirectInput !== false;
          } catch (error) {
            if (!isWriterConflict(error)) throw error;
          }
        }
        let activeTurnId: string | undefined;
        if (thread.status.type === "active") {
          activeTurnId = detail!.thread.turns.findLast((turn) => turn.status === "inProgress")?.id;
          if (activeTurnId && canAcceptDirectInput) this.activeTurns.set(thread.id, activeTurnId);
        }
        const state = thread.status.type === "active"
          ? thread.status.activeFlags.includes("waitingOnApproval") ? "awaiting_approval" : thread.status.activeFlags.includes("waitingOnUserInput") ? "awaiting_input" : "working"
          : isExternallyRunning ? "working"
          : thread.status.type === "systemError" ? "failed" : "idle";
        sessions.push({
          id: thread.id, projectId: project.id, title: thread.name?.trim() || thread.preview.trim() || `Codex ${thread.id.slice(0, 8)}`, state, loaded: isLoaded, canAcceptDirectInput,
          ...(activeTurnId ? { activeTurnId } : {}), createdAt: thread.createdAt * 1_000, updatedAt: thread.updatedAt * 1_000,
          botCreated: thread.threadSource === "pulsecortex",
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
    return sessions;
  }

  async listInstructionPresets(): Promise<AgentInstructionPreset[]> {
    this.assertStarted();
    const presets = await this.fetchInstructionPresets();
    return presets.flatMap((preset) => preset.mode === null ? [] : [{
      id: preset.name,
      label: preset.name,
      mode: preset.mode,
      ...(preset.model === null ? {} : { model: preset.model }),
      ...(preset.reasoning_effort === null ? {} : { reasoningEffort: preset.reasoning_effort }),
    }]);
  }

  async selectInstructionPreset(id: SessionId, presetId: string): Promise<AgentInstructionPreset> {
    this.assertSession(id);
    const preset = (await this.fetchInstructionPresets()).find((candidate) => candidate.name === presetId && candidate.mode !== null);
    if (!preset?.mode) throw new Error("That Codex instruction preset is no longer available");
    const current = await this.settingsForSession(id);
    const model = preset.model ?? current.model;
    const reasoningEffort = preset.reasoning_effort ?? current.reasoningEffort;
    await this.transport.request("thread/settings/update", {
      threadId: id,
      collaborationMode: {
        mode: preset.mode,
        settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null },
      },
    });
    this.sessionSettings.set(id, { model, reasoningEffort });
    return {
      id: preset.name,
      label: preset.name,
      mode: preset.mode,
      ...(preset.model === null ? {} : { model: preset.model }),
      ...(preset.reasoning_effort === null ? {} : { reasoningEffort: preset.reasoning_effort }),
    };
  }

  async compactSession(id: SessionId): Promise<void> {
    this.assertSession(id);
    await this.transport.request("thread/compact/start", { threadId: id });
  }

  private async fetchInstructionPresets(): Promise<CollaborationModeMask[]> {
    const response = await this.transport.request<CollaborationModeListResponse>("collaborationMode/list", {});
    return response.data;
  }

  private async settingsForSession(id: SessionId): Promise<SessionSettings> {
    const cached = this.sessionSettings.get(id);
    if (cached) return cached;
    const cwd = this.projectRoots.get(id)!;
    const configured = await this.transport.request<ConfigReadResponse>("config/read", { cwd, includeLayers: false });
    let model = configured.config.model?.trim() || null;
    if (!model) {
      let cursor: string | null = null;
      do {
        const response: ModelListResponse = await this.transport.request<ModelListResponse>("model/list", { cursor, limit: 100, includeHidden: false });
        model = response.data.find((candidate) => candidate.isDefault)?.model ?? null;
        cursor = response.nextCursor;
      } while (!model && cursor);
    }
    if (!model) throw new Error("Codex did not report a model for this session");
    const settings = { model, reasoningEffort: configured.config.model_reasoning_effort };
    this.sessionSettings.set(id, settings);
    return settings;
  }

  private async listWriterLockedThreads(): Promise<Set<string>> {
    if (!this.codexHome) return new Set();
    try {
      const entries = await readdir(path.join(this.codexHome, "thread-writer-locks"), { withFileTypes: true });
      return new Set(entries
        .filter((entry) => entry.isFile() && entry.name !== ".coordination.lock" && entry.name.endsWith(".lock"))
        .map((entry) => entry.name.slice(0, -".lock".length)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
  }

  async startTurn(id: SessionId, prompt: string): Promise<TurnId> {
    this.assertSession(id);
    if (this.activeTurns.has(id)) throw new Error("This session already has an active turn");
    for (const key of this.failedTurns) if (key.startsWith(`${id}:`)) this.failedTurns.delete(key);
    this.clearToolCallFailureStreaks(id);
    await this.assertEnvironmentAvailable(id);
    const root = this.projectRoots.get(id)!;
    const cwd = this.sessionCwds.get(id) ?? root;
    this.eventBuffers.set(id, []);
    try {
      const response = await this.transport.request<TurnStartResponse>("turn/start", {
        threadId: id,
        input: textInput(prompt),
        ...(this.managedSessions.has(id) ? {
          cwd,
          runtimeWorkspaceRoots: [root],
          approvalPolicy: "on-request" as const,
          approvalsReviewer: "user" as const,
          permissions: this.options.permissionProfile ?? ":workspace",
        } : {}),
      });
      if (!this.failedTurns.has(`${id}:${response.turn.id}`)) this.activeTurns.set(id, response.turn.id);
      try {
        await this.assertEnvironmentAvailable(id);
      } catch (error) {
        const turnId = response.turn.id;
        const wasActive = this.activeTurns.get(id) === turnId;
        this.activeTurns.delete(id);
        this.clearPendingRequests(id, turnId);
        await this.transport.request("turn/interrupt", { threadId: id, turnId: response.turn.id }).catch(() => undefined);
        if (wasActive) {
          this.emit({ type: "turn.failed", sessionId: id, turnId, error: (error as Error).message, occurredAt: now() });
        }
        // A disconnect notification can fail the turn while startTurn is still
        // waiting for its RPC response. Deliver the buffered failure before
        // rejecting, otherwise the outer catch would discard it.
        this.flushEventBuffer(id);
        throw error;
      }
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

  async resolveApproval(id: ApprovalId, decision: "accept" | "acceptForSession" | "decline" | "cancel"): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Approval is stale or already resolved");
    if (decision === "acceptForSession" && !canAutoApproveCommand(pending)) {
      throw new Error("Auto approve is restricted to command requests");
    }
    this.pending.delete(id);
    if (pending.method === "item/permissions/requestApproval") {
      if (decision === "accept") {
        const requested = pending.params["permissions"] as Record<string, unknown>;
        this.transport.respond(pending.rpcId, { permissions: { ...(requested["network"] ? { network: requested["network"] } : {}), ...(requested["fileSystem"] ? { fileSystem: requested["fileSystem"] } : {}) }, scope: "turn" });
      } else this.transport.respondError(pending.rpcId, -32001, decision === "cancel" ? "Permission request cancelled" : "Permission request declined");
    } else if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
      this.transport.respond(pending.rpcId, { decision: decision === "accept" ? "approved" : decision === "acceptForSession" ? "approved_for_session" : decision === "decline" ? { denied: { rejection: "Denied by PulseCortex owner" } } : "abort" });
    } else this.transport.respond(pending.rpcId, { decision });
  }

  async resolveInput(id: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.method !== "item/tool/requestUserInput") throw new Error("Input request is stale or already resolved");
    this.pending.delete(id);
    this.transport.respond(pending.rpcId, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) });
  }

  subscribe(handler: (event: AgentEvent) => void): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const sessionId = String(params["threadId"] ?? params["conversationId"] ?? "");
    const turnId = String(params["turnId"] ?? this.activeTurns.get(sessionId) ?? "");
    const baseId = String(params["approvalId"] ?? params["itemId"] ?? params["callId"] ?? request.id);
    const approvalId = `${sessionId}:${turnId}:${baseId}`;
    if (request.method !== "item/tool/call") this.clearToolCallFailureStreaks(sessionId, turnId);
    if (request.method === "item/tool/requestUserInput") {
      const input = request.params as ToolRequestUserInputParams;
      if (input.questions.some((question) => question.isSecret)) {
        this.transport.respondError(request.id, -32002, "Remote secret input is disabled by PulseCortex");
        void this.transport.request("turn/interrupt", { threadId: sessionId, turnId }).catch(() => undefined);
        this.emit({ type: "turn.failed", sessionId, turnId, error: "Codex requested secret input; remote entry is disabled", occurredAt: now() });
        return;
      }
      if (!this.registerPending(approvalId, { rpcId: request.id, method: request.method, params }, sessionId, turnId)) return;
      this.emit({ type: "input.requested", sessionId, turnId, requestId: approvalId, questions: input.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, options: (q.options ?? []).map((option) => ({ label: option.label, description: option.description ?? undefined })), allowFreeform: q.isOther })), occurredAt: now() });
      return;
    }
    if (request.method === "item/commandExecution/requestApproval") {
      const input = request.params as CommandExecutionRequestApprovalParams;
      const network = networkDestinations(input);
      const root = this.projectRoots.get(sessionId);
      if (input.additionalPermissions?.network?.enabled && network.length === 0) {
        this.transport.respondError(request.id, -32004, "Broad network permission is disabled; use a destination-specific network request");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied a broad network grant without a destination.", occurredAt: now() });
        return;
      }
      if (!root || !await filesystemPermissionIsSafe(input.additionalPermissions?.fileSystem, root, input.cwd ?? root)) {
        this.transport.respondError(request.id, -32003, "Filesystem permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied filesystem access outside the registered project.", occurredAt: now() });
        return;
      }
      if (!this.registerPending(approvalId, { rpcId: request.id, method: request.method, params }, sessionId, turnId)) return;
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: network.length ? "network" : "command", title: network.length ? "Network access requested" : "Run command outside sandbox?", ...(input.reason ? { reason: input.reason } : {}), ...(input.command ? { command: summarizeCommand(input.command) } : {}), ...(network.length ? { network } : {}), canAutoApprove: canAutoApproveCommand({ rpcId: request.id, method: request.method, params }), occurredAt: now() });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      const input = request.params as FileChangeRequestApprovalParams;
      const root = this.projectRoots.get(sessionId);
      if (input.grantRoot && (!root || !await requestedPathInside(root, input.grantRoot, this.sessionCwds.get(sessionId) ?? root))) {
        this.transport.respondError(request.id, -32003, "Write permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied a write root outside the registered project.", occurredAt: now() });
        return;
      }
      if (!this.registerPending(approvalId, { rpcId: request.id, method: request.method, params }, sessionId, turnId)) return;
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: "file", title: "File change approval requested", ...(input.reason ? { reason: input.reason } : {}), ...(input.grantRoot ? { paths: [input.grantRoot] } : {}), occurredAt: now() });
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      const input = request.params as PermissionsRequestApprovalParams;
      if (input.permissions.network?.enabled) {
        this.transport.respondError(request.id, -32004, "Broad network permission is disabled; use a destination-specific network request");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied a broad network grant without a destination.", occurredAt: now() });
        return;
      }
      const kind = input.permissions.network?.enabled ? "network" : "filesystem";
      const paths = extractPaths(input);
      const root = this.projectRoots.get(sessionId);
      const cwd = input.cwd ?? root ?? process.cwd();
      if (!root || !await filesystemPermissionIsSafe(input.permissions.fileSystem, root, cwd)) {
        this.transport.respondError(request.id, -32003, "Filesystem permission outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied filesystem access outside the registered project.", occurredAt: now() });
        return;
      }
      if (!this.registerPending(approvalId, { rpcId: request.id, method: request.method, params }, sessionId, turnId)) return;
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind, title: kind === "network" ? "Network permission requested" : "Filesystem permission requested", ...(input.reason ? { reason: input.reason } : {}), ...(paths.length ? { paths } : {}), ...(kind === "network" ? { network: [{ host: "unspecified destination", protocol: "network" }] } : {}), occurredAt: now() });
      return;
    }
    if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      const root = this.projectRoots.get(sessionId);
      const cwd = this.sessionCwds.get(sessionId) ?? root ?? process.cwd();
      const fileChangesSafe = root && (await Promise.all(Object.keys((params["fileChanges"] as object | undefined) ?? {}).map((candidate) => requestedPathInside(root, candidate, cwd)))).every(Boolean);
      if (request.method === "applyPatchApproval" && !fileChangesSafe) {
        this.transport.respondError(request.id, -32003, "File change outside the registered project is disabled");
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: `policy:${approvalId}`, delta: " PulseCortex denied a file change outside the registered project.", occurredAt: now() });
        return;
      }
      if (!this.registerPending(approvalId, { rpcId: request.id, method: request.method, params }, sessionId, turnId)) return;
      const command = Array.isArray(params["command"]) ? (params["command"] as string[]).join(" ") : undefined;
      const fileChanges = params["fileChanges"] && typeof params["fileChanges"] === "object" ? Object.keys(params["fileChanges"] as object) : [];
      this.emit({ type: "approval.requested", sessionId, turnId, approvalId, kind: command ? "command" : "file", title: command ? "Run command outside sandbox?" : "File change approval requested", ...(command ? { command: summarizeCommand(command) } : {}), ...(fileChanges.length ? { files: fileChanges } : {}), canAutoApprove: command ? canAutoApproveCommand({ rpcId: request.id, method: request.method, params }) : false, occurredAt: now() });
      return;
    }
    if (request.method === "currentTime/read") {
      this.transport.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    }
    if (request.method === "mcpServer/elicitation/request") {
      this.transport.respond(request.id, { action: "decline", content: null, _meta: null });
      this.reportDiagnostic("warn", "Declined MCP elicitation because remote structured input is not enabled", sessionId, { turnId });
      return;
    }
    if (request.method === "item/tool/call") {
      this.transport.respond(request.id, {
        contentItems: [{ type: "inputText", text: "PulseCortex did not register this dynamic tool for remote execution." }],
        success: false,
      });
      const consecutiveFailures = this.recordToolCallFailure(sessionId, turnId);
      if (consecutiveFailures === TOOL_CALL_WARNING_THRESHOLD) {
        this.reportDiagnostic("warn", "Rejected an unregistered dynamic tool call", sessionId, {
          turnId, tool: params["tool"], namespace: params["namespace"], consecutiveFailures,
        });
      }
      return;
    }
    if (request.method === "account/chatgptAuthTokens/refresh" || request.method === "attestation/generate") {
      this.transport.respondError(request.id, -32010, `${request.method} is not available because PulseCortex delegates authentication to the Codex CLI`);
      this.reportDiagnostic("warn", "Rejected a client-managed authentication request", sessionId || undefined, { method: request.method });
      return;
    }
    this.transport.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
    this.reportDiagnostic("warn", "Received an unsupported Codex server request", sessionId || undefined, { method: request.method });
  }

  private handleNotification(message: JsonRpcNotification): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const sessionId = String(params["threadId"] ?? "");
    const turnId = String(params["turnId"] ?? (params["turn"] as Record<string, unknown> | undefined)?.["id"] ?? this.activeTurns.get(sessionId) ?? "");
    switch (message.method) {
      case "turn/started":
        if (this.failedTurns.has(`${sessionId}:${turnId}`)) break;
        this.activeTurns.set(sessionId, turnId); this.emit({ type: "turn.started", sessionId, turnId, occurredAt: now() }); break;
      case "thread/environment/connected": {
        const environmentId = String(params["environmentId"] ?? "");
        const disconnected = this.disconnectedEnvironments.get(sessionId);
        disconnected?.delete(environmentId);
        if (!disconnected?.size) this.disconnectedEnvironments.delete(sessionId);
        this.reportDiagnostic("info", "Codex execution environment connected", sessionId, { environmentId });
        break;
      }
      case "thread/environment/disconnected": {
        const environmentId = String(params["environmentId"] ?? "");
        const disconnected = this.disconnectedEnvironments.get(sessionId) ?? new Set<string>();
        disconnected.add(environmentId);
        this.disconnectedEnvironments.set(sessionId, disconnected);
        this.reportDiagnostic("error", "Codex execution environment disconnected; tool access is unavailable", sessionId, { environmentId });
        const activeTurn = this.activeTurns.get(sessionId);
        if (activeTurn) {
          this.activeTurns.delete(sessionId);
          this.failedTurns.add(`${sessionId}:${activeTurn}`);
          this.clearPendingRequests(sessionId, activeTurn);
          void this.transport.request("turn/interrupt", { threadId: sessionId, turnId: activeTurn }).catch(() => undefined);
          this.emit({ type: "turn.failed", sessionId, turnId: activeTurn, error: `Codex execution environment ${environmentId} disconnected; tool access is unavailable`, occurredAt: now() });
        }
        break;
      }
      case "serverRequest/resolved": {
        const rpcId = params["requestId"];
        let found = false;
        for (const [requestId, pending] of this.pending) {
          if (String(pending.rpcId) !== String(rpcId)) continue;
          found = true;
          this.pending.delete(requestId);
          const pendingSessionId = String(pending.params["threadId"] ?? pending.params["conversationId"] ?? sessionId);
          const pendingTurnId = String(pending.params["turnId"] ?? this.activeTurns.get(pendingSessionId) ?? turnId);
          this.emit({ type: "request.resolved", sessionId: pendingSessionId, turnId: pendingTurnId, requestId, occurredAt: now() });
        }
        if (!found && this.validatingServerRequests.has(String(rpcId))) this.resolvedServerRequests.add(String(rpcId));
        break;
      }
      case "warning": this.reportDiagnostic("warn", String(params["message"] ?? "Codex warning"), sessionId || undefined); break;
      case "configWarning": this.reportDiagnostic("warn", String(params["summary"] ?? "Codex configuration warning"), undefined, { details: params["details"], path: params["path"] }); break;
      case "deprecationNotice": this.reportDiagnostic("warn", String(params["summary"] ?? "Codex deprecation notice"), undefined, { details: params["details"] }); break;
      case "thread/settings/updated": {
        const settings = params["threadSettings"] as Record<string, unknown> | undefined;
        const model = settings?.["model"];
        const effort = settings?.["effort"];
        if (typeof model === "string") this.sessionSettings.set(sessionId, { model, reasoningEffort: typeof effort === "string" ? effort as ReasoningEffort : null });
        break;
      }
      case "item/agentMessage/delta": {
        const input = message.params as AgentMessageDeltaNotification;
        this.emit({ type: "agent.message.delta", sessionId, turnId, messageId: input.itemId, delta: input.delta, occurredAt: now() });
        break;
      }
      case "rawResponseItem/completed": {
        const input = message.params as RawResponseItemCompletedNotification;
        if (input.item.type === "function_call_output") {
          const output = functionCallOutputText(input.item.output);
          if (output.toLowerCase().includes(TOOL_ARGUMENT_ERROR_PREFIX)) this.failToolArgumentTurn(input.threadId, input.turnId, output);
        }
        break;
      }
      case "turn/diff/updated": this.emit({ type: "diff.updated", sessionId, turnId, diff: String(params["diff"] ?? ""), occurredAt: now() }); break;
      case "item/commandExecution/outputDelta": void this.options.commandLogs?.append(turnId, "stdout", String(params["delta"] ?? "")).catch(() => undefined); break;
      case "item/started": this.handleItemStarted(message.params as ItemStartedNotification); break;
      case "item/completed": this.handleItemCompleted(message.params as ItemCompletedNotification); break;
      case "turn/completed": {
        const input = message.params as TurnCompletedNotification;
        this.activeTurns.delete(input.threadId);
        this.clearToolCallFailureStreaks(input.threadId, input.turn.id);
        this.clearPendingRequests(input.threadId, input.turn.id);
        if (input.turn.status === "failed") this.emit({ type: "turn.failed", sessionId: input.threadId, turnId: input.turn.id, error: input.turn.error?.message ?? "Codex turn failed", occurredAt: now() });
        else this.emit({ type: "turn.completed", sessionId: input.threadId, turnId: input.turn.id, status: input.turn.status === "interrupted" ? "stopped" : "completed", occurredAt: now() });
        break;
      }
      case "error": {
        const error = params["error"] as Record<string, unknown> | undefined;
        if (!params["willRetry"]) {
          if (this.activeTurns.get(sessionId) === turnId) {
            this.activeTurns.delete(sessionId);
          }
          if (sessionId && turnId) this.failedTurns.add(`${sessionId}:${turnId}`);
          this.clearToolCallFailureStreaks(sessionId, turnId);
          this.clearPendingRequests(sessionId, turnId);
          this.emit({ type: "turn.failed", sessionId, turnId, error: String(error?.["message"] ?? "Codex turn error"), occurredAt: now() });
        }
        break;
      }
    }
  }

  private handleItemStarted(input: ItemStartedNotification): void {
    this.clearToolCallFailureStreaks(input.threadId, input.turnId);
    if (input.item.type === "commandExecution") this.emit({ type: "command.started", sessionId: input.threadId, turnId: input.turnId, commandId: input.item.id, command: summarizeCommand(input.item.command), occurredAt: input.startedAtMs });
  }

  private handleItemCompleted(input: ItemCompletedNotification): void {
    if (input.item.type === "plan") this.emit({ type: "plan.completed", sessionId: input.threadId, turnId: input.turnId, text: input.item.text, occurredAt: input.completedAtMs });
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
  private async assertEnvironmentAvailable(sessionId: SessionId): Promise<void> {
    const disconnected = this.disconnectedEnvironments.get(sessionId);
    if (!disconnected?.size) return;
    for (const environmentId of [...disconnected]) {
      try {
        const response = await this.transport.request<EnvironmentStatusResponse>("environment/status", { environmentId });
        if (response.status === "ready") disconnected.delete(environmentId);
      } catch (error) {
        this.reportDiagnostic("warn", "Could not verify Codex execution environment status", sessionId, { environmentId, error: (error as Error).message });
      }
    }
    if (!disconnected.size) { this.disconnectedEnvironments.delete(sessionId); return; }
    throw new Error(`Codex execution environment ${[...disconnected].join(", ")} is disconnected; tool access is unavailable`);
  }
  private clearPendingRequests(sessionId: SessionId, turnId?: TurnId): void {
    for (const [requestId, pending] of this.pending) {
      const pendingSessionId = String(pending.params["threadId"] ?? pending.params["conversationId"] ?? "");
      const pendingTurnId = String(pending.params["turnId"] ?? "");
      if (pendingSessionId === sessionId && (!turnId || !pendingTurnId || pendingTurnId === turnId)) this.pending.delete(requestId);
    }
  }
  private registerPending(approvalId: string, pending: PendingServerRequest, sessionId: SessionId, turnId: TurnId): boolean {
    if (this.resolvedServerRequests.delete(String(pending.rpcId))) {
      this.emit({ type: "request.resolved", sessionId, turnId, requestId: approvalId, occurredAt: now() });
      return false;
    }
    this.pending.set(approvalId, pending);
    return true;
  }
  private recordToolCallFailure(sessionId: SessionId, turnId: TurnId): number {
    const key = `${sessionId}:${turnId}`;
    const failures = (this.toolCallFailureStreaks.get(key) ?? 0) + 1;
    this.toolCallFailureStreaks.set(key, failures);
    return failures;
  }
  private clearToolCallFailureStreaks(sessionId: SessionId, turnId?: TurnId): void {
    if (turnId) {
      this.toolCallFailureStreaks.delete(`${sessionId}:${turnId}`);
      return;
    }
    for (const key of this.toolCallFailureStreaks.keys()) if (key.startsWith(`${sessionId}:`)) this.toolCallFailureStreaks.delete(key);
  }
  private handleStderr(output: string): void {
    this.reportDiagnostic("warn", "Codex app-server stderr", undefined, { output: output.trim() });
    this.stderrBuffer = `${this.stderrBuffer}${output}`.slice(-8_000);
    const normalized = this.stderrBuffer.replace(/\u001b\[[0-9;]*m/gu, "");
    const marker = normalized.toLowerCase().lastIndexOf(TOOL_ARGUMENT_ERROR_PREFIX);
    if (marker < 0) {
      const lastNewline = Math.max(this.stderrBuffer.lastIndexOf("\n"), this.stderrBuffer.lastIndexOf("\r"));
      if (lastNewline >= 0) this.stderrBuffer = this.stderrBuffer.slice(lastNewline + 1);
      return;
    }
    const detail = normalized.slice(marker).split(/\r?\n/u, 1)[0]!.trim();
    this.stderrBuffer = "";
    if (this.activeTurns.size !== 1) {
      this.reportDiagnostic("error", "Codex rejected tool-call arguments but the stderr event could not be correlated to one active turn", undefined, { activeTurnCount: this.activeTurns.size, error: detail });
      return;
    }
    const [sessionId, turnId] = this.activeTurns.entries().next().value as [SessionId, TurnId];
    this.failToolArgumentTurn(sessionId, turnId, detail);
  }
  private failToolArgumentTurn(sessionId: SessionId, turnId: TurnId, detail: string): void {
    if (this.activeTurns.get(sessionId) !== turnId) return;
    this.activeTurns.delete(sessionId);
    this.failedTurns.add(`${sessionId}:${turnId}`);
    this.clearPendingRequests(sessionId, turnId);
    const error = "Codex could not parse tool-call arguments. The configured model provider may not preserve namespace tool schemas correctly.";
    this.reportDiagnostic("error", "Codex tool-call argument parsing failed; interrupting the turn", sessionId, { turnId, error: detail });
    void this.transport.request("turn/interrupt", { threadId: sessionId, turnId }).catch(() => undefined);
    this.emit({ type: "turn.failed", sessionId, turnId, error, occurredAt: now() });
  }
  private setManaged(sessionId: SessionId, managed: boolean): void {
    if (managed) this.managedSessions.add(sessionId);
    else this.managedSessions.delete(sessionId);
  }
  private reportPermissionProfile(sessionId: SessionId, activeProfile: string | undefined): void {
    const expected = this.options.permissionProfile ?? ":workspace";
    this.reportDiagnostic(activeProfile && activeProfile !== expected ? "warn" : "info", activeProfile && activeProfile !== expected
      ? "Codex selected a different permission profile for the managed session"
      : "Codex managed-session permission profile selected", sessionId, { expected, active: activeProfile ?? "not reported" });
  }
  private reportDiagnostic(level: CodexDriverDiagnostic["level"], message: string, sessionId?: SessionId, details?: Record<string, unknown>): void {
    if (!message.trim() && !details) return;
    this.options.onDiagnostic?.({ level, message, ...(sessionId ? { sessionId } : {}), ...(details ? { details } : {}) });
  }
  private handleCrash(error: Error): void {
    if (!this.started) return;
    this.started = false;
    this.stderrBuffer = "";
    this.activeTurns.clear();
    this.projectRoots.clear();
    this.sessionCwds.clear();
    this.disconnectedEnvironments.clear();
    this.directInputSessions.clear();
    this.managedSessions.clear();
    this.sessionSettings.clear();
    this.pending.clear();
    this.validatingServerRequests.clear();
    this.resolvedServerRequests.clear();
    this.eventBuffers.clear();
    this.toolCallFailureStreaks.clear();
    this.emit({ type: "driver.crashed", error: error.message, occurredAt: now() });
  }
  private async handleProtocolError(error: Error): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stderrBuffer = "";
    this.activeTurns.clear();
    this.projectRoots.clear();
    this.sessionCwds.clear();
    this.disconnectedEnvironments.clear();
    this.directInputSessions.clear();
    this.managedSessions.clear();
    this.sessionSettings.clear();
    this.pending.clear();
    this.validatingServerRequests.clear();
    this.resolvedServerRequests.clear();
    this.eventBuffers.clear();
    this.toolCallFailureStreaks.clear();
    await this.transport.stop();
    this.emit({ type: "driver.crashed", error: error.message, occurredAt: now() });
  }
  private assertStarted(): void { if (!this.started) throw new Error("Codex driver is not started"); }
  private assertSession(id: SessionId): void { this.assertStarted(); if (!this.projectRoots.has(id)) throw new Error("Session is not loaded by PulseCortex"); }
}

function isWriterConflict(error: unknown): boolean {
  return /active writer|already (?:has|owned by).*writer|already loaded/iu.test((error as Error).message);
}
