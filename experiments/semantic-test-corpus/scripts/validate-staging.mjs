#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessStaging } from "../validators/staging.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/validate-staging.mjs <staging.json>");
const source = readFileSync(resolve(path), "utf8");
let staging = null;
let parseError = null;
try {
  staging = JSON.parse(source);
} catch (error) {
  parseError = error.message;
}
const assessment = assessStaging(staging, parseError);
const errors = [
  ...assessment.submissionErrors,
  ...assessment.cases.flatMap((item) => item.errors)
];
const summary = {
  submittedCases: assessment.submittedCases,
  promotableCases: assessment.promotableCases,
  targetCases: 60,
  valid: errors.length === 0,
  errorCount: errors.length,
  errors: errors.slice(0, 10)
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (errors.length > 0) process.exitCode = 1;
