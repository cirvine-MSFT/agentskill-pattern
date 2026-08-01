#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERAL_GENERATOR_DEPENDENCIES,
  generateGeneralBaseline
} from "./general-generate.mjs";

export { GENERAL_GENERATOR_DEPENDENCIES };
export const generateBaseline = generateGeneralBaseline;
export const PAIRWISE_FACTORS = {
  environment: ["dev", "test", "prod"],
  region: ["eastus", "us", "westeurope"],
  cache: ["none", "memory", "redis"],
  database: ["postgres", "mysql", "sqlite"],
  retry: ["fixed", "exponential"],
  pretty: [false, true]
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--out");
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    throw new Error("Usage: node baseline/generate.mjs --out <file> [--seed <n>] [--block <id>]");
  }
  const seedIndex = args.indexOf("--seed");
  const blockIndex = args.indexOf("--block");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : 20260729;
  const blockId = blockIndex >= 0 ? args[blockIndex + 1] : "B00";
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  const target = resolve(args[outputIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(generateGeneralBaseline({ seed, blockId }), null, 2)}\n`);
  process.stdout.write(`Generated 60 general deterministic cases at ${target}\n`);
}
