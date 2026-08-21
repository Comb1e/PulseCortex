#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@pulsecortex/config";
import { codexEnvironment, resolveCodexInvocation, type CodexInvocation } from "@pulsecortex/codex-driver";

const DIRECT_SUBCOMMANDS = new Set([
  "app", "app-server", "apply", "cloud", "completion", "debug", "doctor", "exec", "exec-server", "features",
  "help", "login", "logout", "mcp", "mcp-server", "plugin", "remote-control", "review", "sandbox", "update",
]);
const REMOTE_SUBCOMMANDS = new Set(["archive", "delete", "fork", "resume", "unarchive"]);
const OPTIONS_WITH_VALUES = new Set([
  "-a", "--add-dir", "--ask-for-approval", "-C", "--cd", "-c", "--config", "--disable", "--enable", "-i", "--image",
  "--local-provider", "-m", "--model", "-p", "--profile", "--remote", "--remote-auth-token-env", "-s", "--sandbox",
]);

function detectSubcommand(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return null;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && OPTIONS_WITH_VALUES.has(arg)) index += 1;
      continue;
    }
    return DIRECT_SUBCOMMANDS.has(arg) || REMOTE_SUBCOMMANDS.has(arg) ? arg : null;
  }
  return null;
}

export function shouldUsePulseCortex(args: string[]): boolean {
  if (args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) return false;
  if (args.some((arg) => arg === "-h" || arg === "--help" || arg === "-V" || arg === "--version")) return false;
  const subcommand = detectSubcommand(args);
  return subcommand === null || REMOTE_SUBCOMMANDS.has(subcommand);
}

export function routeCodexArguments(args: string[], appServerUrl: string): string[] {
  return shouldUsePulseCortex(args) ? ["--remote", appServerUrl, ...args] : args;
}

async function appServerReady(appServerUrl: string): Promise<boolean> {
  const healthUrl = new URL(appServerUrl);
  healthUrl.protocol = healthUrl.protocol === "wss:" ? "https:" : "http:";
  healthUrl.pathname = "/readyz";
  try { return (await fetch(healthUrl)).ok; } catch { return false; }
}

function parseInvocation(value: unknown): CodexInvocation {
  if (!value || typeof value !== "object") throw new Error("Invalid Codex invocation file");
  const executable = (value as { executable?: unknown }).executable;
  const prefixArgs = (value as { prefixArgs?: unknown }).prefixArgs;
  if (typeof executable !== "string" || !Array.isArray(prefixArgs) || !prefixArgs.every((item) => typeof item === "string")) throw new Error("Invalid Codex invocation file");
  return { executable, prefixArgs };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "--invocation-file" || !args[1] || args[2] !== "--") throw new Error("The PulseCortex Codex shim was invoked incorrectly");
  const configured = parseInvocation(JSON.parse(await readFile(args[1], "utf8")) as unknown);
  const resolved = resolveCodexInvocation(configured.executable, { excludedDirectories: [path.dirname(args[1])] });
  const invocation = { executable: resolved.executable, prefixArgs: [...resolved.prefixArgs, ...configured.prefixArgs] };
  const forwarded = args.slice(3);
  const shouldRoute = shouldUsePulseCortex(forwarded);
  let routed = forwarded;
  if (shouldRoute) {
    try {
      const config = await loadConfig({ requireSecrets: false });
      if (await appServerReady(config.codexAppServerUrl)) routed = routeCodexArguments(forwarded, config.codexAppServerUrl);
      else process.stderr.write("PulseCortex is not running; launching standalone Codex. This session will not be controllable from Feishu.\n");
    } catch (error) {
      process.stderr.write(`PulseCortex configuration is unavailable (${(error as Error).message}); launching standalone Codex.\n`);
    }
  }
  const child = spawn(invocation.executable, [...invocation.prefixArgs, ...routed], { cwd: process.cwd(), env: codexEnvironment(), stdio: "inherit", windowsHide: false });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Codex exited from signal ${signal}`)) : resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) run().catch((error) => { process.stderr.write(`codex: ${(error as Error).message}\n`); process.exitCode = 1; });
