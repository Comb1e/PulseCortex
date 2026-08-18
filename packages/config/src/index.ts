import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

export function defaultCodexAppServerUrl(platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? "ws://127.0.0.1:4501" : "ws://127.0.0.1:4500";
}

const ConfigSchema = z.object({
  dataDir: z.string().min(1).optional(),
  statusUpdateIntervalMs: z.number().int().min(500).max(30_000).default(2_000),
  approvalTtlMs: z.number().int().min(30_000).max(86_400_000).default(15 * 60_000),
  auditRetentionDays: z.number().int().min(1).max(365).default(30),
  logRetentionDays: z.number().int().min(1).max(90).default(7),
  logMaxBytes: z.number().int().min(1_000_000).max(2_000_000_000).default(100_000_000),
  redactionPatterns: z.array(z.string()).default([]),
  feishuDomain: z.enum(["feishu", "lark"]).default("feishu"),
  codexAppServerUrl: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !!url.port && url.pathname === "/";
    } catch { return false; }
  }, "codexAppServerUrl must be a loopback ws:// URL with an explicit port").default(defaultCodexAppServerUrl()),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type PublicConfig = z.infer<typeof ConfigSchema>;
export interface Secrets { appId: string; appSecret: string; actionSigningKey: string }
export interface RuntimeConfig extends PublicConfig { dataDir: string; databasePath: string; settingsPath: string; commandLogDir: string; secrets: Secrets }

export function defaultDataDir(): string {
  if (process.env["PULSECORTEX_DATA_DIR"]) return path.resolve(process.env["PULSECORTEX_DATA_DIR"]);
  if (process.platform === "win32") return path.join(process.env["LOCALAPPDATA"] ?? os.homedir(), "PulseCortex");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "PulseCortex");
  return path.join(process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state"), "pulsecortex");
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error("Invalid environment file line");
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export async function loadEnvironmentFile(filePath: string): Promise<Record<string, string>> {
  const info = await stat(filePath);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Secret file ${filePath} must not be accessible by group or other users (use chmod 600)`);
  }
  return parseEnv(await readFile(filePath, "utf8"));
}

export async function loadConfig(options: { requireSecrets?: boolean } = {}): Promise<RuntimeConfig> {
  const dataDir = defaultDataDir();
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const publicConfig = ConfigSchema.parse(raw);
  let env = { ...process.env } as Record<string, string | undefined>;
  const envPath = process.env["PULSECORTEX_ENV_FILE"] ?? path.join(dataDir, "pulsecortex.env");
  try { env = { ...await loadEnvironmentFile(envPath), ...env }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const secrets = {
    appId: env["FEISHU_APP_ID"] ?? "",
    appSecret: env["FEISHU_APP_SECRET"] ?? "",
    actionSigningKey: env["PULSECORTEX_ACTION_SIGNING_KEY"] ?? "",
  };
  if (options.requireSecrets !== false) {
    for (const [key, value] of Object.entries(secrets)) if (!value) throw new Error(`Missing required secret ${key}`);
    if (Buffer.byteLength(secrets.actionSigningKey) < 32) throw new Error("PULSECORTEX_ACTION_SIGNING_KEY must contain at least 32 bytes");
  }
  const resolvedDataDir = publicConfig.dataDir ? path.resolve(publicConfig.dataDir) : dataDir;
  return {
    ...publicConfig,
    dataDir: resolvedDataDir,
    databasePath: path.join(resolvedDataDir, "pulsecortex.db"),
    settingsPath: path.join(resolvedDataDir, "settings.json"),
    commandLogDir: path.join(resolvedDataDir, "command-logs"),
    secrets,
  };
}

export { ConfigSchema };
