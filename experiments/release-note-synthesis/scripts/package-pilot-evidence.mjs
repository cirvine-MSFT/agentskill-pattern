#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonBytes, relativePath, root, sha256 } from "./lib.mjs";

const evidenceRoot = resolve(root, "results", "excluded-pilot");
const manifestPath = resolve(evidenceRoot, "manifest.json");

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = resolve(directory, entry.name);
      if (target === manifestPath) return [];
      return entry.isDirectory() ? filesUnder(target) : [target];
    });
}

export function buildPilotManifest() {
  const files = filesUnder(evidenceRoot).map((path) => {
    const bytes = readFileSync(path);
    return { path: relativePath(path), bytes: bytes.length, sha256: sha256(bytes) };
  });
  const aggregate = files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join("");
  return {
    formatVersion: 1,
    protocolId: "release-note-synthesis-v0-foundation",
    phase: "excluded-pilot",
    permanentlyExcludedFromConfirmation: true,
    fileSetSha256: sha256(Buffer.from(aggregate, "utf8")),
    files,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = jsonBytes(buildPilotManifest());
  if (process.argv.includes("--check")) {
    if (!readFileSync(manifestPath).equals(next)) throw new Error("excluded-pilot evidence manifest is stale");
    process.stdout.write("Verified excluded-pilot evidence package\n");
  } else {
    writeFileSync(manifestPath, next);
    process.stdout.write("Packaged excluded-pilot evidence with SHA-256 file bindings\n");
  }
}
