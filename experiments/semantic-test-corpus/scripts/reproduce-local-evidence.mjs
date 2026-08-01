#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLocalEvidence } from "./collect-local-evidence.mjs";
import { preflightLocalModel } from "./preflight-local-model.mjs";
import { validateLocalEvidence } from "./validate-local-evidence.mjs";
import { materializeCandidate } from "./materialize-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(root, "fixtures", "local-evidence");
const eventsPath = resolve(fixtureRoot, "captured.events.jsonl");
const usagePath = resolve(fixtureRoot, "captured.usage.json");
const sessionCreationPath = resolve(fixtureRoot, "session-creation.json");
const candidateBoundaryPath = resolve(fixtureRoot, "candidate-boundary.json");
const runManifestPath = resolve(fixtureRoot, "run-manifest.json");
const runAttemptPath = resolve(fixtureRoot, "attempt-1.json");

export function reproduceLocalEvidence() {
  const candidateRoot = resolve(root, ".regression-work", "reproduce-evidence-candidate");
  rmSync(candidateRoot, { recursive: true, force: true });
  materializeCandidate(candidateRoot, {
    allowTestDestination: true,
    blockId: "B01",
    abortedV2: true
  });
  try {
    const eventsBytes = readFileSync(eventsPath);
    const usageBytes = readFileSync(usagePath);
    const sessionCreationBytes = readFileSync(sessionCreationPath);
    const candidateBoundaryBytes = readFileSync(candidateBoundaryPath);
    const runManifestBytes = readFileSync(runManifestPath);
    const runAttemptBytes = readFileSync(runAttemptPath);
    const output = collectLocalEvidence({
      eventsBytes,
      eventsPath,
      usageBytes,
      usagePath,
      sessionCreationBytes,
      sessionCreationPath,
      candidateBoundaryBytes,
      candidateBoundaryPath,
      candidateRoot,
      runManifest: JSON.parse(runManifestBytes),
      runManifestBytes,
      runManifestPath,
      runAttempt: JSON.parse(runAttemptBytes),
      runAttemptBytes,
      runAttemptPath
    });
    const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
    assert.deepEqual(bytes, readFileSync(resolve(fixtureRoot, "expected.json")));
    assert.deepEqual(validateLocalEvidence(output, {
      artifactRoot: fixtureRoot,
      candidateRoot
    }), []);
    const preflight = preflightLocalModel(output, bytes);
    assert.equal(preflight.status, "pass");
    return { output, preflight };
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reproduceLocalEvidence();
  process.stdout.write("Reproduced descriptive local evidence and model preflight byte-for-byte.\n");
}
