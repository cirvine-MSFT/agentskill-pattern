#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dossierPaths,
  goldPaths,
  jsonBytes,
  readJson,
  relativePath,
  root,
  sha256,
  sourceHash,
} from "./lib.mjs";

export function buildManifest() {
  return {
    formatVersion: 1,
    protocolId: "release-note-synthesis-v0-foundation",
    dossiers: dossierPaths().map((path) => {
      const bytes = readFileSync(path);
      const dossier = JSON.parse(bytes);
      return {
        dossierId: dossier.dossierId,
        partition: dossier.partition,
        path: relativePath(path),
        bytes: bytes.length,
        sha256: sha256(bytes),
        sources: dossier.sources.map((source) => ({
          sourceId: source.sourceId,
          publicUrl: source.publicUrl,
          selectedFieldsSha256: sourceHash(source),
        })),
      };
    }),
    evaluatorGold: goldPaths().map((path) => {
      const bytes = readFileSync(path);
      return {
        dossierId: readJson(path).dossierId,
        path: relativePath(path),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = buildManifest();
  const outputPath = resolve(root, "fixtures", "manifest.json");
  const next = jsonBytes(manifest);
  const check = process.argv.includes("--check");
  if (check) {
    const current = readFileSync(outputPath);
    if (!current.equals(next)) throw new Error("fixtures/manifest.json is stale");
    process.stdout.write(`Verified ${manifest.dossiers.length} frozen dossiers\n`);
  } else {
    writeFileSync(outputPath, next);
    process.stdout.write(`Frozen ${manifest.dossiers.length} dossiers and ${manifest.evaluatorGold.length} gold inventories\n`);
  }
}
