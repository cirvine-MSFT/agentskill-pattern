#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import { evidenceRoot, experimentRoot, goldPath, jsonBytes, readJson, runs, transcriptPath } from "./lib.mjs";

const baselineRoot = resolve(experimentRoot, "results", "baseline");
const evaluationRoot = resolve(experimentRoot, "results", "evaluation");
mkdirSync(evaluationRoot, { recursive: true });
const baseline = [];
for (const run of runs) {
  const evaluationRun = { ...run, runId: `BASELINE-${run.transcriptId}` };
  const score = evaluateLedger({
    ledger: readJson(resolve(baselineRoot, `${run.transcriptId}.json`)),
    gold: readJson(goldPath(run)),
    transcript: readFileSync(transcriptPath(run), "utf8"),
    run: evaluationRun,
  });
  baseline.push(score);
}
writeFileSync(resolve(evaluationRoot, "baseline.json"), jsonBytes({
  formatVersion: 1,
  arm: "A0",
  runs: baseline,
  meanTupleF1: baseline.reduce((sum, score) => sum + score.tuple.f1, 0) / baseline.length,
}));

if (existsSync(resolve(evidenceRoot, "runs"))) {
  for (const run of runs) {
    const scorePath = resolve(evidenceRoot, "runs", run.runId, "score.json");
    const ledgerPath = resolve(evidenceRoot, "runs", run.runId, "ledger.json");
    if (!existsSync(scorePath) || !existsSync(ledgerPath)) continue;
    const rescored = evaluateLedger({
      ledger: readJson(ledgerPath),
      gold: readJson(goldPath(run)),
      transcript: readFileSync(transcriptPath(run), "utf8"),
      run,
    });
    const stored = readJson(scorePath);
    if (JSON.stringify(rescored) !== JSON.stringify(stored)) {
      throw new Error(`${run.runId} stored score differs from deterministic rescore`);
    }
  }
}
process.stdout.write(`Evaluated deterministic floor across ${runs.length} transcripts\n`);
