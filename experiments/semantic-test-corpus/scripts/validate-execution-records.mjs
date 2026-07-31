#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { preflightLocalModel } from "./preflight-local-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schemas = Object.fromEntries([
  "run-manifest", "run-attempt", "retry", "deviation", "local-model-preflight"
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
  retries,
  deviations = []
}) {
  const errors = [
    ...schemaErrors(manifest, "run-manifest"),
    ...attempts.flatMap((attempt) => schemaErrors(attempt, "run-attempt")),
    ...preflights.flatMap((preflight) => schemaErrors(preflight, "local-model-preflight")),
    ...retries.flatMap((retry) => schemaErrors(retry, "retry")),
    ...deviations.flatMap((deviation) => schemaErrors(deviation, "deviation"))
  ];
  if (errors.length > 0) return errors;
  if (attempts.length !== manifest.attempts.length
    || attempts.length !== manifest.attemptNumber
    || preflights.length !== manifest.preflights.length
    || preflights.length !== attempts.length
    || evidenceBytes.length !== attempts.length
    || retries.length !== manifest.retries.length) {
    errors.push("manifest paths/counts do not match supplied attempts, preflights, and retries");
  }
  const sorted = [...attempts].sort((left, right) => left.attemptNumber - right.attemptNumber);
  const expectedParent = sorted[0]?.requestedParentModel;
  const expectedWorker = sorted[0]?.requestedWorkerModel;
  const expectedTreatment = JSON.stringify(sorted[0]?.treatment);
  for (const [index, attempt] of sorted.entries()) {
    const number = index + 1;
    if (attempt.runId !== manifest.runId
      || attempt.attemptNumber !== number
      || attempt.attemptId !== `${manifest.runId}-attempt-${number}`) {
      errors.push(`attempt ${number} identity or sequence differs from the manifest`);
    }
    if (attempt.requestedParentModel !== expectedParent
      || attempt.requestedWorkerModel !== expectedWorker
      || JSON.stringify(attempt.treatment) !== expectedTreatment) {
      errors.push("retry treatment differs from the first attempt");
    }
    if (attempt.outcomesOpenedAt !== null && number < sorted.length) {
      errors.push("outcomes were opened before a later attempt");
    }
  }
  if (new Set(attempts.map((attempt) => attempt.appProjectSessionId)).size !== attempts.length
    || new Set(attempts.map((attempt) => attempt.cliSessionId)).size !== attempts.length) {
    errors.push("attempt retries must use fresh app and CLI sessions");
  }
  if (attempts.length === 1 && retries.length !== 0) {
    errors.push("one-attempt run cannot contain a retry");
  }
  if (attempts.length === 2) {
    if (retries.length !== 1) {
      errors.push("two-attempt run requires exactly one retry");
    } else if (retries[0].runId !== manifest.runId
      || retries[0].fromAttemptId !== sorted[0].attemptId
      || retries[0].toAttemptId !== sorted[1].attemptId
      || retries[0].reason !== "observed-model-mismatch"
      || retries[0].outcomesOpened !== false
      || retries[0].sameTreatment !== true) {
      errors.push("retry does not link the exact first and second attempts");
    }
    if (preflights[0]?.runId !== manifest.runId
      || preflights[0]?.attemptNumber !== 1
      || preflights[0]?.status !== "retry-required"
      || preflights[0]?.retryEligible !== true
      || !preflights[0]?.reasons?.some((reason) => reason.includes("model mismatch"))) {
      errors.push("first-attempt preflight does not authorize a model-mismatch retry");
    }
  }
  for (const [index, preflight] of preflights.entries()) {
    if (preflight.runId !== manifest.runId
      || preflight.attemptNumber !== index + 1
      || preflight.beforeOutcomesOpened !== true) {
      errors.push(`preflight ${index + 1} does not bind the matching pre-outcome attempt`);
    }
    try {
      const evidence = JSON.parse(evidenceBytes[index]);
      const recomputed = preflightLocalModel(evidence, evidenceBytes[index]);
      if (JSON.stringify(preflight) !== JSON.stringify(recomputed)) {
        errors.push(`preflight ${index + 1} does not match its exact local evidence`);
      }
    } catch (error) {
      errors.push(`preflight ${index + 1} evidence is invalid: ${error.message}`);
    }
    if (manifest.preflights[index] !== attempts[index]?.modelPreflightPath) {
      errors.push(`manifest preflight ${index + 1} path differs from the attempt`);
    }
  }
  if (manifest.appProjectSessionId !== sorted.at(-1)?.appProjectSessionId
    || manifest.cliSessionId !== sorted.at(-1)?.cliSessionId) {
    errors.push("manifest session IDs do not identify the latest attempt");
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
    retries: readRecords(manifest.retries),
    deviations: readRecords(manifest.deviations)
  });
  if (errors.length > 0) throw new Error(`Execution record validation failed: ${errors[0]}`);
  process.stdout.write(`${manifest.runId}: ${manifest.attempts.length} attempt(s), ${manifest.retries.length} retry\n`);
}
