#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimentRoot, jsonBytes, runs, transcriptPath } from "./lib.mjs";

function baseline(run) {
  const items = [];
  for (const [index, line] of readFileSync(transcriptPath(run), "utf8").split(/\r?\n/u).entries()) {
    const match = line.match(/^\[\d+\]\s+([^:]+):\s+I will\s+(.+?)(?:\.|$)/u);
    if (!match || /\b(?:will not|withdraw)\b/iu.test(line)) continue;
    const dueDate = match[2].match(/\b20\d{2}-\d{2}-\d{2}\b/u)?.[0] ?? null;
    const action = match[2].replace(/\s+by\s+20\d{2}-\d{2}-\d{2}.*$/u, "").trim();
    const conditional = /\b(?:only if|conditional)\b/iu.test(line);
    const blocked = /\bblocked until\b/iu.test(line);
    items.push({
      itemId: `AI-${String(items.length + 1).padStart(3, "0")}`,
      owner: match[1],
      action,
      dueDate,
      status: blocked ? "blocked" : conditional ? "conditional" : "open",
      condition: blocked || conditional ? match[2] : null,
      sourceSpans: [{ startLine: index + 1, endLine: index + 1, quote: line.slice(line.indexOf(": ") + 2) }],
      criticality: /\b(?:launch-blocking|customer-blocking|security exception)\b/iu.test(line) ? "critical" : "normal",
    });
  }
  return {
    schemaVersion: "action-ledger.v2",
    runId: `BASELINE-V2-${run.transcriptId}`,
    transcriptId: run.transcriptId,
    items,
    ambiguities: [],
  };
}

const output = resolve(experimentRoot, "results", "baseline-v2");
mkdirSync(output, { recursive: true });
for (const run of runs) writeFileSync(resolve(output, `${run.transcriptId}.json`), jsonBytes(baseline(run)));
process.stdout.write(`Wrote deterministic v2 baseline for ${runs.length} excluded fixtures\n`);
