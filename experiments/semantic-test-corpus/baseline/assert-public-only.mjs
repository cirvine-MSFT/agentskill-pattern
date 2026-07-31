#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const baselineRoot = dirname(fileURLToPath(import.meta.url));
const experimentRoot = resolve(baselineRoot, "..");
const allowedRoots = [
  baselineRoot,
  resolve(experimentRoot, "fixture", "spec"),
  resolve(experimentRoot, "schemas")
];
const forbidden = /(?:evaluator|held-out|acceptance|mutant|oracle|golden)/iu;

function within(parent, child) {
  const relative = child.slice(parent.length);
  return child === parent || relative.startsWith("\\") || relative.startsWith("/");
}

export function assertPublicOnlyBaseline(entry = resolve(baselineRoot, "generate.mjs")) {
  const visited = new Set();
  const visit = (file) => {
    const path = resolve(file);
    if (visited.has(path)) return;
    if (!allowedRoots.some((root) => within(root, path))) {
      throw new Error(`Baseline import escapes the public allowlist: ${path}`);
    }
    const text = readFileSync(path, "utf8");
    if (forbidden.test(text)) {
      throw new Error(`Baseline source contains evaluator-only vocabulary: ${path}`);
    }
    visited.add(path);
    for (const match of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        throw new Error(`Baseline imports a non-builtin package: ${specifier}`);
      }
      let target = resolve(dirname(path), specifier);
      if (!extname(target) && existsSync(`${target}.mjs`)) target = `${target}.mjs`;
      visit(target);
    }
  };
  visit(entry);
  return [...visited].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = assertPublicOnlyBaseline();
  process.stdout.write(`Public-only baseline import graph verified: ${files.length} files\n`);
}
