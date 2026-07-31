#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceOracle } from "./oracle/index.mjs";
import { assessStaging } from "../validators/staging.mjs";

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function promoteStaging(staging, sourceBytes, promotedAt = new Date().toISOString()) {
  const assessment = assessStaging(staging);
  return promoteAssessment(staging, sourceBytes, promotedAt, assessment);
}

export function promoteSubmission(sourceBytes, promotedAt = new Date().toISOString()) {
  let staging = null;
  let parseError = null;
  try {
    staging = JSON.parse(sourceBytes);
  } catch (error) {
    parseError = error.message;
  }
  const assessment = assessStaging(staging, parseError);
  return promoteAssessment(staging, sourceBytes, promotedAt, assessment);
}

function promoteAssessment(staging, sourceBytes, promotedAt, assessment) {
  const cases = assessment.cases.filter((item) => item.valid).map(({ scenario }) => ({
    ...scenario,
    expected: referenceOracle(scenario.input)
  }));
  const invalidCases = assessment.cases.filter((item) => !item.valid).map((item) => ({
    index: item.index,
    id: item.id,
    errors: item.errors
  }));
  return {
    formatVersion: 1,
    generator: staging?.generator ?? null,
    promotion: {
      oracle: "evaluator/oracle/index.mjs",
      promotedAt,
      inputSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      targetCases: 60,
      submittedCases: assessment.submittedCases,
      promotedCases: cases.length,
      invalidCases: invalidCases.length,
      missingSlots: Math.max(0, 60 - Math.min(assessment.submittedCases, 60)),
      promotionRate: cases.length / 60
    },
    submissionErrors: assessment.submissionErrors,
    invalidCases,
    cases
  };
}

export function promotionSummary(corpus) {
  const valid = corpus.cases.filter((scenario) => scenario.expected.status === "ok").length;
  return {
    submitted: corpus.promotion.submittedCases,
    promoted: corpus.promotion.promotedCases,
    invalidCases: corpus.promotion.invalidCases,
    missingSlots: corpus.promotion.missingSlots,
    promotionRate: corpus.promotion.promotionRate,
    valid,
    semanticallyInvalid: corpus.cases.length - valid,
    oracle: corpus.promotion.oracle,
    inputSha256: corpus.promotion.inputSha256
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const inputPath = argument(args, "--in");
  const outputPath = argument(args, "--out");
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node evaluator/promote.mjs --in <staging.json> --out <corpus.json> [--promoted-at <ISO>]");
  }
  const sourceBytes = readFileSync(resolve(inputPath));
  const corpus = promoteSubmission(sourceBytes, argument(args, "--promoted-at"));
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(corpus, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(promotionSummary(corpus))}\n`);
}
