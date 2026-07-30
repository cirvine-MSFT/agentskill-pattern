#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBaseline } from "../baseline/generate.mjs";
import { buildKillMatrix } from "../mutants/run.mjs";
import { buildReport } from "./report.mjs";
import { promoteStaging } from "./promote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingBytes = Buffer.from(`${JSON.stringify(generateBaseline(), null, 2)}\n`);
const checkedStaging = readFileSync(resolve(root, "staging", "baseline.json"));
assert.deepEqual(stagingBytes, checkedStaging, "staging/baseline.json is not reproducible");

const staging = JSON.parse(stagingBytes);
const corpus = promoteStaging(staging, stagingBytes, "2026-07-29T00:00:00.000Z");
const checkedCorpus = JSON.parse(readFileSync(resolve(root, "artifacts", "baseline-corpus.json"), "utf8"));
assert.deepEqual(corpus, checkedCorpus, "artifacts/baseline-corpus.json is not reproducible");

const matrix = buildKillMatrix(corpus);
const checkedMatrix = JSON.parse(readFileSync(resolve(root, "artifacts", "baseline-kill-matrix.json"), "utf8"));
assert.deepEqual(matrix, checkedMatrix, "artifacts/baseline-kill-matrix.json is not reproducible");

const mappingSpec = JSON.parse(readFileSync(resolve(root, "fixture", "spec", "mapping-spec.json"), "utf8"));
const report = buildReport(corpus, matrix, mappingSpec);
const checkedReport = JSON.parse(readFileSync(resolve(root, "artifacts", "baseline-report.json"), "utf8"));
assert.deepEqual(report, checkedReport, "artifacts/baseline-report.json is not reproducible");

process.stdout.write("Reproduced staging, oracle promotion, kill matrix, and baseline report byte-for-byte.\n");
