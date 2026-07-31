#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLocalEvidence } from "./collect-local-evidence.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "local-evidence.schema.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateLocalEvidence(evidence, { artifactRoot } = {}) {
  const errors = validateJsonSchema(evidence, schema, { schemaDir: schemaRoot })
    .map((error) => `${error.path} ${error.message}`);
  if (evidence?.trust?.signed !== false || evidence?.trust?.complianceProof !== false) {
    errors.push("local evidence must explicitly remain unsigned and not a compliance proof");
  }
  for (const role of ["parent", "worker", "total"]) {
    const usage = evidence?.usage?.[role];
    if (usage?.nanoAiu !== null && usage?.aiCredits !== usage.nanoAiu / 1e9) {
      errors.push(`${role} aiCredits must equal nanoAiu / 1e9`);
    }
  }
  if (artifactRoot) {
    for (const [label, source] of Object.entries(evidence.source ?? {})) {
      if (source === null) continue;
      const path = resolve(artifactRoot, source.path);
      if (!existsSync(path)) {
        errors.push(`${label} source file is missing`);
        continue;
      }
      const bytes = readFileSync(path);
      if (bytes.length !== source.bytes) errors.push(`${label} source byte count differs`);
      if (sha256(bytes) !== source.sha256) errors.push(`${label} source SHA-256 differs`);
    }
    if (errors.length === 0) {
      const readSource = (name) => readFileSync(resolve(artifactRoot, evidence.source[name].path));
      const retryBytes = evidence.source.retry
        ? readFileSync(resolve(artifactRoot, evidence.source.retry.path))
        : null;
      const manifestBytes = readSource("runManifest");
      const attemptBytes = readSource("runAttempt");
      const recomputed = collectLocalEvidence({
        eventsBytes: readSource("events"),
        eventsPath: evidence.source.events.path,
        usageBytes: readSource("usage"),
        usagePath: evidence.source.usage.path,
        candidateBoundaryBytes: readSource("candidateBoundary"),
        candidateBoundaryPath: evidence.source.candidateBoundary.path,
        runManifest: JSON.parse(manifestBytes),
        runManifestBytes: manifestBytes,
        runManifestPath: evidence.source.runManifest.path,
        runAttempt: JSON.parse(attemptBytes),
        runAttemptBytes: attemptBytes,
        runAttemptPath: evidence.source.runAttempt.path,
        ...(retryBytes ? {
          retryRecord: JSON.parse(retryBytes),
          retryBytes,
          retryPath: evidence.source.retry.path
        } : {})
      });
      if (JSON.stringify(recomputed) !== JSON.stringify(evidence)) {
        errors.push("local evidence does not exactly match deterministic recollection from bound sources");
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--in");
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("Usage: node scripts/validate-local-evidence.mjs --in <local-evidence.json>");
  }
  const inputPath = resolve(process.argv[index + 1]);
  const evidence = JSON.parse(readFileSync(inputPath, "utf8"));
  const errors = validateLocalEvidence(evidence, { artifactRoot: dirname(inputPath) });
  if (errors.length > 0) throw new Error(`Local evidence validation failed: ${errors[0]}`);
  process.stdout.write(`${evidence.runId}: valid descriptive local evidence; signed=false complianceProof=false\n`);
}
