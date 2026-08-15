import { existsSync } from "node:fs";
import path from "node:path";

export interface CodexInvocation { executable: string; prefixArgs: string[] }

export function codexEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== "win32" || !base["USERPROFILE"]) return base;
  return {
    ...base,
    ...(base["HOME"] ? {} : { HOME: base["USERPROFILE"] }),
    ...(base["CODEX_HOME"] ? {} : { CODEX_HOME: path.join(base["USERPROFILE"], ".codex") }),
  };
}

function invocationFromShim(shimPath: string): CodexInvocation | null {
  const script = path.join(path.dirname(shimPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(script) ? { executable: process.execPath, prefixArgs: [script] } : null;
}

export function resolveCodexInvocation(requested?: string): CodexInvocation {
  if (requested) {
    if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(requested)) return invocationFromShim(path.resolve(requested)) ?? { executable: requested, prefixArgs: [] };
    return { executable: requested, prefixArgs: [] };
  }
  if (process.platform !== "win32") return { executable: "codex", prefixArgs: [] };
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const native = path.join(directory, "codex.exe");
    if (existsSync(native)) return { executable: native, prefixArgs: [] };
    const shim = path.join(directory, "codex.cmd");
    if (existsSync(shim)) {
      const invocation = invocationFromShim(shim);
      if (invocation) return invocation;
    }
  }
  return { executable: "codex.exe", prefixArgs: [] };
}
