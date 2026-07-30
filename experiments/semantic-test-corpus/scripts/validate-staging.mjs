#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateStaging } from "../validators/staging.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/validate-staging.mjs <staging.json>");
const staging = JSON.parse(readFileSync(resolve(path), "utf8"));
const errors = validateStaging(staging);
const summary = {
  cases: staging.cases?.length ?? 0,
  valid: errors.length === 0,
  errorCount: errors.length,
  errors: errors.slice(0, 10)
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (errors.length > 0) process.exitCode = 1;
