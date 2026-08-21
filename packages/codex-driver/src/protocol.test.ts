import { describe, expect, it } from "vitest";
import { isSupportedCodexVersion, SUPPORTED_CODEX_CLI_REQUIREMENT } from "./protocol.js";

describe("Codex protocol compatibility", () => {
  it("accepts every Codex series covered by the current protocol snapshots", () => {
    expect(isSupportedCodexVersion("0.147.0")).toBe(true);
    expect(isSupportedCodexVersion("0.147.9")).toBe(true);
    expect(isSupportedCodexVersion("0.148.0")).toBe(true);
    expect(isSupportedCodexVersion("0.148.12")).toBe(true);
    expect(SUPPORTED_CODEX_CLI_REQUIREMENT).toBe("0.147.x through 0.148.x");
  });

  it("rejects versions outside the generated protocol range", () => {
    expect(isSupportedCodexVersion("0.146.9")).toBe(false);
    expect(isSupportedCodexVersion("0.149.0")).toBe(false);
    expect(isSupportedCodexVersion("invalid")).toBe(false);
  });
});
