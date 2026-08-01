#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assert,
  candidateManifest,
  cliArgs,
  experimentRoot,
  jsonBytes,
  protocolId,
  runs,
  sha256,
  taskEnvelope,
  transcriptPath,
} from "./lib.mjs";

function writeOnce(path, value) {
  assert(!existsSync(path), `${path} already exists; frozen inputs are immutable`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonBytes(value), { flag: "wx" });
}

const fixtures = runs.map((run) => {
  const bytes = readFileSync(transcriptPath(run));
  return {
    phase: run.phase,
    runId: run.runId,
    transcriptId: run.transcriptId,
    path: `fixtures/${run.partition}/${run.transcriptId}.txt`,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
});
const development = runs[0];
const manifest = candidateManifest();

writeOnce(resolve(experimentRoot, "design", "fixture-manifest.json"), {
  formatVersion: 1,
  protocolId,
  frozenBeforeAnyLifecycleMarker: true,
  fixtures,
});
writeOnce(resolve(experimentRoot, "design", "development-gate.json"), {
  formatVersion: 1,
  protocolId,
  phase: "development-smoke",
  permanentlyExcludedFromConfirmation: true,
  frozenBeforeStart: true,
  runId: development.runId,
  transcriptId: development.transcriptId,
  transcriptSha256: fixtures[0].sha256,
  candidateFileSetSha256: manifest.fileSetSha256,
  parentModel: "gpt-5.6-sol",
  workerAgent: "action-item-haiku",
  workerModel: "claude-haiku-4.5",
  skill: "action-item-extraction",
  workerTools: ["read", "edit"],
  availableTools: ["skill", "task", "read", "edit"],
  taskEnvelope: taskEnvelope(development),
  taskEnvelopeSha256: sha256(Buffer.from(JSON.stringify(taskEnvelope(development)), "utf8")),
  exactCliArgs: cliArgs(development),
  required: {
    unknownToolWarnings: 0,
    skillStarts: 1,
    delegations: 1,
    workerTranscriptReads: 1,
    workerLedgerEdits: 1,
    parentTranscriptReads: 0,
    parentLedgerEdits: 0,
    schemaValid: true,
    compactReturn: true,
    forbiddenRootAccesses: 0,
    unexpectedActors: 0,
    totalModelTokensMaximum: 40000,
    wallTimeMsMaximum: 180000,
  },
  abandonmentRule: [
    "Any failed smoke requirement permanently sets NO-GO on this runtime.",
    "Preserve the consumed run and do not retry or tune DEV-ACTION-V1-A4-01.",
    "Do not start excluded pilot or main units after smoke failure.",
  ],
});

process.stdout.write("Frozen action-item foundation before lifecycle markers\n");
