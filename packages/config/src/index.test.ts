import { describe, expect, it } from "vitest";
import { defaultCodexAppServerUrl } from "./index.js";

describe("defaultCodexAppServerUrl", () => {
  it("uses separate ports for Windows and Linux", () => {
    expect(defaultCodexAppServerUrl("win32")).toBe("ws://127.0.0.1:4500");
    expect(defaultCodexAppServerUrl("linux")).toBe("ws://127.0.0.1:4501");
  });

  it("keeps the original port on macOS", () => {
    expect(defaultCodexAppServerUrl("darwin")).toBe("ws://127.0.0.1:4500");
  });
});
