import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let sessionId = "019fake-thread";
let turnId = "019fake-turn";
const scenario = process.argv[2] ?? "approval";
let externalThreadJoined = false;
const descendant = scenario === "process-tree"
  ? spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], { stdio: "ignore" })
  : null;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex/0.147.0", codexHome: process.env["FAKE_CODEX_HOME"] ?? process.cwd(), platformFamily: "windows", platformOs: "windows", descendantPid: descendant?.pid } });
  } else if (message.method === "thread/start") {
    if (message.params.sandbox !== "workspace-write" || message.params.runtimeWorkspaceRoots.length !== 1) {
      send({ id: message.id, error: { code: -32000, message: "unsafe thread configuration" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: sessionId }, cwd: message.params.cwd } });
  } else if (message.method === "thread/loaded/list") {
    send({ id: message.id, result: { data: ["external-thread"], nextCursor: null } });
  } else if (message.method === "thread/list") {
    const data = [
      { id: "external-thread", cwd: path.join(process.cwd(), "packages", "core"), name: "Live Codex", preview: "Working", status: { type: "active", activeFlags: [] }, canAcceptDirectInput: scenario !== "rejoin-loaded" || externalThreadJoined, threadSource: null, createdAt: 1, updatedAt: 2 },
      { id: "outside-thread", cwd: path.dirname(process.cwd()), name: "Outside", preview: "Outside", status: { type: "idle" }, canAcceptDirectInput: false, threadSource: null, createdAt: 1, updatedAt: 3 },
    ];
    if (scenario === "writer-lock") data.push({ id: "standalone-thread", cwd: process.cwd(), name: "Standalone Codex", preview: "Working elsewhere", status: { type: "notLoaded" }, canAcceptDirectInput: false, threadSource: null, createdAt: 3, updatedAt: 4 });
    send({ id: message.id, result: { data, nextCursor: null, backwardsCursor: null } });
  } else if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { id: message.params.threadId, canAcceptDirectInput: scenario !== "rejoin-loaded" || externalThreadJoined, turns: [{ id: "external-turn", status: "inProgress" }] } } });
  } else if (message.method === "thread/resume") {
    if (scenario === "reject-redundant-resume") {
      send({ id: message.id, error: { code: -32000, message: "thread is already loaded" } });
      return;
    }
    if (scenario === "rejoin-loaded" && message.params.cwd !== path.join(process.cwd(), "packages", "core")) {
      send({ id: message.id, error: { code: -32000, message: "rejoin changed the working directory" } });
      return;
    }
    sessionId = message.params.threadId;
    externalThreadJoined = true;
    send({ id: message.id, result: { thread: { id: sessionId, canAcceptDirectInput: true, turns: [{ id: "external-turn", status: "inProgress" }] }, cwd: message.params.cwd } });
  } else if (message.method === "turn/start") {
    if (message.params.sandboxPolicy.type !== "workspaceWrite" || message.params.sandboxPolicy.networkAccess !== false || message.params.sandboxPolicy.writableRoots.length !== 1) {
      send({ id: message.id, error: { code: -32000, message: "unsafe turn configuration" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: sessionId, turn: { id: turnId } } });
    send({ method: "item/agentMessage/delta", params: { threadId: sessionId, turnId, itemId: "agent", delta: "Working safely" } });
    send({ method: "item/started", params: { threadId: sessionId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd", command: "pnpm test", status: "inProgress" } } });
    if (scenario === "unsafe-permission") {
      send({ id: "permission-rpc", method: "item/permissions/requestApproval", params: { threadId: sessionId, turnId, itemId: "permission", environmentId: null, startedAtMs: Date.now(), cwd: message.params.cwd, reason: "write root", permissions: { network: null, fileSystem: { read: null, write: null, entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }] } } } });
    } else {
      send({ id: "approval-rpc", method: "item/commandExecution/requestApproval", params: { threadId: sessionId, turnId, itemId: "cmd", startedAtMs: Date.now(), environmentId: null, command: "pnpm test", networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" } } });
    }
  } else if (message.id === "approval-rpc") {
    if (message.result?.decision !== "accept") process.exit(3);
    send({ method: "item/commandExecution/outputDelta", params: { threadId: sessionId, turnId, itemId: "cmd", delta: "all tests passed\n" } });
    send({ method: "item/completed", params: { threadId: sessionId, turnId, completedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd", command: "pnpm test", status: "completed", exitCode: 0 } } });
    send({ method: "turn/diff/updated", params: { threadId: sessionId, turnId, diff: "diff --git a/a b/a" } });
    send({ method: "turn/completed", params: { threadId: sessionId, turn: { id: turnId, status: "completed", error: null } } });
  } else if (message.id === "permission-rpc") {
    if (!message.error || message.result) process.exit(4);
    send({ method: "turn/completed", params: { threadId: sessionId, turn: { id: turnId, status: "completed", error: null } } });
  } else if (message.method === "turn/steer" || message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
