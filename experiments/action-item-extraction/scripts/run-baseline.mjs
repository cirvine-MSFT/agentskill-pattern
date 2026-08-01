#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimentRoot, jsonBytes, runs, transcriptPath } from "./lib.mjs";

const owners = {
  Maya: "Maya Chen", Omar: "Omar Haddad", Priya: "Priya Raman", Leo: "Leo Martins",
  Nina: "Nina Brooks", Eli: "Eli Stone", Aisha: "Aisha Khan", Ben: "Ben Ortiz",
  Clara: "Clara Wu", Devon: "Devon Price", Rosa: "Rosa Silva", Theo: "Theo Grant",
  Grace: "Grace Kim", Hugo: "Hugo Mensah", Inez: "Inez Park", Jonah: "Jonah Reed",
  Kira: "Kira Patel", Malik: "Malik Thompson", Farah: "Farah Ali", Gavin: "Gavin Cole",
  Hana: "Hana Sato", Isaac: "Isaac Bell", Jules: "Jules Martin", Keon: "Keon Davis",
};

function extract(run) {
  const lines = readFileSync(transcriptPath(run), "utf8").split(/\r?\n/u);
  const items = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\[\d+\]\s+([A-Za-z]+):\s+(.+)$/u);
    if (!match || !owners[match[1]] || !/\bI will\b/iu.test(match[2])) continue;
    const sentence = match[2].match(/\bI will\s+(.+?)(?:\.|$)/iu)?.[1] ?? match[2];
    const date = sentence.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1] ?? null;
    const action = sentence
      .replace(/\s+by\s+20\d{2}-\d{2}-\d{2}.*$/iu, "")
      .replace(/\s+on\s+20\d{2}-\d{2}-\d{2}.*$/iu, "")
      .trim();
    const conditional = /\b(?:if|after|conditional|only if)\b/iu.test(match[2]);
    items.push({
      itemId: `AI-${String(items.length + 1).padStart(3, "0")}`,
      owner: owners[match[1]],
      action,
      dueDate: date,
      status: conditional ? "conditional" : "open",
      condition: conditional ? match[2] : null,
      sourceSpans: [{ startLine: index + 1, endLine: index + 1, quote: match[2] }],
      criticality: /\b(?:launch-blocking|release-blocking|security|legal|compliance|customer-impact)\b/iu.test(match[2])
        ? "critical"
        : "normal",
    });
  }
  return {
    schemaVersion: "action-ledger.v1",
    runId: `BASELINE-${run.transcriptId}`,
    transcriptId: run.transcriptId,
    items,
    ambiguities: [],
  };
}

const outputRoot = resolve(experimentRoot, "results", "baseline");
mkdirSync(outputRoot, { recursive: true });
for (const run of runs) {
  writeFileSync(resolve(outputRoot, `${run.transcriptId}.json`), jsonBytes(extract(run)));
}
process.stdout.write(`Wrote deterministic floor for ${runs.length} excluded transcripts\n`);
