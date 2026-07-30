#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBaseline } from "../baseline/generate.mjs";
import { buildKillMatrix } from "./mutants/run.mjs";
import { validateMutantCatalog } from "./mutants/validate.mjs";
import { referenceOracle } from "./oracle/index.mjs";
import { buildReport } from "./report.mjs";
import { promoteStaging } from "./promote.mjs";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(evaluatorRoot, "..");

export function canonicalArtifactBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function assertExactArtifact(value, checkedBytes, label) {
  assert.deepEqual(canonicalArtifactBytes(value), checkedBytes, `${label} is not byte-for-byte reproducible`);
}

export function reproduce() {
  const staging = generateBaseline();
  const stagingBytes = canonicalArtifactBytes(staging);
  assert.deepEqual(
    stagingBytes,
    readFileSync(resolve(root, "staging", "baseline.json")),
    "staging/baseline.json is not byte-for-byte reproducible"
  );

  const corpus = promoteStaging(staging, stagingBytes, "2026-07-29T00:00:00.000Z");
  assertExactArtifact(
    corpus,
    readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-corpus.json")),
    "artifacts/baseline-corpus.json"
  );

  const matrix = buildKillMatrix(corpus);
  assertExactArtifact(
    matrix,
    readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-kill-matrix.json")),
    "artifacts/baseline-kill-matrix.json"
  );

  const mappingSpec = JSON.parse(readFileSync(resolve(root, "fixture", "spec", "mapping-spec.json"), "utf8"));
  const goldens = JSON.parse(readFileSync(resolve(evaluatorRoot, "tests", "golden-cases.json"), "utf8"));
  const validationCases = [
    ...corpus.cases,
    ...goldens.cases.map((scenario) => ({
      id: scenario.id,
      input: scenario.input,
      expected: referenceOracle(scenario.input)
    }))
  ];
  validateMutantCatalog(validationCases, new Set([
    ...mappingSpec.rules.map((rule) => rule.id),
    ...mappingSpec.invariants.map((invariant) => invariant.id)
  ]));
  const report = buildReport(corpus, matrix, mappingSpec);
  assertExactArtifact(
    report,
    readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-report.json")),
    "artifacts/baseline-report.json"
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reproduce();
  process.stdout.write("Reproduced staging, oracle promotion, kill matrix, and baseline report byte-for-byte.\n");
}
