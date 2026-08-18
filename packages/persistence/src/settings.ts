import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LocalSettings {
  defaultProject: string | null;
  autoStartOnBoot: boolean;
}

export type LocalSettingKey = keyof LocalSettings;

export const LOCAL_SETTING_DEFAULTS: LocalSettings = {
  defaultProject: null,
  autoStartOnBoot: false,
};

function parseSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings.json must contain a JSON object");
  return { ...(raw as Record<string, unknown>) };
}

function validateSettings(values: Record<string, unknown>): LocalSettings {
  const defaultProject = values["defaultProject"] ?? null;
  const autoStartOnBoot = values["autoStartOnBoot"] ?? false;
  if (defaultProject !== null && typeof defaultProject !== "string") throw new Error("settings.json has an invalid defaultProject");
  if (typeof autoStartOnBoot !== "boolean") throw new Error("settings.json has an invalid autoStartOnBoot");
  return { defaultProject, autoStartOnBoot };
}

export class LocalSettingsFile {
  private values: Record<string, unknown>;

  constructor(private readonly filePath?: string) {
    if (!filePath) {
      this.values = { ...LOCAL_SETTING_DEFAULTS };
      return;
    }
    try {
      this.values = parseSettings(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.values = { ...LOCAL_SETTING_DEFAULTS };
      this.persist();
    }
    validateSettings(this.values);
  }

  get(): LocalSettings {
    this.reload();
    return validateSettings(this.values);
  }

  set<K extends LocalSettingKey>(key: K, value: LocalSettings[K]): void {
    this.reload();
    if (key === "defaultProject" && value !== null && typeof value !== "string") throw new Error("defaultProject must be a project name or null");
    if (key === "autoStartOnBoot" && typeof value !== "boolean") throw new Error("autoStartOnBoot must be a boolean");
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.persist();
  }

  entries(): Array<{ key: string; value: unknown }> {
    this.reload();
    return Object.entries(this.values).map(([key, value]) => ({ key, value }));
  }

  private reload(): void {
    if (!this.filePath) return;
    this.values = parseSettings(JSON.parse(readFileSync(this.filePath, "utf8")) as unknown);
    validateSettings(this.values);
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

export function hasSettingsFile(filePath: string): boolean {
  return existsSync(filePath);
}
