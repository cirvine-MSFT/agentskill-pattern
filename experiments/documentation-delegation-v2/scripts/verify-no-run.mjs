#!/usr/bin/env node
import {readdirSync} from "node:fs";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {dryRun, consumedStudyIds} from "./pilot-runner.mjs";
import {frozenPilotPlan, normalizedPathHash} from "./pilot-contract.mjs";
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
  if (attestation.authorizationPrepared !== true
    || attestation.pilotAuthorizedAfterMerge !== true
    || attestation.mainAuthorized !== false) {
    throw new Error("no-run attestation does not describe the prospective boundary");
  }
  if (boundary.pilotAuthorized !== true
    || boundary.mainAuthorized !== false
    || boundary.executeEntryPoint !== "npm run runner:execute --") {
    throw new Error("execution boundary differs from excluded-pilot-only authorization");
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
  const authorization = readJson(resolve(experimentRoot, "design", "authorization.json"));
  const artifactRoot = resolve(
    homedir(),
    ".copilot",
    "pilot-evidence",
    `documentation-delegation-v2-sonnet-${authorization.authorizationNonce}`
  );
  const candidateRoot = resolve(
    homedir(),
    ".copilot",
    "pilot-candidates",
    `documentation-delegation-v2-sonnet-${authorization.authorizationNonce}`
  );
  if (normalizedPathHash(artifactRoot) !== authorization.paths.artifactRootSha256
    || normalizedPathHash(candidateRoot) !== authorization.paths.candidateRootSha256) {
    throw new Error("authorized external root identities do not match the nonce");
  }
  if (exists(artifactRoot) || exists(candidateRoot)) {
    throw new Error("an authorized result root already exists");
  }
  const store = resolve(homedir(), ".copilot", "session-store.db");
  if (normalizedPathHash(store) !== authorization.paths.sessionStoreSha256) {
    throw new Error("authorized session-store identity differs");
  }
  const ids = frozenPilotPlan().flatMap((run) =>
    [run.parentSessionId, run.workerSessionId].filter(Boolean));
  const consumed = consumedStudyIds(store, ids);
  if (consumed.length) throw new Error(`frozen IDs were consumed: ${consumed.join(", ")}`);
  const preview = dryRun();
  if (preview.observationsStarted !== 0 || preview.canExecuteMain !== false) {
    throw new Error("dry-run preview violates the zero-observation boundary");
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  verifyNoRun();
  process.stdout.write("No-run boundary verified: zero v2 AI observations\n");
}
