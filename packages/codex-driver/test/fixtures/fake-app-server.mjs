import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let sessionId = "019fake-thread";
let turnId = "019fake-turn";
const scenario = process.argv[2] ?? "approval";

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex/0.147.0", codexHome: process.cwd(), platformFamily: "windows", platformOs: "windows" } });
  } else if (message.method === "thread/start") {
    if (message.params.sandbox !== "workspace-write" || message.params.runtimeWorkspaceRoots.length !== 1) {
      send({ id: message.id, error: { code: -32000, message: "unsafe thread configuration" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: sessionId }, cwd: message.params.cwd } });
  } else if (message.method === "thread/resume") {
    sessionId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: sessionId }, cwd: message.params.cwd } });
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
