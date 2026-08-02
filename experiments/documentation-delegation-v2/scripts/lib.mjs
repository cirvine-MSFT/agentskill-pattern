import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, resolve, sep} from "node:path";

export const protocolId = "feature-documentation-delegation-v2-sonnet";
export const experimentRoot = resolve(import.meta.dirname, "..");
export const repositoryRoot = resolve(experimentRoot, "..", "..");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJson(value[key])])
    );
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(stableJson(value), null, 2)}\n`;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function walkFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  walk(root);
  return files;
}

export function directoryDigest(root) {
  const hash = createHash("sha256");
  for (const path of walkFiles(root)) {
    const name = relative(root, path).split(sep).join("/");
    const bytes = readFileSync(path);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function assertInside(root, path) {
  const base = resolve(root);
  const candidate = resolve(path);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes root: ${path}`);
  }
  return candidate;
}

export function exists(path) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function indexBytes(repoRelativePath) {
  return execFileSync("git", ["show", `:${repoRelativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    windowsHide: true
  });
}

export function repoRelative(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}
