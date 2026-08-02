#!/usr/bin/env node
import {readdirSync} from "node:fs";
import {resolve} from "node:path";
import {experimentRoot, exists, readJson} from "./lib.mjs";

export function verifyNoRun() {
  const attestation = readJson(resolve(experimentRoot, "design", "no-run-attestation.json"));
  if (attestation.aiObservationsStarted !== 0
    || attestation.pilotObservationsStarted !== 0
    || attestation.mainObservationsStarted !== 0
    || attestation.resultEvidenceCreated !== false) {
    throw new Error("No-run attestation does not declare a zero-observation design");
  }
  for (const name of attestation.forbiddenPathsAbsent) {
    if (exists(resolve(experimentRoot, name))) throw new Error(`Forbidden run path exists: ${name}`);
  }
  const suspicious = readdirSync(experimentRoot, {recursive: true})
    .map(String)
    .filter((name) => /(?:raw-telemetry|run-manifest|observation-result|usage-export)\.json$/iu.test(name));
  if (suspicious.length) throw new Error(`Result-like evidence found: ${suspicious.join(", ")}`);
  const schedule = readJson(resolve(experimentRoot, "design", "schedule.json"));
  if (schedule.main.length !== 24 || schedule.pilot.length !== 2) {
    throw new Error("Frozen schedule count mismatch");
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  verifyNoRun();
  process.stdout.write("No-run boundary verified: zero AI observations and no result evidence\n");
}
