const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;

const BUILTIN_SECRETS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/giu,
  /\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
];

export function stripTerminalControls(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

export function redact(value: string, configured: RegExp[] = []): string {
  let output = stripTerminalControls(value);
  for (const pattern of [...BUILTIN_SECRETS, ...configured]) output = output.replace(pattern, "[REDACTED]");
  return output;
}

export interface Page {
  text: string;
  page: number;
  totalPages: number;
  truncated: boolean;
}

export function paginate(value: string, page = 1, maxChars = 3_500, maxPages = 20): Page {
  if (maxChars < 100) throw new Error("maxChars must be at least 100");
  const safe = stripTerminalControls(value);
  const naturalPages: string[] = [];
  let remaining = safe;
  while (remaining.length > maxChars && naturalPages.length < maxPages) {
    const window = remaining.slice(0, maxChars + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = boundary > maxChars * 0.6 ? boundary : maxChars;
    naturalPages.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (naturalPages.length < maxPages && remaining) naturalPages.push(remaining);
  const truncated = remaining.length > 0 && naturalPages.length >= maxPages && naturalPages.join("").length < safe.replace(/\s/gu, "").length;
  const totalPages = Math.max(1, naturalPages.length);
  const selected = Math.min(Math.max(1, page), totalPages);
  let text = naturalPages[selected - 1] ?? "";
  if (truncated && selected === totalPages) text += "\n\n[Output truncated by PulseCortex]";
  return { text, page: selected, totalPages, truncated };
}

export function summarizeCommand(command: string): string {
  const clean = redact(command).trim().replace(/\s+/gu, " ");
  return clean.length <= 160 ? clean : `${clean.slice(0, 157)}...`;
}
