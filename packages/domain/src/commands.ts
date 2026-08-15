import type { CommandName } from "./types.js";

const COMMANDS = new Set<CommandName>([
  "pair", "projects", "new", "sessions", "resume", "send", "status", "stop", "logs", "diff", "help",
]);

export interface ParsedCommand {
  name: CommandName | "text" | "unknown";
  args: string[];
  text: string;
}

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { name: "text", args: [], text };
  const [head = "", ...args] = text.slice(1).split(/\s+/u);
  const normalized = head.toLowerCase().split("@")[0] ?? "";
  return {
    name: COMMANDS.has(normalized as CommandName) ? normalized as CommandName : "unknown",
    args,
    text,
  };
}
