#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coverage(observed, expected) {
  const exercised = [...new Set(observed)].filter((id) => expected.includes(id)).sort();
  return {
    exercised: exercised.length,
    total: expected.length,
    rate: expected.length === 0 ? 1 : exercised.length / expected.length,
    missing: expected.filter((id) => !exercised.includes(id)).sort()
  };
}

function jaccardDistance(left, right) {
  const union = new Set([...left, ...right]);
  const intersection = [...left].filter((item) => right.has(item));
  return union.size === 0 ? 0 : 1 - (intersection.length / union.size);
}

export function buildReport(corpus, matrix, mappingSpec) {
  const expectedRules = mappingSpec.rules.map((rule) => rule.id);
  const expectedPaths = [
    ...mappingSpec.rules.flatMap((rule) => rule.paths),
    ...mappingSpec.invariants.flatMap((invariant) => invariant.paths)
  ];
  const expectedInvariants = mappingSpec.invariants.map((invariant) => invariant.id);
  const allRules = corpus.cases.flatMap((scenario) => scenario.expected.trace.rules);
  const allPaths = corpus.cases.flatMap((scenario) => scenario.expected.trace.paths);
  const allInvariants = corpus.cases.flatMap((scenario) => scenario.expected.trace.invariants);
  const diagnostics = corpus.cases.flatMap((scenario) => scenario.expected.diagnostics);
  const exactHashes = corpus.cases.map((scenario) => hash(scenario.input));
  const semanticSignatures = corpus.cases.map((scenario) => hash({
    rules: scenario.expected.trace.rules,
    paths: scenario.expected.trace.paths,
    invariants: scenario.expected.trace.invariants,
    diagnostics: scenario.expected.diagnostics.map((item) => item.id)
  }));
  const signatures = corpus.cases.map((scenario) => new Set([
    ...scenario.expected.trace.paths,
    ...scenario.expected.diagnostics.map((item) => item.id)
  ]));
  const distances = [];
  for (let left = 0; left < signatures.length; left += 1) {
    for (let right = left + 1; right < signatures.length; right += 1) {
      distances.push(jaccardDistance(signatures[left], signatures[right]));
    }
  }
  const strategyCounts = {};
  for (const scenario of corpus.cases) {
    for (const tag of scenario.sourceTags) strategyCounts[tag] = (strategyCounts[tag] ?? 0) + 1;
  }
  const valid = corpus.cases.filter((scenario) => scenario.expected.status === "ok").length;
  const categories = [...new Set(diagnostics.map((item) => item.category))].sort();

  return {
    formatVersion: 1,
    corpus: {
      cases: corpus.cases.length,
      promoted: corpus.cases.length,
      promotionRate: 1,
      semanticallyValid: valid,
      semanticValidityRate: valid / corpus.cases.length,
      semanticallyInvalid: corpus.cases.length - valid,
      strategyCounts
    },
    semanticCoverage: {
      rules: coverage(allRules, expectedRules),
      paths: coverage(allPaths, expectedPaths),
      invariants: coverage(allInvariants, expectedInvariants)
    },
    diagnosticCoverage: {
      categories,
      totalDefinedCategories: mappingSpec.diagnosticCategories.length,
      rate: categories.length / mappingSpec.diagnosticCategories.length,
      counts: Object.fromEntries(categories.map((category) => [
        category,
        diagnostics.filter((item) => item.category === category).length
      ]))
    },
    mutation: matrix.totals,
    redundancyAndDiversity: {
      exactDuplicateCases: exactHashes.length - new Set(exactHashes).size,
      semanticDuplicateCases: semanticSignatures.length - new Set(semanticSignatures).size,
      semanticUniqueSignatures: new Set(semanticSignatures).size,
      meanPairwiseJaccardDistance: distances.reduce((sum, value) => sum + value, 0) / distances.length,
      note: "Duplicate detection compares corpus artifacts only; it is not a training-data leakage test."
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const corpusPath = argument(args, "--corpus");
  const matrixPath = argument(args, "--matrix");
  const outputPath = argument(args, "--out");
  if (!corpusPath || !matrixPath || !outputPath) {
    throw new Error("Usage: node scripts/report.mjs --corpus <corpus.json> --matrix <matrix.json> --out <report.json>");
  }
  const corpus = JSON.parse(readFileSync(resolve(corpusPath), "utf8"));
  const matrix = JSON.parse(readFileSync(resolve(matrixPath), "utf8"));
  const mappingSpec = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixture", "spec", "mapping-spec.json"), "utf8"));
  const report = buildReport(corpus, matrix, mappingSpec);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
