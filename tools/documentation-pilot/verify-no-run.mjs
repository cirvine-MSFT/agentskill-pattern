#!/usr/bin/env node
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {RUNNER_PROTOCOL_ID, SOURCE_COMMIT} from "./core.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const attestation = JSON.parse(readFileSync(resolve(root, "no-run-attestation.json"), "utf8"));
if (attestation.runnerProtocolId !== RUNNER_PROTOCOL_ID
  || attestation.sourceCommit !== SOURCE_COMMIT
  || attestation.aiObservationsStarted !== 0
  || attestation.pilotIdsConsumed !== 0
  || attestation.parentSessionsCreated !== 0
  || attestation.workerSessionsCreated !== 0
  || attestation.resultRootsCreated !== false) {
  throw new Error("Runner no-run attestation is invalid");
}
for (const path of ["evidence", "results", "runtime", "candidates", "runs"]) {
  if (existsSync(resolve(root, path))) throw new Error(`Forbidden runner result path exists: ${path}`);
}
if (existsSync(resolve(root, "authorizations"))) {
  throw new Error("This no-run engineering PR must not contain an execution authorization");
}
const suspicious = readdirSync(root, {recursive: true})
  .map(String)
  .filter((name) => /(?:events|usage|pilot-summary|observation)\.jsonl?$/iu.test(name));
if (suspicious.length > 0) throw new Error(`Result-like evidence found: ${suspicious.join(", ")}`);
process.stdout.write("Runner no-run boundary verified: zero observations and zero frozen IDs consumed\n");
