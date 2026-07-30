#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceOracle } from "../fixture/oracle/index.mjs";
import { validateStaging } from "../validators/staging.mjs";

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function promoteStaging(staging, sourceBytes, promotedAt = new Date().toISOString()) {
  const errors = validateStaging(staging);
  if (errors.length > 0) {
    const message = errors.slice(0, 10).map((error) => `${error.path}: ${error.message}`).join("\n");
    throw new Error(`Staging validation failed with ${errors.length} error(s):\n${message}`);
  }
  return {
    formatVersion: 1,
    generator: staging.generator,
    promotion: {
      oracle: "fixture/oracle/index.mjs",
      promotedAt,
      inputSha256: createHash("sha256").update(sourceBytes).digest("hex")
    },
    cases: staging.cases.map((scenario) => ({
      ...scenario,
      expected: referenceOracle(scenario.input)
    }))
  };
}

export function promotionSummary(corpus) {
  const valid = corpus.cases.filter((scenario) => scenario.expected.status === "ok").length;
  return {
    staged: corpus.cases.length,
    promoted: corpus.cases.length,
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
    throw new Error("Usage: node scripts/promote.mjs --in <staging.json> --out <corpus.json> [--promoted-at <ISO>]");
  }
  const sourceBytes = readFileSync(resolve(inputPath));
  const staging = JSON.parse(sourceBytes);
  const corpus = promoteStaging(staging, sourceBytes, argument(args, "--promoted-at"));
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(corpus, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(promotionSummary(corpus))}\n`);
}
