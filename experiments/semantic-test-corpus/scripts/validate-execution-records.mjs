#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { preflightLocalModel } from "./preflight-local-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schemas = Object.fromEntries([
  "run-manifest",
  "run-attempt",
  "pre-session-failure",
  "deviation",
  "local-model-preflight"
].map((name) => [
  name,
  JSON.parse(readFileSync(resolve(schemaRoot, `${name}.schema.json`), "utf8"))
]));

function schemaErrors(value, name) {
  return validateJsonSchema(value, schemas[name], { schemaDir: schemaRoot })
    .map((error) => `${name}: ${error.path} ${error.message}`);
}

export function validateExecutionRecords({
  manifest,
  attempts,
  preflights,
  evidenceBytes,
  preSessionFailures,
  deviations = []
}) {
  const errors = [
    ...schemaErrors(manifest, "run-manifest"),
    ...attempts.flatMap((attempt) => schemaErrors(attempt, "run-attempt")),
    ...preflights.flatMap((preflight) => schemaErrors(preflight, "local-model-preflight")),
    ...preSessionFailures.flatMap((failure) =>
      schemaErrors(failure, "pre-session-failure")),
    ...deviations.flatMap((deviation) => schemaErrors(deviation, "deviation"))
  ];
  if (errors.length > 0) return errors;
  if (attempts.length !== 1
    || preflights.length !== 1
    || evidenceBytes.length !== 1
    || preSessionFailures.length !== manifest.preSessionFailures.length) {
    errors.push("v2 requires exactly one measured attempt/preflight and at most one pre-session failure");
    return errors;
  }

  const attempt = attempts[0];
  const preflight = preflights[0];
  if (attempt.runId !== manifest.runId
    || attempt.attemptNumber !== 1
    || attempt.attemptId !== `${manifest.runId}-attempt-1`) {
    errors.push("measured attempt identity differs from the run manifest");
  }
  if (manifest.preflights[0] !== attempt.modelPreflightPath) {
    errors.push("run manifest does not bind the exact measured attempt/preflight paths");
  }
  if (preflight.runId !== manifest.runId
    || preflight.attemptNumber !== 1
    || preflight.beforeOutcomesOpened !== true
    || preflight.retryEligible !== false) {
    errors.push("model preflight does not bind the single pre-outcome measured attempt");
  }
  try {
    const evidence = JSON.parse(evidenceBytes[0]);
    const recomputed = preflightLocalModel(evidence, evidenceBytes[0]);
    if (JSON.stringify(preflight) !== JSON.stringify(recomputed)) {
      errors.push("model preflight does not match its exact local evidence");
    }
  } catch (error) {
    errors.push(`model preflight evidence is invalid: ${error.message}`);
  }
  if (preflight.status !== "pass" && attempt.evaluatorSnapshotPath !== null) {
    errors.push("non-passing model preflight cannot have an evaluator snapshot");
  }
  if (preflight.status === "pass") {
    if (attempt.status === "excluded") {
      errors.push("passing model preflight cannot have an excluded attempt");
    }
  } else if (attempt.status !== "excluded"
    || attempt.evaluatorSnapshotPath !== null
    || attempt.outcomesOpenedAt !== null) {
    errors.push("unavailable model preflight requires exclusion with no snapshot/outcome access");
  }
  if (manifest.appProjectSessionId !== attempt.appProjectSessionId
    || manifest.cliSessionId !== attempt.cliSessionId) {
    errors.push("manifest session IDs do not identify the measured attempt");
  }
  if (manifest.attemptNumber !== 1 || manifest.outcomesOpenedAt !== attempt.outcomesOpenedAt) {
    errors.push("manifest measured-attempt/outcome state differs from the attempt");
  }
  for (const [index, failure] of preSessionFailures.entries()) {
    if (failure.runId !== manifest.runId
      || manifest.preSessionFailures[index] !== `${failure.failureId}.json`) {
      errors.push("pre-session failure is not path/identity bound to the run");
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--manifest");
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("Usage: node scripts/validate-execution-records.mjs --manifest <manifest.json>");
  }
  const manifestPath = resolve(process.argv[index + 1]);
  const artifactRoot = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const readRecords = (paths) => paths.map((path) =>
    JSON.parse(readFileSync(resolve(artifactRoot, path), "utf8")));
  const attempts = readRecords(manifest.attempts);
  const errors = validateExecutionRecords({
    manifest,
    attempts,
    preflights: readRecords(manifest.preflights),
    evidenceBytes: attempts.map((attempt) =>
      readFileSync(resolve(artifactRoot, attempt.localEvidencePath))),
    preSessionFailures: readRecords(manifest.preSessionFailures),
    deviations: readRecords(manifest.deviations)
  });
  if (errors.length > 0) throw new Error(`Execution record validation failed: ${errors[0]}`);
  process.stdout.write(
    `${manifest.runId}: 1 measured attempt, ${manifest.preSessionFailures.length} pre-session failure(s)\n`
  );
}
