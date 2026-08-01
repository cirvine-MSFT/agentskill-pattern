#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fixtureSources } from "../design/fixture-sources.mjs";
import { experimentRoot, jsonBytes } from "./lib.mjs";

for (const fixture of fixtureSources) {
  const transcript = resolve(experimentRoot, "fixtures", fixture.partition, `${fixture.transcriptId}.txt`);
  const gold = resolve(experimentRoot, "evaluator", "gold", `${fixture.transcriptId}.json`);
  for (const [path, bytes] of [[transcript, Buffer.from(fixture.transcript)], [gold, jsonBytes(fixture.gold)]]) {
    if (existsSync(path)) throw new Error(`${path} already exists; concrete fixtures are write-once`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  }
}
process.stdout.write(`Generated ${fixtureSources.length} fresh transcript/gold pairs once\n`);
