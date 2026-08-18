#!/usr/bin/env node
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { loadConfig, defaultCodexAppServerUrl, defaultDataDir } from "@pulsecortex/config";
import { codexEnvironment, detectCodexVersion, resolveCodexInvocation } from "@pulsecortex/codex-driver";
import { canonicalProjectPath, isPathInside } from "@pulsecortex/domain";
import { installCodexShell, installService, serviceArtifact, serviceStatus, uninstallCodexShell, uninstallService } from "@pulsecortex/installer";
import { CommandLogStore, ControllerStore } from "@pulsecortex/persistence";

const execFileAsync = promisify(execFile);

async function withStore<T>(work: (store: ControllerStore) => Promise<T> | T): Promise<T> {
  const config = await loadConfig({ requireSecrets: false });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new ControllerStore(config.databasePath, config.settingsPath);
  try { return await work(store); } finally { store.close(); }
}

async function serviceOptions() {
  const config = await loadConfig({ requireSecrets: false });
  const daemonEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../daemon/dist/main.js");
  return { dataDir: config.dataDir, daemonEntry, envFile: process.env["PULSECORTEX_ENV_FILE"] ?? path.join(config.dataDir, "pulsecortex.env") };
}

async function codexShellOptions() {
  const config = await loadConfig({ requireSecrets: false });
  const invocation = resolveCodexInvocation();
  const shimEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/codex-shim.js");
  return { dataDir: config.dataDir, shimEntry, codexExecutable: invocation.executable, codexPrefixArgs: invocation.prefixArgs };
}

async function setAutoStartOnBoot(enabled: boolean): Promise<void> {
  if (enabled) await installService(await serviceOptions());
  else await uninstallService(await serviceOptions());
  await withStore((store) => store.setLocalSetting("autoStartOnBoot", enabled));
}

function parseBooleanSetting(value: string): boolean {
  if (/^(?:true|on|yes|1)$/iu.test(value)) return true;
  if (/^(?:false|off|no|0)$/iu.test(value)) return false;
  throw new Error("Value must be true or false");
}

const program = new Command().name("pulsectl").description("Local administration for PulseCortex").version("0.1.0");

program.command("init").description("Create non-secret config and a permission-restricted secret template").action(async () => {
  const dataDir = defaultDataDir();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dataDir, "config.json");
  const envPath = path.join(dataDir, "pulsecortex.env");
  try { await access(configPath); } catch { await writeFile(configPath, `${JSON.stringify({ statusUpdateIntervalMs: 2000, approvalTtlMs: 900000, auditRetentionDays: 30, logRetentionDays: 7, logMaxBytes: 100000000, redactionPatterns: [], codexAppServerUrl: defaultCodexAppServerUrl() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
  try { await access(envPath); } catch { await writeFile(envPath, "# Keep this file readable only by your desktop user.\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\n# Generate at least 32 random bytes, for example: openssl rand -base64 48\nPULSECORTEX_ACTION_SIGNING_KEY=\n", { encoding: "utf8", mode: 0o600 }); }
  await withStore(() => undefined);
  if (process.platform === "win32") {
    const user = process.env["USERNAME"];
    if (!user) throw new Error("USERNAME is unavailable; cannot restrict the secret file ACL");
    await execFileAsync("icacls.exe", [envPath, "/inheritance:r", "/grant:r", `${user}:(R,W)`], { windowsHide: true });
  }
  process.stdout.write(`Initialized ${dataDir}\nSet credentials in ${envPath}\n`);
});

const project = program.command("project").description("Manage the local project allowlist");
project.command("add").description("Register a project directory").argument("<name>").argument("<path>").action(async (name: string, inputPath: string) => {
  const canonical = await canonicalProjectPath(inputPath);
  const added = await withStore((store) => store.addProject(name, canonical));
  process.stdout.write(`Registered ${added.name}: ${added.canonicalPath}\n`);
});
project.command("list").description("List registered projects").action(async () => { const projects = await withStore((store) => store.listProjects()); process.stdout.write(projects.length ? projects.map((item) => `${item.name}\t${item.canonicalPath}`).join("\n") + "\n" : "No projects registered.\n"); });
project.command("remove").description("Remove a registered project").argument("<name>").action(async (name: string) => { const removed = await withStore((store) => store.removeProject(name)); process.stdout.write(removed ? `Removed ${name}\n` : `Project ${name} was not found\n`); });

program.command("pair").description("Generate a short-lived owner pairing code").option("--ttl <minutes>", "expiry in minutes", "10").action(async (options: { ttl: string }) => {
  const minutes = Number(options.ttl);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error("Pairing TTL must be between 1 and 60 minutes");
  const result = await withStore((store) => store.createPairingCode(minutes * 60_000));
  process.stdout.write(`Send this in a direct chat with the bot: /pair ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\n`);
});

program.command("codex").description("Launch Codex in a registered project on the PulseCortex shared app-server")
  .argument("[project-or-prompt]").argument("[prompt...]")
  .action(async (projectOrPrompt: string | undefined, remainingPrompt: string[]) => {
    const config = await loadConfig({ requireSecrets: false });
    const currentDirectory = await canonicalProjectPath(process.cwd());
    const { projects, settings } = await withStore((store) => ({ projects: store.listProjects(), settings: store.getLocalSettings() }));
    const named = projectOrPrompt ? projects.find((project) => project.name === projectOrPrompt) : undefined;
    const remembered = settings.defaultProject ? projects.find((project) => project.name.toLocaleLowerCase() === settings.defaultProject?.toLocaleLowerCase()) : undefined;
    const registered = named ?? remembered ?? projects.find((project) => isPathInside(project.canonicalPath, currentDirectory));
    if (!registered) throw new Error(projectOrPrompt ? `Project '${projectOrPrompt}' is not registered, the current directory is outside every registered project, and no default project is saved` : "The current directory is outside every registered project and no default project is saved");
    await withStore((store) => store.setLocalSetting("defaultProject", registered.name));
    const prompt = named ? remainingPrompt : [...(projectOrPrompt ? [projectOrPrompt] : []), ...remainingPrompt];
    const healthUrl = new URL(config.codexAppServerUrl); healthUrl.protocol = "http:"; healthUrl.pathname = "/readyz";
    try {
      const response = await fetch(healthUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      throw new Error(`PulseCortex Codex app-server is not ready at ${config.codexAppServerUrl}; start the daemon first`);
    }
    const invocation = resolveCodexInvocation();
    const args = [...invocation.prefixArgs, "--remote", config.codexAppServerUrl, "-C", registered.canonicalPath, ...(prompt.length ? [prompt.join(" ")] : [])];
    const child = spawn(invocation.executable, args, { cwd: registered.canonicalPath, env: codexEnvironment(), stdio: "inherit", windowsHide: false });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => signal ? reject(new Error(`Codex exited from signal ${signal}`)) : resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}`);
  });

program.command("diagnose").description("Check Codex, database, pairing, projects, credentials, and delivery queue").action(async () => {
  const config = await loadConfig({ requireSecrets: false });
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try { const codex = await detectCodexVersion(); checks.push({ name: "Codex", ok: codex.compatible, detail: `${codex.version}${codex.compatible ? "" : " (unsupported; requires 0.147.x)"}` }); }
  catch (error) { checks.push({ name: "Codex", ok: false, detail: (error as Error).message }); }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new ControllerStore(config.databasePath, config.settingsPath);
  try {
    const integrity = store.integrityCheck(); checks.push({ name: "Database", ok: integrity.every((value) => value === "ok"), detail: integrity.join(", ") });
    const owner = store.getOwner(); checks.push({ name: "Owner", ok: !!owner, detail: owner ? `paired; chat ${owner.chatId ? "known" : "unknown"}` : "not paired" });
    const credentialsPresent = !!config.secrets.appId && !!config.secrets.appSecret && Buffer.byteLength(config.secrets.actionSigningKey) >= 32;
    checks.push({ name: "Credentials", ok: credentialsPresent, detail: credentialsPresent ? "environment values present (values not displayed)" : "one or more required environment values are missing or too short" });
    checks.push({ name: "Delivery queue", ok: true, detail: `${store.queuedDeliveryCount()} pending` });
    const healthUrl = new URL(config.codexAppServerUrl); healthUrl.protocol = "http:"; healthUrl.pathname = "/readyz";
    try { const response = await fetch(healthUrl); checks.push({ name: "Shared Codex", ok: response.ok, detail: response.ok ? config.codexAppServerUrl : `HTTP ${response.status}` }); }
    catch { checks.push({ name: "Shared Codex", ok: false, detail: `${config.codexAppServerUrl} is not ready` }); }
    for (const item of store.listProjects()) { try { const info = await stat(item.canonicalPath); checks.push({ name: `Project ${item.name}`, ok: info.isDirectory(), detail: item.canonicalPath }); } catch (error) { checks.push({ name: `Project ${item.name}`, ok: false, detail: (error as Error).message }); } }
  } finally { store.close(); }
  for (const check of checks) process.stdout.write(`${check.ok ? "OK" : "FAIL"}\t${check.name}\t${check.detail}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
});

program.command("db").description("Inspect a bounded database table").argument("<table>").option("--limit <number>", "row count", "20").action(async (table: string, options: { limit: string }) => {
  const allowed = ["projects", "sessions", "turns", "pending_interactions", "delivery_queue", "audit_log", "local_settings"] as const;
  if (!allowed.includes(table as typeof allowed[number])) throw new Error(`Table must be one of: ${allowed.join(", ")}`);
  const limit = Math.min(200, Math.max(1, Number(options.limit)));
  const rows = await withStore((store) => store.inspectTable(table as typeof allowed[number], limit));
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
});

const service = program.command("service").description("Manage user-level startup integration");
service.command("install").action(async () => { const artifact = await installService(await serviceOptions()); await withStore((store) => store.setLocalSetting("autoStartOnBoot", true)); process.stdout.write(`Installed user service from ${artifact.path}\n`); });
service.command("uninstall").action(async () => { await uninstallService(await serviceOptions()); await withStore((store) => store.setLocalSetting("autoStartOnBoot", false)); process.stdout.write("Removed PulseCortex user service.\n"); });
service.command("status").action(async () => { process.stdout.write(await serviceStatus()); });
service.command("generate").description("Preview the platform startup artifact without installing it").action(async () => { const artifact = serviceArtifact(await serviceOptions()); process.stdout.write(`# ${artifact.path}\n${artifact.content}`); });

const settings = program.command("settings").description("Manage local PulseCortex preferences");
settings.command("list").action(async () => {
  const values = await withStore((store) => {
    const local = store.getLocalSettings();
    return { local, project: local.defaultProject ? store.getProject(local.defaultProject) : null };
  });
  process.stdout.write(`default-project\t${values.project?.name ?? "none"}\nauto-start-on-boot\t${values.local.autoStartOnBoot}\n`);
});
settings.command("set").argument("<name>").argument("<value>").action(async (name: string, value: string) => {
  switch (name.toLowerCase()) {
    case "default-project": {
      const projectName = /^(?:none|null|off)$/iu.test(value) ? null : value;
      await withStore((store) => {
        const project = projectName ? store.getProject(projectName) : null;
        if (projectName && !project) throw new Error(`Project '${projectName}' is not registered`);
        store.setLocalSetting("defaultProject", project?.name ?? null);
      });
      process.stdout.write(`Default project set to ${projectName ?? "none"}.\n`);
      break;
    }
    case "auto-start-on-boot": {
      const enabled = parseBooleanSetting(value);
      await setAutoStartOnBoot(enabled);
      process.stdout.write(`Auto-start on boot ${enabled ? "enabled" : "disabled"}.\n`);
      break;
    }
    default: throw new Error("Setting must be default-project or auto-start-on-boot");
  }
});

const shell = program.command("shell").description("Make ordinary Codex CLI sessions controllable through PulseCortex");
shell.command("install").action(async () => {
  const artifact = await installCodexShell(await codexShellOptions());
  process.stdout.write(`Installed Codex integration at ${artifact.wrapperPath}\n${artifact.pathConfiguredAutomatically ? "Open a new terminal, then run codex normally.\n" : `Prepend ${artifact.binDir} to PATH, then run codex normally.\n`}`);
});
shell.command("uninstall").action(async () => {
  const config = await loadConfig({ requireSecrets: false });
  await uninstallCodexShell({ dataDir: config.dataDir });
  process.stdout.write("Removed the PulseCortex Codex shell integration. Open a new terminal to refresh PATH.\n");
});

program.command("retention").description("Apply metadata and command-log retention now").action(async () => {
  const config = await loadConfig({ requireSecrets: false });
  const result = await withStore((store) => store.applyRetention(config.auditRetentionDays));
  const logs = await new CommandLogStore(config.commandLogDir).retain(config.logRetentionDays, config.logMaxBytes);
  process.stdout.write(`${JSON.stringify({ metadata: result, commandLogs: logs })}\n`);
});

program.parseAsync().catch((error) => { process.stderr.write(`pulsectl: ${(error as Error).message}\n`); process.exitCode = 1; });
