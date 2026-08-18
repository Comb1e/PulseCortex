import type { CommandName } from "./types.js";

const COMMANDS = new Set<CommandName>([
  "pair", "projects", "new", "sessions", "instructions", "resume", "send", "status", "stop", "logs", "diff", "help",
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
  const commandName = normalized === "instruction" ? "instructions" : normalized;
  return {
    name: COMMANDS.has(commandName as CommandName) ? commandName as CommandName : "unknown",
    args,
    text,
  };
}
