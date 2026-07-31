#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLocalEvidence } from "./collect-local-evidence.mjs";
import { preflightLocalModel } from "./preflight-local-model.mjs";
import { validateLocalEvidence } from "./validate-local-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(root, "fixtures", "local-evidence");
const eventsPath = resolve(fixtureRoot, "captured.events.jsonl");
const usagePath = resolve(fixtureRoot, "captured.usage.json");
const candidateBoundaryPath = resolve(fixtureRoot, "candidate-boundary.json");
const runManifestPath = resolve(fixtureRoot, "run-manifest.json");
const runAttemptPath = resolve(fixtureRoot, "attempt-1.json");

export function reproduceLocalEvidence() {
  const eventsBytes = readFileSync(eventsPath);
  const usageBytes = readFileSync(usagePath);
  const candidateBoundaryBytes = readFileSync(candidateBoundaryPath);
  const runManifestBytes = readFileSync(runManifestPath);
  const runAttemptBytes = readFileSync(runAttemptPath);
  const output = collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes,
    usagePath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    runManifest: JSON.parse(runManifestBytes),
    runManifestBytes,
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  });
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
  assert.deepEqual(bytes, readFileSync(resolve(fixtureRoot, "expected.json")));
  assert.deepEqual(validateLocalEvidence(output, { artifactRoot: fixtureRoot }), []);
  const preflight = preflightLocalModel(output, bytes);
  assert.equal(preflight.status, "pass");
  return { output, preflight };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reproduceLocalEvidence();
  process.stdout.write("Reproduced descriptive local evidence and model preflight byte-for-byte.\n");
}
