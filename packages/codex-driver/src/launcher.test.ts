import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexInvocation } from "./launcher.js";

describe("Codex executable resolution", () => {
  it("pins the Codex executable found on a POSIX PATH", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-codex-path-"));
    const executable = path.join(directory, "codex");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o700);

    expect(resolveCodexInvocation(undefined, { platform: "linux", pathEntries: [directory] })).toEqual({ executable, prefixArgs: [] });
  });

  it("skips an installed PulseCortex shim and resolves its original Codex command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pulse-codex-shim-"));
    const shimDirectory = path.join(root, "pulse-bin");
    const codexDirectory = path.join(root, "codex-bin");
    await mkdir(shimDirectory);
    await mkdir(codexDirectory);
    await writeFile(path.join(shimDirectory, "codex"), "#!/bin/sh\n");
    await chmod(path.join(shimDirectory, "codex"), 0o700);
    await writeFile(path.join(shimDirectory, "codex-invocation.json"), `${JSON.stringify({ executable: "codex", prefixArgs: [] })}\n`);
    await writeFile(path.join(codexDirectory, "codex"), "#!/bin/sh\n");
    await chmod(path.join(codexDirectory, "codex"), 0o700);

    expect(resolveCodexInvocation(undefined, { platform: "linux", pathEntries: [shimDirectory, codexDirectory] })).toEqual({
      executable: path.join(codexDirectory, "codex"),
      prefixArgs: [],
    });
    expect(resolveCodexInvocation("codex", {
      platform: "linux",
      pathEntries: [shimDirectory, codexDirectory],
      excludedDirectories: [shimDirectory],
    })).toEqual({ executable: path.join(codexDirectory, "codex"), prefixArgs: [] });
  });
});
