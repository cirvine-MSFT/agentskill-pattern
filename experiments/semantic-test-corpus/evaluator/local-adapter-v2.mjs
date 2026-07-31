#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotLocalCorpusStaging } from "./adapter.mjs";

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const contractRoot = argument(args, "--corpus-contract");
  const stagingRoot = argument(args, "--corpus-staging");
  const evidencePath = argument(args, "--local-evidence");
  const preflightPath = argument(args, "--model-preflight");
  const outputPath = argument(args, "--out");
  if (!contractRoot || !stagingRoot || !evidencePath || !preflightPath || !outputPath) {
    throw new Error("Usage: node evaluator/local-adapter-v2.mjs --corpus-contract <root> --corpus-staging <root> --local-evidence <evidence.json> --model-preflight <preflight.json> --out <staging.json>");
  }
  const localEvidenceBytes = readFileSync(resolve(evidencePath));
  const result = snapshotLocalCorpusStaging({
    corpusContractRoot: contractRoot,
    corpusStagingRoot: stagingRoot,
    localEvidence: JSON.parse(localEvidenceBytes),
    localEvidenceBytes,
    modelPreflight: JSON.parse(readFileSync(resolve(preflightPath), "utf8")),
    sourceArtifactRoot: dirname(resolve(evidencePath)),
    outputPath
  });
  process.stdout.write(`${result.staging.generator.blockId}-A${result.staging.generator.armId}: ${result.submittedCases}/60 staged cases snapshotted\n`);
}
