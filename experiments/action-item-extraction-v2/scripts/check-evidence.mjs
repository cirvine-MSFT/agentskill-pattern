#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evidenceManifest, evidenceRoot, invariant, protocolId, readJson, runs, sha256 } from "./lib.mjs";

export function checkEvidence() {
  if (!existsSync(evidenceRoot)) return { disposition: "NOT-RUN" };
  const stored = readJson(resolve(evidenceRoot, "manifest.json"));
  invariant(JSON.stringify(stored) === JSON.stringify(evidenceManifest()), "evidence manifest is stale");
  for (const file of stored.files) {
    const bytes = readFileSync(resolve(evidenceRoot, file.path));
    invariant(bytes.length === file.bytes && sha256(bytes) === file.sha256, `evidence hash mismatch: ${file.path}`);
  }
  const summary = readJson(resolve(evidenceRoot, "summary.json"));
  if (summary.harnessFailure) return summary;
  const start = readJson(resolve(evidenceRoot, "start-index.json"));
  invariant(start.protocolId === protocolId, "start index protocol mismatch");
  invariant(start.captures.length === new Set(start.captures.map((capture) => capture.runId)).size, "a run ID was reused");
  invariant(summary.confirmatoryRunsExecuted === 0 && summary.mainRunsExecuted === 0 && summary.a0ToA3AiRunsExecuted === 0, "forbidden runs reported");
  invariant(start.captures[0]?.runId === runs[0].runId, "development unit was not first");
  if (!summary.development.passed) {
    invariant(summary.disposition === "NO-GO" && start.captures.length === 1, "development failure did not stop pilots");
    invariant(!existsSync(resolve(evidenceRoot, "pilot-gate.json")), "pilot gate exists after development failure");
  } else {
    const gate = readJson(resolve(evidenceRoot, "pilot-gate.json"));
    invariant(gate.frozenAfterPassingDevelopmentBeforePilotStart && start.captures.length === 4, "pilot gate/start count invalid");
    invariant(JSON.stringify(start.captures.slice(1).map((capture) => capture.runId)) === JSON.stringify(gate.runOrder), "pilot order changed");
  }
  return summary;
}

if (process.argv[1]?.endsWith("check-evidence.mjs")) {
  process.stdout.write(`Verified v2 evidence: ${checkEvidence().disposition}\n`);
}
