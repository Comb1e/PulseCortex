import { describe, expect, it } from "vitest";
import { isCodexVersionNewerThanSnapshot, isSupportedCodexVersion, SUPPORTED_CODEX_CLI_REQUIREMENT } from "./protocol.js";

describe("Codex protocol compatibility", () => {
  it("accepts the minimum Codex series and newer versions", () => {
    expect(isSupportedCodexVersion("0.147.0")).toBe(true);
    expect(isSupportedCodexVersion("0.147.9")).toBe(true);
    expect(isSupportedCodexVersion("0.148.0")).toBe(true);
    expect(isSupportedCodexVersion("0.148.12")).toBe(true);
    expect(isSupportedCodexVersion("0.149.0")).toBe(true);
    expect(isSupportedCodexVersion("1.0.0")).toBe(true);
    expect(SUPPORTED_CODEX_CLI_REQUIREMENT).toBe("0.147.x or newer");
  });

  it("rejects versions below the minimum and identifies versions newer than the snapshot", () => {
    expect(isSupportedCodexVersion("0.146.9")).toBe(false);
    expect(isSupportedCodexVersion("invalid")).toBe(false);
    expect(isCodexVersionNewerThanSnapshot("0.148.12")).toBe(false);
    expect(isCodexVersionNewerThanSnapshot("0.149.0")).toBe(true);
  });
});
