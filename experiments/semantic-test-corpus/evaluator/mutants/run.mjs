#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeMutant, mutantCatalog, mutants } from "./definitions.mjs";
import { validateMutantCatalog } from "./validate.mjs";
import { referenceOracle } from "../oracle/index.mjs";

const evaluatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkRoot = resolve(evaluatorRoot, "..");

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function different(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function buildKillMatrix(corpus) {
  const validationCorpus = JSON.parse(readFileSync(resolve(evaluatorRoot, "artifacts", "baseline-corpus.json"), "utf8"));
  const goldens = JSON.parse(readFileSync(resolve(evaluatorRoot, "tests", "golden-cases.json"), "utf8"));
  const mappingSpec = JSON.parse(readFileSync(resolve(benchmarkRoot, "fixture", "spec", "mapping-spec.json"), "utf8"));
  const catalogValidation = validateMutantCatalog([
    ...validationCorpus.cases,
    ...goldens.cases.map((scenario) => ({
      id: scenario.id,
      input: scenario.input,
      expected: referenceOracle(scenario.input)
    }))
  ], new Set([
    ...mappingSpec.rules.map((rule) => rule.id),
    ...mappingSpec.invariants.map((invariant) => invariant.id)
  ]));
  const cases = corpus.cases.map((scenario) => {
    const kills = {};
    const triggered = {};
    for (const mutant of mutants) {
      triggered[mutant.id] = mutant.applies(scenario.input, scenario.expected);
      kills[mutant.id] = different(executeMutant(mutant, scenario.input, scenario.expected), scenario.expected);
    }
    return { caseId: scenario.id, triggered, kills };
  });
  const mutantResults = mutants.map((mutant) => {
    const killingCases = cases.filter((row) => row.kills[mutant.id]).map((row) => row.caseId);
    const triggerCases = cases.filter((row) => row.triggered[mutant.id]).map((row) => row.caseId);
    return {
      id: mutant.id,
      kind: mutant.kind,
      ruleId: mutant.ruleId,
      description: mutant.description,
      fault: mutantCatalog.faults[mutant.id],
      triggerCases,
      killingCases,
      killed: killingCases.length > 0
    };
  });
  const killed = mutantResults.filter((result) => result.killed).length;
  const triggered = mutantResults.filter((result) => result.triggerCases.length > 0).length;
  return {
    formatVersion: 1,
    catalogVersion: mutantCatalog.version,
    catalogValidation: {
      frozenCount: catalogValidation.frozenCount,
      validated: catalogValidation.validated
    },
    corpusInputSha256: corpus.promotion.inputSha256,
    totals: {
      cases: cases.length,
      total: mutantCatalog.frozenCount,
      triggered,
      untriggered: mutantCatalog.frozenCount - triggered,
      killed,
      survived: mutantCatalog.frozenCount - killed,
      mutationScore: killed / mutantCatalog.frozenCount
    },
    mutants: mutantResults,
    cases
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const corpusPath = argument(args, "--corpus");
  const outputPath = argument(args, "--out");
  if (!corpusPath || !outputPath) {
    throw new Error("Usage: node mutants/run.mjs --corpus <corpus.json> --out <matrix.json>");
  }
  const corpus = JSON.parse(readFileSync(resolve(corpusPath), "utf8"));
  const matrix = buildKillMatrix(corpus);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(matrix, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(matrix.totals)}\n`);
}
