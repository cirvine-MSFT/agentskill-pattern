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
const stagingBytes = Buffer.from(`${JSON.stringify(generateBaseline(), null, 2)}\n`);
const checkedStaging = readFileSync(resolve(root, "staging", "baseline.json"));
assert.deepEqual(stagingBytes, checkedStaging, "staging/baseline.json is not reproducible");

const staging = JSON.parse(stagingBytes);
const corpus = promoteStaging(staging, stagingBytes, "2026-07-29T00:00:00.000Z");
const checkedCorpus = JSON.parse(readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-corpus.json"), "utf8"));
assert.deepEqual(corpus, checkedCorpus, "artifacts/baseline-corpus.json is not reproducible");

const matrix = buildKillMatrix(corpus);
const checkedMatrix = JSON.parse(readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-kill-matrix.json"), "utf8"));
assert.deepEqual(matrix, checkedMatrix, "artifacts/baseline-kill-matrix.json is not reproducible");

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
const checkedReport = JSON.parse(readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-report.json"), "utf8"));
assert.deepEqual(report, checkedReport, "artifacts/baseline-report.json is not reproducible");

process.stdout.write("Reproduced staging, oracle promotion, kill matrix, and baseline report byte-for-byte.\n");
