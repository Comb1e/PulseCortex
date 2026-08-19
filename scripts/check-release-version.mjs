import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expected = tag?.replace(/^v/, "");

if (!expected || expected === tag || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  throw new Error(`Expected a release tag such as v0.1.0; received ${tag ?? "nothing"}`);
}

const root = JSON.parse(await readFile("package.json", "utf8"));
const packageDirectories = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const manifests = [
  [".", root],
  ...(await Promise.all(packageDirectories.map(async (name) => [
    name,
    JSON.parse(await readFile(join("packages", name, "package.json"), "utf8")),
  ]))),
];

const mismatches = manifests
  .filter(([, manifest]) => manifest.version !== expected)
  .map(([directory, manifest]) => `${directory}: ${manifest.version}`);

if (mismatches.length > 0) {
  throw new Error(`Release tag v${expected} does not match package versions:\n${mismatches.join("\n")}`);
}

console.log(`Release v${expected} contains ${packageDirectories.length} workspace packages.`);
