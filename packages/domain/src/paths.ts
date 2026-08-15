import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export function normalizePathForComparison(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePathForComparison(left);
  const b = normalizePathForComparison(right);
  const relAB = path.relative(a, b);
  const relBA = path.relative(b, a);
  return relAB === "" || (!relAB.startsWith("..") && !path.isAbsolute(relAB)) || (!relBA.startsWith("..") && !path.isAbsolute(relBA));
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(normalizePathForComparison(root), normalizePathForComparison(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function canonicalProjectPath(candidate: string): Promise<string> {
  const canonical = await realpath(path.resolve(candidate));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("Project path must be a directory");
  return canonical;
}
