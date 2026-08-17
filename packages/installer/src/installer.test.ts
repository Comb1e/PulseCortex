import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexShellArtifact, serviceArtifact, windowsPowerShellProfileBlock, windowsStartupArtifact } from "./index.js";

const options = { dataDir: path.join(os.tmpdir(), "pulse"), daemonEntry: path.join(os.tmpdir(), "daemon.js"), envFile: path.join(os.tmpdir(), "pulse.env"), nodeExecutable: process.execPath };

describe("service artifacts", () => {
  it("generates Windows, macOS, and Linux user startup definitions without secrets", () => {
    const artifacts = [serviceArtifact(options, "win32"), serviceArtifact(options, "darwin"), serviceArtifact(options, "linux")];
    expect(artifacts[0]?.content).toContain("PULSECORTEX_ENV_FILE");
    expect(artifacts[1]?.path).toContain("LaunchAgents");
    expect(artifacts[2]?.content).toContain("[Service]");
    for (const artifact of artifacts) expect(artifact.content).not.toMatch(/app[_-]?secret/iu);
    const startup = windowsStartupArtifact(options, path.join(os.tmpdir(), "AppData", "Roaming"));
    expect(startup.path).toMatch(/Startup[\\/]PulseCortex\.vbs$/u);
    expect(startup.content).toContain("pulsecortex-start.cmd");
    expect(startup.content).toContain(", 0, False");
  });

  it("generates reversible Codex wrappers without embedding secrets", () => {
    const shellOptions = { dataDir: path.join(os.tmpdir(), "pulse"), shimEntry: path.join(os.tmpdir(), "codex-shim.js"), codexExecutable: process.execPath, codexPrefixArgs: ["codex.js"], nodeExecutable: process.execPath };
    const windows = codexShellArtifact(shellOptions, "win32");
    const linux = codexShellArtifact(shellOptions, "linux");
    expect(windows.wrapperPath).toMatch(/codex\.cmd$/u);
    expect(windows.wrapperContent).toContain("--invocation-file");
    expect(windows.pathConfiguredAutomatically).toBe(true);
    const profileBlock = windowsPowerShellProfileBlock(windows.binDir);
    expect(profileBlock).toContain("PulseCortex Codex integration");
    expect(profileBlock).toContain("$env:Path");
    expect(profileBlock).toContain(windows.binDir);
    expect(linux.wrapperContent.startsWith("#!/bin/sh")).toBe(true);
    expect(linux.pathConfiguredAutomatically).toBe(false);
    expect(JSON.parse(windows.invocationContent)).toEqual({ executable: process.execPath, prefixArgs: ["codex.js"] });
  });
});
