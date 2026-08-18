import path from "node:path";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { redact } from "@pulsecortex/domain";

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("Invalid log identifier");
  return id;
}

export class CommandLogStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly directory: string, private readonly configuredRedactions: RegExp[] = []) {}

  append(turnId: string, stream: "stdout" | "stderr" | "message" | "command", content: string): Promise<void> {
    const id = safeId(turnId);
    const previous = this.pendingWrites.get(id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const line = JSON.stringify({ at: Date.now(), stream, text: redact(content, this.configuredRedactions) });
      await appendFile(path.join(this.directory, `${id}.jsonl`), `${line}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.pendingWrites.set(id, write);
    return write.finally(() => {
      if (this.pendingWrites.get(id) === write) this.pendingWrites.delete(id);
    });
  }

  async read(turnId: string): Promise<string> {
    const id = safeId(turnId);
    await this.pendingWrites.get(id)?.catch(() => undefined);
    const file = BunNotAvailableReadShim(path.join(this.directory, `${id}.jsonl`));
    try {
      const contents = await file;
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { text?: unknown };
          if (typeof entry.text !== "string") throw new Error("Invalid command log entry");
          return entry.text;
        })
        .join("") || "No command output recorded.";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No command output recorded.";
      throw error;
    }
  }

  async retain(maxAgeDays: number, maxBytes: number): Promise<{ removed: number; bytes: number }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    const entries = await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => ({ name, info: await stat(path.join(this.directory, name)) })));
    entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let keptBytes = 0;
    let removed = 0;
    for (const entry of entries) {
      const remove = entry.info.mtimeMs < cutoff || keptBytes + entry.info.size > maxBytes;
      if (remove) { await unlink(path.join(this.directory, entry.name)); removed += 1; }
      else keptBytes += entry.info.size;
    }
    return { removed, bytes: keptBytes };
  }
}

async function BunNotAvailableReadShim(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(filePath, "utf8");
}
