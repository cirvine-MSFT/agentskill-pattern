#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceManifest,
  evidenceRoot,
  invariant,
  cliArgs,
  manifestFor,
  candidateRoot,
  parseJsonl,
  readJson,
  runs,
  sessionIdFor,
  taskEnvelope,
} from "./lib.mjs";
import { assertNoRun } from "./assert-no-run.mjs";
import { summarizeEvidence } from "./evidence.mjs";
import { analyzeRun } from "./run-excluded-pilot.mjs";
import { validateFoundation } from "./validate-foundation.mjs";

export function checkEvidence() {
  if (!existsSync(evidenceRoot)) return { mode: "design-only", ...assertNoRun() };
  validateFoundation({ requireNoRun: false });
  const summary = readJson(resolve(evidenceRoot, "summary.json"));
  const index = readJson(resolve(evidenceRoot, "start-index.json"));
  const manifest = readJson(resolve(evidenceRoot, "manifest.json"));
  invariant(summary.intentToTreat === true, "summary is not ITT");
  invariant(index.noRetries === true, "start index permits retries");
  invariant(JSON.stringify(index.runOrder) === JSON.stringify(runs.map((run) => run.runId)), "run order changed");
  invariant(index.captures.length === runs.length, "start index does not contain exactly three captures");
  const evidence = runs.map((run, runIndex) => {
    const capture = index.captures[runIndex];
    invariant(capture.order === run.order && capture.runId === run.runId, `${run.runId} start capture identity/order mismatch`);
    invariant(capture.sessionId === sessionIdFor(run), `${run.runId} capture session mismatch`);
    invariant(capture.disposition === "success" || capture.disposition === "measured-failure", `${run.runId} capture is not terminal`);
    const runRoot = resolve(evidenceRoot, "runs", run.runId);
    const value = readJson(resolve(runRoot, "run-evidence.json"));
    invariant(value.runId === run.runId && value.sessionId === capture.sessionId, `${run.runId} evidence identity mismatch`);
    invariant(value.intentToTreat === true, `${run.runId} is not retained in ITT`);
    invariant(value.disposition === capture.disposition, `${run.runId} capture/evidence disposition mismatch`);
    const runConfig = readJson(resolve(runRoot, "run-config.json"));
    invariant(runConfig.sessionId === sessionIdFor(run), `${run.runId} run config session mismatch`);
    invariant(JSON.stringify(runConfig.taskEnvelope) === JSON.stringify(taskEnvelope(run)), `${run.runId} run config envelope mismatch`);
    invariant(JSON.stringify(runConfig.exactCliArgs) === JSON.stringify(cliArgs(run)), `${run.runId} run config CLI arguments mismatch`);
    invariant(runConfig.candidateFileSetSha256 === manifestFor(candidateRoot).fileSetSha256, `${run.runId} candidate source hash mismatch`);
    const stdout = readFileSync(resolve(runRoot, "copilot-events.jsonl"));
    const stderr = readFileSync(resolve(runRoot, "copilot-stderr-debug.txt"), "utf8");
    const ledgerBytes = readFileSync(resolve(runRoot, "ledger.json"));
    const ledger = JSON.parse(ledgerBytes);
    const usage = readJson(resolve(runRoot, "usage.json"));
    invariant(usage.sessionId === sessionIdFor(run) && Array.isArray(usage.rows), `${run.runId} usage identity/rows invalid`);
    const process = readJson(resolve(runRoot, "process.json"));
    invariant(process.runId === run.runId && process.sessionId === sessionIdFor(run), `${run.runId} process identity mismatch`);
    const reconstructed = analyzeRun({
      run,
      events: parseJsonl(stdout),
      stderrText: stderr,
      ledger,
      ledgerBytes,
      usageRows: usage.rows,
      startedAt: process.startedAt,
      endedAt: process.endedAt,
      processResult: { status: process.processStatus, signal: process.processSignal },
      candidateFiles: process.candidateFiles,
    });
    reconstructed.failureReasons = [...new Set([
      ...reconstructed.failureReasons,
      ...(Array.isArray(process.captureFailures) ? process.captureFailures : []),
    ])];
    if (reconstructed.failureReasons.length) {
      reconstructed.disposition = "measured-failure";
      reconstructed.operationalSuccess = false;
      reconstructed.treatmentAdherent = false;
    }
    invariant(JSON.stringify(value) === JSON.stringify(reconstructed), `${run.runId} derived evidence differs from raw reconstruction`);
    return reconstructed;
  });
  const recomputed = summarizeEvidence(evidence);
  invariant(JSON.stringify(summary) === JSON.stringify(recomputed), "summary disposition does not match recomputed frozen GO gate");
  invariant(JSON.stringify(manifest) === JSON.stringify(evidenceManifest()), "evidence manifest mismatch");
  return { mode: "post-run", disposition: summary.disposition, starts: index.captures.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(checkEvidence())}\n`);
}
