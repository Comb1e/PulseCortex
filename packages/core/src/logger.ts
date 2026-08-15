import pino, { type Logger } from "pino";

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: { service: "pulsecortex" },
    redact: {
      paths: ["appId", "appSecret", "signingKey", "secrets", "*.appSecret", "*.token", "*.authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  });
}
