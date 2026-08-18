import { describe, expect, it } from "vitest";
import path from "node:path";
import { defaultCodexAppServerUrl, loadConfig } from "./index.js";

describe("defaultCodexAppServerUrl", () => {
  it("uses separate ports for Windows and Linux", () => {
    expect(defaultCodexAppServerUrl("win32")).toBe("ws://127.0.0.1:4500");
    expect(defaultCodexAppServerUrl("linux")).toBe("ws://127.0.0.1:4501");
  });

  it("keeps the original port on macOS", () => {
    expect(defaultCodexAppServerUrl("darwin")).toBe("ws://127.0.0.1:4500");
  });
});

describe("runtime paths", () => {
  it("stores daemon logs in the logs directory", async () => {
    const previous = process.env["PULSECORTEX_DATA_DIR"];
    process.env["PULSECORTEX_DATA_DIR"] = path.resolve("runtime-data");
    try {
      const config = await loadConfig({ requireSecrets: false });
      expect(config.logDir).toBe(path.resolve("runtime-data", "logs"));
    } finally {
      if (previous === undefined) delete process.env["PULSECORTEX_DATA_DIR"];
      else process.env["PULSECORTEX_DATA_DIR"] = previous;
    }
  });
});
