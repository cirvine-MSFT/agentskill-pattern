#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const evidenceSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-evidence.schema.json"), "utf8"));
const outputSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-model-preflight.schema.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function preflightLocalModel(evidence, evidenceBytes) {
  const evidenceErrors = validateJsonSchema(evidence, evidenceSchema, { schemaDir: schemaRoot });
  if (evidenceErrors.length > 0) {
    throw new Error(`Local evidence is invalid: ${evidenceErrors[0].path} ${evidenceErrors[0].message}`);
  }
  const attemptNumber = evidence.attempt.number;
  const beforeOutcomesOpened = evidence.attempt.outcomesOpened === false;
  const mismatchReasons = [];
  const missingReasons = [];
  for (const role of ["parent", "worker"]) {
    const expected = evidence.models.requested[role];
    const observed = evidence.models.observed[role];
    if (expected.length === 0 && observed.length > 0) {
      mismatchReasons.push(`${role} model usage exists when no model is requested`);
    } else if (expected.length > 0 && observed.length === 0) {
      missingReasons.push(`${role} model is unavailable from local usage`);
    } else if (expected.length > 0
      && (observed.length !== 1 || observed[0] !== expected[0])) {
      mismatchReasons.push(
        `${role} model mismatch: expected ${expected[0]}, observed ${observed.join(",")}`
      );
    }
  }
  let status = "pass";
  let retryEligible = false;
  const reasons = [];
  if (!beforeOutcomesOpened) {
    status = "unavailable";
    reasons.push("model preflight occurred after outcomes were opened");
  } else if (evidence.availability.session.status !== "available") {
    status = "unavailable";
    reasons.push(...evidence.availability.session.reasons);
  } else if (mismatchReasons.length > 0
    && attemptNumber === 1
    && evidence.attempt.retryCount === 0) {
    status = "retry-required";
    retryEligible = true;
    reasons.push(...mismatchReasons);
  } else if (mismatchReasons.length > 0) {
    status = "unavailable";
    reasons.push("model mismatch persisted after the single permitted retry", ...mismatchReasons);
  } else if (missingReasons.length > 0 || evidence.availability.model.status !== "available") {
    status = "unavailable";
    reasons.push(...missingReasons, ...evidence.availability.model.reasons);
  }
  const output = {
    formatVersion: 1,
    protocolId: evidence.protocolId,
    runId: evidence.runId,
    attemptNumber,
    evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    status,
    retryEligible,
    beforeOutcomesOpened,
    expected: evidence.models.requested,
    observed: evidence.models.observed,
    reasons
  };
  const errors = validateJsonSchema(output, outputSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Local model preflight is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const evidencePath = argument(args, "--evidence");
  const outputPath = argument(args, "--out");
  if (!evidencePath || !outputPath) {
    throw new Error("Usage: node scripts/preflight-local-model.mjs --evidence <local-evidence.json> --out <preflight.json>");
  }
  const bytes = readFileSync(resolve(evidencePath));
  const output = preflightLocalModel(JSON.parse(bytes), bytes);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.runId}: ${output.status}\n`);
  if (output.status !== "pass") process.exitCode = 2;
}
