import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface CodexInvocation { executable: string; prefixArgs: string[] }
export interface CodexResolutionOptions { platform?: NodeJS.Platform; pathEntries?: string[]; excludedDirectories?: string[] }

export function codexEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(Object.entries(base).filter(([key]) => {
    const normalized = key.toUpperCase();
    return !normalized.startsWith("FEISHU_") && !normalized.startsWith("LARK_") && !normalized.startsWith("PULSECORTEX_");
  }));
  if (process.platform !== "win32" || !sanitized["USERPROFILE"]) return sanitized;
  return {
    ...sanitized,
    ...(sanitized["HOME"] ? {} : { HOME: sanitized["USERPROFILE"] }),
    ...(sanitized["CODEX_HOME"] ? {} : { CODEX_HOME: path.join(sanitized["USERPROFILE"], ".codex") }),
  };
}

function invocationFromShim(shimPath: string): CodexInvocation | null {
  const script = path.join(path.dirname(shimPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(script) ? { executable: process.execPath, prefixArgs: [script] } : null;
}

function pathEntries(platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
}

function pulseCortexInvocation(shimPath: string, platform: NodeJS.Platform, entries: string[]): CodexInvocation | null {
  const invocationPath = path.join(path.dirname(shimPath), "codex-invocation.json");
  if (!existsSync(invocationPath)) return null;
  try {
    const value = JSON.parse(readFileSync(invocationPath, "utf8")) as { executable?: unknown; prefixArgs?: unknown };
    if (typeof value.executable !== "string" || !Array.isArray(value.prefixArgs) || !value.prefixArgs.every((item) => typeof item === "string")) return null;
    const remaining = entries.filter((entry) => path.resolve(entry) !== path.resolve(path.dirname(shimPath)));
    const resolved = resolveCodexInvocation(value.executable, { platform, pathEntries: remaining });
    return { executable: resolved.executable, prefixArgs: [...resolved.prefixArgs, ...value.prefixArgs] };
  } catch { return null; }
}

function findOnPath(command: string, platform: NodeJS.Platform, entries: string[]): CodexInvocation | null {
  const names = platform === "win32" && !/\.[^\\/]+$/u.test(command) ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  for (const directory of entries) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (!existsSync(candidate)) continue;
      try { accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); }
      catch { continue; }
      const pulseCortex = pulseCortexInvocation(candidate, platform, entries);
      if (pulseCortex) return pulseCortex;
      if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(candidate)) {
        const invocation = invocationFromShim(candidate);
        if (invocation) return invocation;
      }
      return { executable: candidate, prefixArgs: [] };
    }
  }
  return null;
}

export function resolveCodexInvocation(requested?: string, options: CodexResolutionOptions = {}): CodexInvocation {
  const platform = options.platform ?? process.platform;
  const excluded = new Set((options.excludedDirectories ?? []).map((entry) => path.resolve(entry)));
  const entries = (options.pathEntries ?? pathEntries(platform)).filter((entry) => !excluded.has(path.resolve(entry)));
  if (requested) {
    if (!path.isAbsolute(requested) && !requested.includes("/") && !requested.includes("\\")) {
      const resolved = findOnPath(requested, platform, entries);
      if (resolved) return resolved;
    }
    if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(requested)) return invocationFromShim(path.resolve(requested)) ?? { executable: requested, prefixArgs: [] };
    return { executable: requested, prefixArgs: [] };
  }
  return findOnPath("codex", platform, entries) ?? { executable: platform === "win32" ? "codex.exe" : "codex", prefixArgs: [] };
}
