#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fixtureSources } from "../design/fixture-sources.mjs";
import { goldPath, invariant, jsonBytes, runs, transcriptPath } from "./lib.mjs";

function writeOnce(path, bytes) {
  invariant(!existsSync(path), `${path} already exists; fixture generation is write-once`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

for (const [index, run] of runs.entries()) {
  const source = fixtureSources[index];
  writeOnce(transcriptPath(run), Buffer.from(source.transcript, "utf8"));
  writeOnce(goldPath(run), jsonBytes(source.gold));
}

process.stdout.write(`Generated ${runs.length} fresh v3 excluded-pilot transcripts and evaluator-only gold inventories\n`);
