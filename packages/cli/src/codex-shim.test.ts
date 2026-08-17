import { describe, expect, it } from "vitest";
import { routeCodexArguments, shouldUsePulseCortex } from "./codex-shim.js";

describe("Codex shell routing", () => {
  it("routes interactive and session-management commands through PulseCortex", () => {
    expect(routeCodexArguments([], "ws://127.0.0.1:4500")).toEqual(["--remote", "ws://127.0.0.1:4500"]);
    expect(routeCodexArguments(["fix", "the", "tests"], "ws://127.0.0.1:4500")).toEqual(["--remote", "ws://127.0.0.1:4500", "fix", "the", "tests"]);
    expect(routeCodexArguments(["-m", "gpt-5", "resume", "--last"], "ws://127.0.0.1:4500")).toEqual(["--remote", "ws://127.0.0.1:4500", "-m", "gpt-5", "resume", "--last"]);
  });

  it("leaves maintenance, non-interactive, help, and explicit remote commands unchanged", () => {
    expect(shouldUsePulseCortex(["exec", "run tests"])).toBe(false);
    expect(shouldUsePulseCortex(["login"])).toBe(false);
    expect(shouldUsePulseCortex(["--version"])).toBe(false);
    expect(shouldUsePulseCortex(["--remote", "ws://127.0.0.1:9999"])).toBe(false);
  });
});
