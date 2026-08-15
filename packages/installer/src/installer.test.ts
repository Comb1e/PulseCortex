import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serviceArtifact } from "./index.js";

const options = { dataDir: path.join(os.tmpdir(), "pulse"), daemonEntry: path.join(os.tmpdir(), "daemon.js"), envFile: path.join(os.tmpdir(), "pulse.env"), nodeExecutable: process.execPath };

describe("service artifacts", () => {
  it("generates Windows, macOS, and Linux user startup definitions without secrets", () => {
    const artifacts = [serviceArtifact(options, "win32"), serviceArtifact(options, "darwin"), serviceArtifact(options, "linux")];
    expect(artifacts[0]?.content).toContain("PULSECORTEX_ENV_FILE");
    expect(artifacts[1]?.path).toContain("LaunchAgents");
    expect(artifacts[2]?.content).toContain("[Service]");
    for (const artifact of artifacts) expect(artifact.content).not.toMatch(/app[_-]?secret/iu);
  });
});
