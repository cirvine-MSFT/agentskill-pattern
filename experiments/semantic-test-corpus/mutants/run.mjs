#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeMutant, mutants } from "./definitions.mjs";

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function different(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function buildKillMatrix(corpus) {
  const cases = corpus.cases.map((scenario) => {
    const kills = {};
    const applicable = {};
    for (const mutant of mutants) {
      applicable[mutant.id] = mutant.applies(scenario.input, scenario.expected);
      kills[mutant.id] = different(executeMutant(mutant, scenario.input, scenario.expected), scenario.expected);
    }
    return { caseId: scenario.id, applicable, kills };
  });
  const mutantResults = mutants.map((mutant) => {
    const killingCases = cases.filter((row) => row.kills[mutant.id]).map((row) => row.caseId);
    const applicableCases = cases.filter((row) => row.applicable[mutant.id]).map((row) => row.caseId);
    return {
      id: mutant.id,
      kind: mutant.kind,
      ruleId: mutant.ruleId,
      description: mutant.description,
      applicableCases,
      killingCases,
      killed: killingCases.length > 0
    };
  });
  const killed = mutantResults.filter((result) => result.killed).length;
  const applicable = mutantResults.filter((result) => result.applicableCases.length > 0).length;
  return {
    formatVersion: 1,
    corpusInputSha256: corpus.promotion.inputSha256,
    totals: {
      cases: cases.length,
      mutants: mutants.length,
      applicable,
      notApplicable: mutants.length - applicable,
      killed,
      survived: applicable - killed,
      mutationScore: applicable === 0 ? null : killed / applicable
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
