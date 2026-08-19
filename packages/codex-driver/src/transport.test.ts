import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { codexEnvironment } from "./launcher.js";
import { JsonlRpcTransport } from "./transport.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-app-server.mjs");

interface TransportLifecycleAccess {
  generation: number;
  handleExit(generation: number, error: Error): void;
}

describe("Codex child environment", () => {
  it("does not expose controller configuration or credentials", () => {
    const environment = codexEnvironment({
      PATH: "bin",
      FEISHU_APP_ID: "app-id",
      lark_app_secret: "secret",
      PULSECORTEX_ACTION_SIGNING_KEY: "signing-key",
      PULSECORTEX_ENV_FILE: "secret-file",
    });

    expect(environment).toEqual({ PATH: "bin" });
  });
});

describe("Codex transport lifecycle", () => {
  it("stops the app-server process tree", async () => {
    const transport = new JsonlRpcTransport({ executable: process.execPath, args: [fixture, "process-tree"] });
    let descendantPid: number | undefined;

    try {
      await transport.start();
      const initialized = await transport.request<{ descendantPid: number }>("initialize", {});
      descendantPid = initialized.descendantPid;
      expect(processIsRunning(descendantPid)).toBe(true);

      await transport.stop();

      await expect.poll(() => processIsRunning(descendantPid), { timeout: 2_000 }).toBe(false);
    } finally {
      await transport.stop();
    }
  });

  it("does not connect to an app-server listener owned by another process", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const transport = new JsonlRpcTransport({
      executable: process.execPath,
      args: [fixture],
      listenUrl: `ws://127.0.0.1:${port}`,
      listenAvailabilityTimeoutMs: 50,
    });

    try {
      await expect(transport.start()).rejects.toThrow("listen address is already in use");
    } finally {
      await transport.stop();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("ignores exit callbacks left behind by a previous app-server generation", async () => {
    const transport = new JsonlRpcTransport({ executable: process.execPath, args: [fixture] });
    const crashes: Error[] = [];
    transport.on("crash", (error: Error) => crashes.push(error));
    const lifecycle = transport as unknown as TransportLifecycleAccess;

    try {
      await transport.start();
      const staleGeneration = lifecycle.generation;
      lifecycle.handleExit(staleGeneration, new Error("simulated crash"));
      expect(crashes).toHaveLength(1);

      await transport.start();
      await expect(transport.request("initialize", {})).resolves.toMatchObject({ userAgent: "fake-codex/0.147.0" });

      lifecycle.handleExit(staleGeneration, new Error("late exit callback"));
      await expect(transport.request("initialize", {})).resolves.toMatchObject({ userAgent: "fake-codex/0.147.0" });
      expect(crashes).toHaveLength(1);
    } finally {
      await transport.stop();
    }
  });
});

function processIsRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
