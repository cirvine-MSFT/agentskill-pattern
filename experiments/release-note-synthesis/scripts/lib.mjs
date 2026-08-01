import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repositoryRoot = resolve(root, "..", "..");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function relativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function dossierPaths() {
  const base = resolve(root, "fixtures", "dossiers");
  const paths = [];
  for (const partition of ["development", "excluded-pilot"]) {
    const directory = resolve(base, partition);
    for (const name of readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
      paths.push(resolve(directory, name));
    }
  }
  return paths;
}

export function goldPaths() {
  const directory = resolve(root, "evaluator", "gold");
  return readdirSync(directory)
    .filter((item) => item.endsWith(".json"))
    .sort()
    .map((name) => resolve(directory, name));
}

export function sourceHash(source) {
  return sha256(Buffer.from(canonicalJson(source), "utf8"));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
