#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import { evidenceRoot, experimentRoot, goldPath, jsonBytes, readJson, runs, transcriptPath } from "./lib.mjs";

const output = resolve(experimentRoot, "results", "evaluation-v2");
mkdirSync(output, { recursive: true });
const scores = runs.map((run) => {
  const baselineRun = { ...run, runId: `BASELINE-V2-${run.transcriptId}` };
  return evaluateLedger({
    run: baselineRun,
    ledger: readJson(resolve(experimentRoot, "results", "baseline-v2", `${run.transcriptId}.json`)),
    gold: readJson(goldPath(run)),
    transcript: readFileSync(transcriptPath(run), "utf8"),
  });
});
writeFileSync(resolve(output, "baseline.json"), jsonBytes({
  formatVersion: 2,
  protocolId: "action-item-extraction-v2",
  arm: "A0",
  scores,
  meanTupleF1: scores.reduce((sum, score) => sum + score.tuple.f1, 0) / scores.length,
}));
if (existsSync(resolve(evidenceRoot, "runs"))) {
  for (const run of runs) {
    const runRoot = resolve(evidenceRoot, "runs", run.runId);
    if (!existsSync(resolve(runRoot, "ledger.json"))) continue;
    const rescored = evaluateLedger({
      run,
      ledger: readJson(resolve(runRoot, "ledger.json")),
      gold: readJson(goldPath(run)),
      transcript: readFileSync(transcriptPath(run), "utf8"),
    });
    if (JSON.stringify(rescored) !== JSON.stringify(readJson(resolve(runRoot, "score.json")))) {
      throw new Error(`${run.runId} stored score differs from deterministic rescore`);
    }
  }
}
process.stdout.write(`Evaluated deterministic v2 baseline across ${scores.length} fixtures\n`);
