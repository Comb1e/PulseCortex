import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { MAX_JSONL_LINE_BYTES, isNotification, isRequest, isResponse, type JsonRpcNotification, type JsonRpcRequest } from "./protocol.js";
import { codexEnvironment, resolveCodexInvocation } from "./launcher.js";

export interface TransportOptions {
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  listenUrl?: string;
  listenAvailabilityTimeoutMs?: number;
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

export class JsonlRpcTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stopped = false;
  private exited = false;
  private generation = 0;
  private termination: Promise<void> = Promise.resolve();
  private stderrTail = "";
  private exitError: Error | null = null;

  constructor(private readonly options: TransportOptions = {}) { super(); }

  async start(): Promise<void> {
    if (this.child || this.socket) throw new Error("Codex transport already started");
    if (this.options.listenUrl) assertLoopbackWebSocketUrl(this.options.listenUrl);
    await this.termination;
    if (this.child || this.socket) throw new Error("Codex transport already started");
    if (this.options.listenUrl) await waitForListenAddress(this.options.listenUrl, this.options.listenAvailabilityTimeoutMs ?? 2_000);
    const generation = ++this.generation;
    const invocation = resolveCodexInvocation(this.options.executable);
    const executable = invocation.executable;
    const args = [...invocation.prefixArgs, ...(this.options.args ?? (this.options.listenUrl ? ["app-server", "--listen", this.options.listenUrl] : ["app-server", "--stdio"]))];
    this.stopped = false;
    this.exited = false;
    this.stderrTail = "";
    this.exitError = null;
    this.child = spawn(executable, args, {
      cwd: this.options.cwd,
      env: codexEnvironment(this.options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    if (this.options.listenUrl) {
      this.child.stdout.on("data", (chunk: Buffer) => this.emit("stdout", chunk.toString("utf8")));
    } else {
      const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => this.handleLine(line));
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${output}`.slice(-4_000);
      this.emit("stderr", output);
    });
    this.child.once("error", (error) => this.handleExit(generation, error));
    this.child.once("exit", (code, signal) => this.handleExit(generation, new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`)));
    if (this.options.listenUrl) await this.connectWebSocket(this.options.listenUrl, generation);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.exited = true;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    const child = this.child;
    this.child = null;
    const error = new Error("Codex app-server stopped");
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    const termination = Promise.all([this.termination, terminateChild(child)]).then(() => undefined);
    this.termination = termination;
    await termination;
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
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(message)); return; }
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async connectWebSocket(listenUrl: string, generation: number): Promise<void> {
    const healthUrl = new URL(listenUrl);
    healthUrl.protocol = "http:";
    healthUrl.pathname = "/readyz";
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (this.exited || this.stopped || generation !== this.generation) throw this.exitError ?? new Error("Codex app-server exited before its WebSocket listener became ready");
      try {
        const response = await fetch(healthUrl);
        if (response.ok) { ready = true; break; }
      } catch { /* Listener is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Codex app-server WebSocket listener did not become ready at ${listenUrl}`);

    const socket = new WebSocket(listenUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error(`Timed out connecting to Codex app-server at ${listenUrl}`)); }, 5_000);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); socket.close(); reject(new Error(`Failed to connect to Codex app-server at ${listenUrl}`)); };
    });
    if (this.exited || this.stopped || generation !== this.generation) { socket.close(); throw this.exitError ?? new Error("Codex app-server exited while its WebSocket connection was starting"); }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") { this.emit("protocolError", new Error("Codex emitted a non-text WebSocket message")); return; }
      this.handleLine(event.data);
    };
    socket.onerror = () => this.handleExit(generation, new Error("Codex app-server WebSocket failed"));
    socket.onclose = (event) => this.handleExit(generation, new Error(`Codex app-server WebSocket closed (code=${event.code})`));
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

  private handleExit(generation: number, error: Error): void {
    if (generation !== this.generation || this.exited) return;
    this.exited = true;
    const child = this.child;
    this.child = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    const detail = this.stderrTail.trim();
    const failure = detail ? new Error(`${error.message}: ${detail}`) : error;
    this.exitError = failure;
    const termination = Promise.all([this.termination, terminateChild(child)]).then(() => undefined);
    this.termination = termination;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(failure); }
    this.pending.clear();
    if (!this.stopped) this.emit("crash", failure);
  }
}

function terminateChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === "win32") return terminateWindowsProcessTree(child);
  return terminatePosixProcessGroup(child.pid);
}

function terminateWindowsProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    });
  });
}

function terminatePosixProcessGroup(pid: number): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals | 0) => {
    try { process.kill(-pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  return new Promise((resolve, reject) => {
    try {
      if (!signalGroup("SIGTERM")) { resolve(); return; }
    } catch (error) { reject(error); return; }
    const forceTimer = setTimeout(() => {
      try { signalGroup("SIGKILL"); }
      catch (error) { clearInterval(exitPoll); reject(error); }
    }, 3_000);
    const fallbackTimer = setTimeout(() => { clearInterval(exitPoll); clearTimeout(forceTimer); resolve(); }, 5_000);
    const exitPoll = setInterval(() => {
      try {
        if (signalGroup(0)) return;
        clearInterval(exitPoll);
        clearTimeout(forceTimer);
        clearTimeout(fallbackTimer);
        resolve();
      } catch (error) {
        clearInterval(exitPoll);
        clearTimeout(forceTimer);
        clearTimeout(fallbackTimer);
        reject(error);
      }
    }, 50);
  });
}

function assertLoopbackWebSocketUrl(value: string): void {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "ws:" || !loopback || !url.port || url.pathname !== "/") throw new Error("Codex app-server URL must be a loopback ws:// URL with an explicit port");
}

async function waitForListenAddress(value: string, timeoutMs: number): Promise<void> {
  const url = new URL(value);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = Number(url.port);
  const deadline = Date.now() + timeoutMs;
  do {
    try { await probeListenAddress(host, port); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw new Error(`Codex app-server listen address is already in use: ${value}`);
}

function probeListenAddress(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
  });
}
