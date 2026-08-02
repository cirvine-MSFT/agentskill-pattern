#!/usr/bin/env node
import {readdirSync} from "node:fs";
import {resolve} from "node:path";
import {experimentRoot, exists, readJson} from "./lib.mjs";

export function verifyNoRun() {
  const attestation = readJson(resolve(experimentRoot, "design", "no-run-attestation.json"));
  const boundary = readJson(resolve(experimentRoot, "design", "execution-boundary.json"));
  if (attestation.aiObservationsStarted !== 0
    || attestation.pilotObservationsStarted !== 0
    || attestation.mainObservationsStarted !== 0
    || attestation.resultEvidenceCreated !== false
    || attestation.v1IdentifiersReused !== false) {
    throw new Error("no-run attestation is not a zero-observation v2 design");
  }
  if (boundary.pilotAuthorized !== false
    || boundary.mainAuthorized !== false
    || boundary.executeEntryPoint !== null) {
    throw new Error("execution boundary is open");
  }
  for (const name of attestation.forbiddenPathsAbsent) {
    if (exists(resolve(experimentRoot, name))) throw new Error(`forbidden run path exists: ${name}`);
  }
  const suspicious = readdirSync(experimentRoot, {recursive: true}).map(String)
    .filter((name) =>
      /(?:observation-result|usage-export|raw-telemetry|pilot-summary)\.json$/iu.test(name));
  if (suspicious.length) throw new Error(`result-like evidence exists: ${suspicious.join(", ")}`);
  const schedule = readJson(resolve(experimentRoot, "design", "schedule.json"));
  if (schedule.main.length !== 24 || schedule.pilot.length !== 6) {
    throw new Error("schedule count differs from the no-run contract");
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  verifyNoRun();
  process.stdout.write("No-run boundary verified: zero v2 AI observations\n");
}
