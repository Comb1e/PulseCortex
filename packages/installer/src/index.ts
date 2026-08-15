import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface ServiceInstallOptions {
  dataDir: string;
  daemonEntry: string;
  envFile: string;
  nodeExecutable?: string;
}

export interface ServiceArtifact { path: string; content: string }

function quoteXml(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;"); }

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
    await execFileAsync("schtasks.exe", ["/Create", "/SC", "ONLOGON", "/TN", "PulseCortex", "/TR", artifact.path, "/F", "/RL", "LIMITED"], { windowsHide: true });
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
  if (process.platform === "win32") await execFileAsync("schtasks.exe", ["/Delete", "/TN", "PulseCortex", "/F"], { windowsHide: true }).catch(() => undefined);
  else if (process.platform === "darwin") await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, artifact.path]).catch(() => undefined);
  else {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "pulsecortex.service"]).catch(() => undefined);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  await rm(artifact.path, { force: true });
}

export async function serviceStatus(): Promise<string> {
  if (process.platform === "win32") return (await execFileAsync("schtasks.exe", ["/Query", "/TN", "PulseCortex", "/FO", "LIST"], { windowsHide: true })).stdout;
  if (process.platform === "darwin") return (await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/dev.pulsecortex.daemon`])).stdout;
  return (await execFileAsync("systemctl", ["--user", "status", "pulsecortex.service", "--no-pager"])).stdout;
}
