import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { MAX_JSONL_LINE_BYTES, isNotification, isRequest, isResponse, type JsonRpcNotification, type JsonRpcRequest } from "./protocol.js";
import { codexEnvironment, resolveCodexInvocation } from "./launcher.js";

export interface TransportOptions {
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

export class JsonlRpcTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stopped = false;
  private exited = false;

  constructor(private readonly options: TransportOptions = {}) { super(); }

  start(): void {
    if (this.child) throw new Error("Codex transport already started");
    const invocation = resolveCodexInvocation(this.options.executable);
    const executable = invocation.executable;
    const args = [...invocation.prefixArgs, ...(this.options.args ?? ["app-server", "--stdio"])];
    this.stopped = false;
    this.exited = false;
    this.child = spawn(executable, args, { cwd: this.options.cwd, env: codexEnvironment(this.options.env ?? process.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.once("error", (error) => this.handleExit(error));
    this.child.once("exit", (code, signal) => this.handleExit(new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  respondError(id: string | number, code: number, message: string): void { this.write({ id, error: { code, message } }); }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) { this.emit("protocolError", new Error("Codex JSONL message exceeded 10 MiB")); return; }
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.emit("protocolError", new Error("Codex emitted malformed JSONL")); return; }
    if (isResponse(message)) {
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if ("error" in message) pending.reject(new Error(`Codex RPC ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (isRequest(message)) this.emit("request", message as JsonRpcRequest);
    else if (isNotification(message)) this.emit("notification", message as JsonRpcNotification);
    else this.emit("protocolError", new Error("Codex emitted an unknown JSON-RPC message"));
  }

  private handleExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.child = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    if (!this.stopped) this.emit("crash", error);
  }
}
