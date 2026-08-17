import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface ServiceInstallOptions {
  dataDir: string;
  daemonEntry: string;
  envFile: string;
  nodeExecutable?: string;
}

export interface ServiceArtifact { path: string; content: string }

export interface CodexShellInstallOptions {
  dataDir: string;
  shimEntry: string;
  codexExecutable: string;
  codexPrefixArgs: string[];
  nodeExecutable?: string;
}

export interface CodexShellArtifact {
  binDir: string;
  wrapperPath: string;
  invocationPath: string;
  wrapperContent: string;
  invocationContent: string;
  pathConfiguredAutomatically: boolean;
}

function quoteXml(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;"); }

export function windowsStartupArtifact(options: ServiceInstallOptions, appData = process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming")): ServiceArtifact {
  const launcher = path.join(options.dataDir, "pulsecortex-start.cmd").replace(/"/gu, "\"\"");
  return { path: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "PulseCortex.vbs"), content: `Set shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & "${launcher}" & Chr(34), 0, False\r\n` };
}

function legacyWindowsStartupPath(startupPath: string): string { return path.join(path.dirname(startupPath), "PulseCortex.cmd"); }

function quoteShell(value: string): string { return `'${value.replace(/'/gu, `'"'"'`)}'`; }

export function codexShellArtifact(options: CodexShellInstallOptions, platform = process.platform): CodexShellArtifact {
  const binDir = path.join(options.dataDir, "bin");
  const invocationPath = path.join(binDir, "codex-invocation.json");
  const wrapperPath = path.join(binDir, platform === "win32" ? "codex.cmd" : "codex");
  const node = options.nodeExecutable ?? process.execPath;
  const invocationContent = `${JSON.stringify({ executable: options.codexExecutable, prefixArgs: options.codexPrefixArgs }, null, 2)}\n`;
  const wrapperContent = platform === "win32"
    ? `@echo off\r\n"${node}" "${options.shimEntry}" --invocation-file "${invocationPath}" -- %*\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\nexec ${quoteShell(node)} ${quoteShell(options.shimEntry)} --invocation-file ${quoteShell(invocationPath)} -- "$@"\n`;
  return { binDir, wrapperPath, invocationPath, wrapperContent, invocationContent, pathConfiguredAutomatically: platform === "win32" };
}

function windowsPathScript(install: boolean): string {
  return `$target = $env:PULSECORTEX_CODEX_BIN
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($current -split ';' | Where-Object { $_ -and $_.Trim() })
$key = $target.Trim().Trim('"').TrimEnd('\\').ToLowerInvariant()
$kept = @($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\\').ToLowerInvariant() -ne $key })
$next = ${install ? "@($target) + $kept" : "$kept"}
[Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User')`;
}

const POWERSHELL_PROFILE_MARKER_START = "# >>> PulseCortex Codex integration >>>";
const POWERSHELL_PROFILE_MARKER_END = "# <<< PulseCortex Codex integration <<<";

export function windowsPowerShellProfileBlock(binDir: string): string {
  const quotedBinDir = binDir.replace(/'/gu, "''");
  return `${POWERSHELL_PROFILE_MARKER_START}\r\n$pulseCortexBin = '${quotedBinDir}'\r\n$remainingPath = @($env:Path -split ';' | Where-Object { $_ -and $_ -ne $pulseCortexBin })\r\n$env:Path = (@($pulseCortexBin) + $remainingPath) -join ';'\r\n${POWERSHELL_PROFILE_MARKER_END}`;
}

function windowsPowerShellProfileScript(): string {
  return `$profilePath = $PROFILE.CurrentUserAllHosts
$markerStart = [regex]::Escape('${POWERSHELL_PROFILE_MARKER_START}')
$markerEnd = [regex]::Escape('${POWERSHELL_PROFILE_MARKER_END}')
$pattern = "(?ms)^$markerStart\\r?\\n.*?^$markerEnd\\r?\\n?"
$content = if (Test-Path -LiteralPath $profilePath) { [IO.File]::ReadAllText($profilePath) } else { '' }
$content = [regex]::Replace($content, $pattern, '').TrimEnd()
$block = $env:PULSECORTEX_POWERSHELL_PROFILE_BLOCK
if ($block) {
  if ($content) { $content += "\`r\`n\`r\`n" }
  $content += $block + "\`r\`n"
}
if ($content) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePath) | Out-Null
  [IO.File]::WriteAllText($profilePath, $content, [Text.UTF8Encoding]::new($false))
} elseif (Test-Path -LiteralPath $profilePath) {
  Remove-Item -LiteralPath $profilePath -Force
}`;
}

async function configureWindowsUserPath(binDir: string, install: boolean): Promise<void> {
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsPathScript(install)], {
    windowsHide: true,
    env: { ...process.env, PULSECORTEX_CODEX_BIN: binDir },
  });
}

async function configureWindowsPowerShellProfiles(binDir: string, install: boolean): Promise<void> {
  const env = { ...process.env, PULSECORTEX_POWERSHELL_PROFILE_BLOCK: install ? windowsPowerShellProfileBlock(binDir) : "" };
  const args = ["-NoProfile", "-NonInteractive", "-Command", windowsPowerShellProfileScript()];
  await execFileAsync("powershell.exe", args, { windowsHide: true, env });
  try { await execFileAsync("pwsh.exe", args, { windowsHide: true, env }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function installCodexShell(options: CodexShellInstallOptions): Promise<CodexShellArtifact> {
  const artifact = codexShellArtifact(options);
  await mkdir(artifact.binDir, { recursive: true, mode: 0o700 });
  await writeFile(artifact.invocationPath, artifact.invocationContent, { encoding: "utf8", mode: 0o600 });
  await writeFile(artifact.wrapperPath, artifact.wrapperContent, { encoding: "utf8", mode: 0o700 });
  await chmod(artifact.wrapperPath, 0o700).catch(() => undefined);
  if (process.platform === "win32") {
    await configureWindowsUserPath(artifact.binDir, true);
    await configureWindowsPowerShellProfiles(artifact.binDir, true);
  }
  return artifact;
}

export async function uninstallCodexShell(options: Pick<CodexShellInstallOptions, "dataDir">): Promise<CodexShellArtifact> {
  const artifact = codexShellArtifact({ ...options, shimEntry: "", codexExecutable: "", codexPrefixArgs: [] });
  if (process.platform === "win32") {
    await configureWindowsUserPath(artifact.binDir, false);
    await configureWindowsPowerShellProfiles(artifact.binDir, false);
  }
  await rm(artifact.wrapperPath, { force: true });
  await rm(artifact.invocationPath, { force: true });
  return artifact;
}

export function serviceArtifact(options: ServiceInstallOptions, platform = process.platform): ServiceArtifact {
  const node = options.nodeExecutable ?? process.execPath;
  if (platform === "win32") {
    const file = path.join(options.dataDir, "pulsecortex-start.cmd");
    return { path: file, content: `@echo off\r\nset "PULSECORTEX_ENV_FILE=${options.envFile}"\r\n"${node}" "${options.daemonEntry}"\r\n` };
  }
  if (platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", "dev.pulsecortex.daemon.plist");
    return { path: file, content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.pulsecortex.daemon</string>
<key>ProgramArguments</key><array><string>${quoteXml(node)}</string><string>${quoteXml(options.daemonEntry)}</string></array>
<key>EnvironmentVariables</key><dict><key>PULSECORTEX_ENV_FILE</key><string>${quoteXml(options.envFile)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${quoteXml(path.join(options.dataDir, "service.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${quoteXml(path.join(options.dataDir, "service.stderr.log"))}</string>
</dict></plist>\n` };
  }
  const file = path.join(os.homedir(), ".config", "systemd", "user", "pulsecortex.service");
  const systemdQuote = (value: string) => `"${value.replace(/%/gu, "%%").replace(/([\\"$`])/gu, "\\$1")}"`;
  return { path: file, content: `[Unit]
Description=PulseCortex remote coding-agent controller
After=network-online.target

[Service]
Type=simple
Environment=${systemdQuote(`PULSECORTEX_ENV_FILE=${options.envFile}`)}
ExecStart=${systemdQuote(node)} ${systemdQuote(options.daemonEntry)}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
` };
}

export async function installService(options: ServiceInstallOptions): Promise<ServiceArtifact> {
  const artifact = serviceArtifact(options);
  await mkdir(path.dirname(artifact.path), { recursive: true, mode: 0o700 });
  await writeFile(artifact.path, artifact.content, { encoding: "utf8", mode: 0o700 });
  await chmod(artifact.path, 0o700).catch(() => undefined);
  if (process.platform === "win32") {
    const startup = windowsStartupArtifact(options);
    try {
      await execFileAsync("schtasks.exe", ["/Create", "/SC", "ONLOGON", "/TN", "PulseCortex", "/TR", artifact.path, "/F", "/RL", "LIMITED"], { windowsHide: true });
      await rm(startup.path, { force: true });
      await rm(legacyWindowsStartupPath(startup.path), { force: true });
      await execFileAsync("schtasks.exe", ["/Run", "/TN", "PulseCortex"], { windowsHide: true });
    } catch {
      await execFileAsync("schtasks.exe", ["/Delete", "/TN", "PulseCortex", "/F"], { windowsHide: true }).catch(() => undefined);
      await mkdir(path.dirname(startup.path), { recursive: true, mode: 0o700 });
      await writeFile(startup.path, startup.content, { encoding: "utf8", mode: 0o700 });
      await rm(legacyWindowsStartupPath(startup.path), { force: true });
      const child = spawn(options.nodeExecutable ?? process.execPath, [options.daemonEntry], {
        detached: true,
        env: { ...process.env, PULSECORTEX_ENV_FILE: options.envFile },
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
  } else if (process.platform === "darwin") {
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, artifact.path]).catch(() => undefined);
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, artifact.path]);
  } else {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", "pulsecortex.service"]);
  }
  return artifact;
}

export async function uninstallService(options: ServiceInstallOptions): Promise<void> {
  const artifact = serviceArtifact(options);
  if (process.platform === "win32") {
    await execFileAsync("schtasks.exe", ["/End", "/TN", "PulseCortex"], { windowsHide: true }).catch(() => undefined);
    await execFileAsync("schtasks.exe", ["/Delete", "/TN", "PulseCortex", "/F"], { windowsHide: true }).catch(() => undefined);
    const startup = windowsStartupArtifact(options);
    await rm(startup.path, { force: true });
    await rm(legacyWindowsStartupPath(startup.path), { force: true });
  }
  else if (process.platform === "darwin") await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, artifact.path]).catch(() => undefined);
  else {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "pulsecortex.service"]).catch(() => undefined);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  await rm(artifact.path, { force: true });
}

export async function serviceStatus(): Promise<string> {
  if (process.platform === "win32") {
    try { return (await execFileAsync("schtasks.exe", ["/Query", "/TN", "PulseCortex", "/FO", "LIST"], { windowsHide: true })).stdout; }
    catch {
      const startup = windowsStartupArtifact({ dataDir: "", daemonEntry: "", envFile: "" });
      try { await access(startup.path); return `PulseCortex Startup fallback installed at ${startup.path}\n`; }
      catch {
        const legacy = legacyWindowsStartupPath(startup.path);
        try { await access(legacy); return `PulseCortex legacy Startup fallback installed at ${legacy}\n`; }
        catch { throw new Error("PulseCortex user service is not installed"); }
      }
    }
  }
  if (process.platform === "darwin") return (await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/dev.pulsecortex.daemon`])).stdout;
  return (await execFileAsync("systemctl", ["--user", "status", "pulsecortex.service", "--no-pager"])).stdout;
}
