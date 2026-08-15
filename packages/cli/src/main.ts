#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { loadConfig, defaultDataDir } from "@pulsecortex/config";
import { detectCodexVersion } from "@pulsecortex/codex-driver";
import { canonicalProjectPath } from "@pulsecortex/domain";
import { installService, serviceArtifact, serviceStatus, uninstallService } from "@pulsecortex/installer";
import { CommandLogStore, ControllerStore } from "@pulsecortex/persistence";

const execFileAsync = promisify(execFile);

async function withStore<T>(work: (store: ControllerStore) => Promise<T> | T): Promise<T> {
  const config = await loadConfig({ requireSecrets: false });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new ControllerStore(config.databasePath);
  try { return await work(store); } finally { store.close(); }
}

async function serviceOptions() {
  const config = await loadConfig({ requireSecrets: false });
  const daemonEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../daemon/dist/main.js");
  return { dataDir: config.dataDir, daemonEntry, envFile: process.env["PULSECORTEX_ENV_FILE"] ?? path.join(config.dataDir, "pulsecortex.env") };
}

const program = new Command().name("pulsectl").description("Local administration for PulseCortex").version("0.1.0");

program.command("init").description("Create non-secret config and a permission-restricted secret template").action(async () => {
  const dataDir = defaultDataDir();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dataDir, "config.json");
  const envPath = path.join(dataDir, "pulsecortex.env");
  try { await access(configPath); } catch { await writeFile(configPath, `${JSON.stringify({ statusUpdateIntervalMs: 2000, approvalTtlMs: 900000, auditRetentionDays: 30, logRetentionDays: 7, logMaxBytes: 100000000, redactionPatterns: [] }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
  try { await access(envPath); } catch { await writeFile(envPath, "# Keep this file readable only by your desktop user.\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\n# Generate at least 32 random bytes, for example: openssl rand -base64 48\nPULSECORTEX_ACTION_SIGNING_KEY=\n", { encoding: "utf8", mode: 0o600 }); }
  if (process.platform === "win32") {
    const user = process.env["USERNAME"];
    if (!user) throw new Error("USERNAME is unavailable; cannot restrict the secret file ACL");
    await execFileAsync("icacls.exe", [envPath, "/inheritance:r", "/grant:r", `${user}:(R,W)`], { windowsHide: true });
  }
  process.stdout.write(`Initialized ${dataDir}\nSet credentials in ${envPath}\n`);
});

const project = program.command("project").description("Manage the local project allowlist");
project.command("add").argument("<name>").argument("<path>").action(async (name: string, inputPath: string) => {
  const canonical = await canonicalProjectPath(inputPath);
  const added = await withStore((store) => store.addProject(name, canonical));
  process.stdout.write(`Registered ${added.name}: ${added.canonicalPath}\n`);
});
project.command("list").action(async () => { const projects = await withStore((store) => store.listProjects()); process.stdout.write(projects.length ? projects.map((item) => `${item.name}\t${item.canonicalPath}`).join("\n") + "\n" : "No projects registered.\n"); });
project.command("remove").argument("<name>").action(async (name: string) => { const removed = await withStore((store) => store.removeProject(name)); process.stdout.write(removed ? `Removed ${name}\n` : `Project ${name} was not found\n`); });

program.command("pair").description("Generate a short-lived owner pairing code").option("--ttl <minutes>", "expiry in minutes", "10").action(async (options: { ttl: string }) => {
  const minutes = Number(options.ttl);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error("Pairing TTL must be between 1 and 60 minutes");
  const result = await withStore((store) => store.createPairingCode(minutes * 60_000));
  process.stdout.write(`Send this in a direct chat with the bot: /pair ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\n`);
});

program.command("diagnose").description("Check Codex, database, pairing, projects, credentials, and delivery queue").action(async () => {
  const config = await loadConfig({ requireSecrets: false });
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try { const codex = await detectCodexVersion(); checks.push({ name: "Codex", ok: codex.compatible, detail: `${codex.version}${codex.compatible ? "" : " (unsupported; requires 0.147.x)"}` }); }
  catch (error) { checks.push({ name: "Codex", ok: false, detail: (error as Error).message }); }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new ControllerStore(config.databasePath);
  try {
    const integrity = store.integrityCheck(); checks.push({ name: "Database", ok: integrity.every((value) => value === "ok"), detail: integrity.join(", ") });
    const owner = store.getOwner(); checks.push({ name: "Owner", ok: !!owner, detail: owner ? `paired; chat ${owner.chatId ? "known" : "unknown"}` : "not paired" });
    const credentialsPresent = !!config.secrets.appId && !!config.secrets.appSecret && Buffer.byteLength(config.secrets.actionSigningKey) >= 32;
    checks.push({ name: "Credentials", ok: credentialsPresent, detail: credentialsPresent ? "environment values present (values not displayed)" : "one or more required environment values are missing or too short" });
    checks.push({ name: "Delivery queue", ok: true, detail: `${store.queuedDeliveryCount()} pending` });
    for (const item of store.listProjects()) { try { const info = await stat(item.canonicalPath); checks.push({ name: `Project ${item.name}`, ok: info.isDirectory(), detail: item.canonicalPath }); } catch (error) { checks.push({ name: `Project ${item.name}`, ok: false, detail: (error as Error).message }); } }
  } finally { store.close(); }
  for (const check of checks) process.stdout.write(`${check.ok ? "OK" : "FAIL"}\t${check.name}\t${check.detail}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
});

program.command("db").description("Inspect a bounded database table").argument("<table>").option("--limit <number>", "row count", "20").action(async (table: string, options: { limit: string }) => {
  const allowed = ["projects", "sessions", "turns", "pending_interactions", "delivery_queue", "audit_log"] as const;
  if (!allowed.includes(table as typeof allowed[number])) throw new Error(`Table must be one of: ${allowed.join(", ")}`);
  const limit = Math.min(200, Math.max(1, Number(options.limit)));
  const rows = await withStore((store) => store.inspectTable(table as typeof allowed[number], limit));
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
});

const service = program.command("service").description("Manage user-level startup integration");
service.command("install").action(async () => { const artifact = await installService(await serviceOptions()); process.stdout.write(`Installed user service from ${artifact.path}\n`); });
service.command("uninstall").action(async () => { await uninstallService(await serviceOptions()); process.stdout.write("Removed PulseCortex user service.\n"); });
service.command("status").action(async () => { process.stdout.write(await serviceStatus()); });
service.command("generate").description("Preview the platform startup artifact without installing it").action(async () => { const artifact = serviceArtifact(await serviceOptions()); process.stdout.write(`# ${artifact.path}\n${artifact.content}`); });

program.command("retention").description("Apply metadata and command-log retention now").action(async () => {
  const config = await loadConfig({ requireSecrets: false });
  const result = await withStore((store) => store.applyRetention(config.auditRetentionDays));
  const logs = await new CommandLogStore(config.commandLogDir).retain(config.logRetentionDays, config.logMaxBytes);
  process.stdout.write(`${JSON.stringify({ metadata: result, commandLogs: logs })}\n`);
});

program.parseAsync().catch((error) => { process.stderr.write(`pulsectl: ${(error as Error).message}\n`); process.exitCode = 1; });
