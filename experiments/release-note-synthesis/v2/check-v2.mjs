#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  canonicalTools,
  evidenceRoot,
  filesUnder,
  jsonBytes,
  protocolId,
  readJson,
  v2Root,
} from "./lib.mjs";
import { buildDiagnosis } from "./finalize-v2.mjs";
import { buildEvidenceManifest, candidateManifest } from "./run-v2.mjs";

export function checkV2() {
  const summary = readJson(resolve(evidenceRoot, "summary.json"));
  const index = readJson(resolve(evidenceRoot, "start-index.json"));
  const developmentGate = readJson(resolve(evidenceRoot, "development-gate.json"));
  const storedCandidate = readJson(resolve(evidenceRoot, "candidate-manifest.json"));
  const manifestPath = resolve(evidenceRoot, "manifest.json");
  assert(summary.protocolId === protocolId, "v2 summary protocol mismatch");
  assert(summary.confirmationRunsExecuted === 0, "confirmation runs are forbidden");
  assert(
    JSON.stringify(summary.diagnosis) === JSON.stringify(buildDiagnosis()),
    "v2 diagnosis differs from immutable raw evidence",
  );
  assert(index.captures[0]?.runId === "DEV-V2-A4-01", "development smoke marker is missing");
  assert(index.captures.filter((capture) => capture.runId === "DEV-V2-A4-01").length === 1, "development ID was reused");
  assert(
    JSON.stringify(developmentGate.canonicalTools) === JSON.stringify(canonicalTools),
    "development gate canonical tools mismatch",
  );
  assert(
    JSON.stringify(storedCandidate) === JSON.stringify(candidateManifest()),
    "current v2 candidate differs from the measured candidate manifest",
  );
  if (summary.abandonmentRuleFired) {
    assert(index.captures.length === 1, "pilot started after the abandonment rule fired");
    assert(!existsSync(resolve(evidenceRoot, "pilot-gate.json")), "pilot gate exists after smoke abandonment");
    assert(summary.semanticQualityTested === false, "semantic quality cannot be claimed after smoke abandonment");
  } else {
    const pilotGate = readJson(resolve(evidenceRoot, "pilot-gate.json"));
    assert(pilotGate.frozenBeforeAnyPilotStart === true, "pilot gate was not frozen before starts");
    assert(index.captures.length === 4, "successful smoke must be followed by exactly three pilot starts");
    assert(new Set(index.captures.map((capture) => capture.runId)).size === 4, "a v2 run ID was reused");
  }
  const v2Text = filesUnder(resolve(v2Root, "candidate"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert(!/release-notes-(?:read|write)_release_/u.test(v2Text), "normalized MCP alias found in v2");
  assert(
    readFileSync(manifestPath).equals(jsonBytes(buildEvidenceManifest())),
    "v2 evidence manifest is stale",
  );
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = checkV2();
  process.stdout.write(`Verified immutable v2 ${summary.disposition} evidence\n`);
}
