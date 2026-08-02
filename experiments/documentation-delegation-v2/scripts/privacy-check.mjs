#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {relative, resolve} from "node:path";
import {experimentRoot, walkFiles} from "./lib.mjs";

const forbidden = [
  /(?:^|[\\/])Users[\\/][^<\s"']+/iu,
  /(?:^|[\\/])home[\\/][^<\s"']+/iu,
  /\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b/u
];

export function privacyCheck() {
  const failures = [];
  for (const path of walkFiles(experimentRoot)) {
    if (path.endsWith("source-manifest.json")) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (forbidden.some((pattern) => pattern.test(text))) {
      failures.push(relative(experimentRoot, path));
    }
  }
  if (failures.length) throw new Error(`Potential private material: ${failures.join(", ")}`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  privacyCheck();
  process.stdout.write("Documentation v2 privacy boundary verified\n");
}
