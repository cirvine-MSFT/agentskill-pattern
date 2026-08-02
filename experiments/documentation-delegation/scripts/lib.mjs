import {createHash} from "node:crypto";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, resolve, sep} from "node:path";

export const experimentRoot = resolve(import.meta.dirname, "..");
export const repositoryRoot = resolve(experimentRoot, "..", "..");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

export function walkFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name))) {
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
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes root: ${path}`);
  }
  return resolvedPath;
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
