#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assert,
  evidenceFileManifest,
  evidenceRoot,
  protocolId,
  readJson,
  runs,
  sha256,
} from "./lib.mjs";

export function checkEvidence() {
  if (!existsSync(evidenceRoot)) return { disposition: "not-run" };
  const manifestPath = resolve(evidenceRoot, "manifest.json");
  assert(existsSync(manifestPath), "evidence manifest is missing");
  const storedManifest = readJson(manifestPath);
  const currentManifest = evidenceFileManifest(evidenceRoot);
  assert(JSON.stringify(storedManifest) === JSON.stringify(currentManifest), "evidence manifest is stale");
  for (const file of storedManifest.files) {
    const bytes = readFileSync(resolve(evidenceRoot, file.path));
    assert(bytes.length === file.bytes && sha256(bytes) === file.sha256, `evidence hash mismatch: ${file.path}`);
  }
  const index = readJson(resolve(evidenceRoot, "start-index.json"));
  assert(index.protocolId === protocolId, "start index protocol mismatch");
  assert(index.captures.length === new Set(index.captures.map((entry) => entry.runId)).size, "run ID was reused");
  const summaryPath = resolve(evidenceRoot, "summary.json");
  if (!existsSync(summaryPath)) {
    const failure = readJson(resolve(evidenceRoot, "harness-failure.json"));
    assert(failure.disposition === "NO-GO", "unfinished evidence lacks NO-GO harness failure");
    return failure;
  }
  const summary = readJson(summaryPath);
  assert(summary.protocolId === protocolId, "summary protocol mismatch");
  assert(summary.confirmationRunsExecuted === 0 && summary.mainRunsExecuted === 0, "forbidden execution reported");
  assert(index.captures[0]?.runId === runs[0].runId, "smoke was not first");
  assert(index.captures.filter((entry) => entry.runId === runs[0].runId).length === 1, "smoke ID was reused");
  if (!summary.smoke.passed) {
    assert(summary.disposition === "NO-GO", "failed smoke did not force NO-GO");
    assert(summary.smoke.abandonmentRuleFired === true, "failed smoke did not fire abandonment");
    assert(index.captures.length === 1, "pilot started after failed smoke");
    assert(!existsSync(resolve(evidenceRoot, "pilot-gate.json")), "pilot gate exists after failed smoke");
  } else {
    const pilotGate = readJson(resolve(evidenceRoot, "pilot-gate.json"));
    assert(pilotGate.frozenAfterPassingSmokeAndBeforeAnyPilotStart === true, "pilot gate timing is not frozen");
    assert(index.captures.length === 4, "passing smoke did not produce exactly three pilot starts");
    assert(JSON.stringify(index.captures.slice(1).map((entry) => entry.runId))
      === JSON.stringify(pilotGate.runOrder), "pilot start order mismatch");
  }
  return summary;
}

if (process.argv[1]?.endsWith("check-evidence.mjs")) {
  const result = checkEvidence();
  process.stdout.write(`Verified action-item evidence: ${result.disposition}\n`);
}
