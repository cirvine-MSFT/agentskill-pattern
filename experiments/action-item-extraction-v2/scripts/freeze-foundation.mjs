#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  acceptedParentWarnings,
  candidateRoot,
  cliArgs,
  cliVersion,
  globalToolFilter,
  goldPath,
  invariant,
  jsonBytes,
  manifestFor,
  protocolId,
  runs,
  sessionIdFor,
  sha256,
  taskEnvelope,
  tokenLimit,
  transcriptPath,
  uuidNamespace,
  wallTimeLimitMs,
  workerFrontmatterTools,
  experimentRoot,
} from "./lib.mjs";

function writeOnce(path, value) {
  invariant(!existsSync(path), `${path} already exists; the freeze is write-once`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonBytes(value), { flag: "wx" });
}

const fixtures = runs.map((run) => {
  const transcript = readFileSync(transcriptPath(run));
  const gold = readFileSync(goldPath(run));
  return {
    ...run,
    transcriptPath: `fixtures/${run.partition}/${run.transcriptId}.txt`,
    transcriptBytes: transcript.length,
    transcriptSha256: sha256(transcript),
    goldPath: `evaluator/gold/${run.transcriptId}.json`,
    goldBytes: gold.length,
    goldSha256: sha256(gold),
    sessionId: sessionIdFor(run),
    taskEnvelopeSha256: sha256(Buffer.from(canonicalEnvelope(run), "utf8")),
  };
});
const candidate = manifestFor(candidateRoot);
const executionPlan = {
  formatVersion: 2,
  protocolId,
  uuidNamespace,
  frozenBeforeAnyRun: true,
  cli: {
    exactVersion: cliVersion,
    parentModel: "gpt-5.6-sol",
    outputFormat: "json",
    outputSemantics: "JSONL event objects",
    logLevel: "debug",
    exactGlobalToolFilter: globalToolFilter,
    allowAllTools: true,
    builtinMcpsDisabled: true,
  },
  worker: {
    agent: "action-ledger-v2-haiku",
    model: "claude-haiku-4.5",
    exactFrontmatterTools: workerFrontmatterTools,
    runtimeToolNames: ["view", "edit"],
  },
  acceptedParentWarnings,
  runs: runs.map((run) => ({
    runId: run.runId,
    sessionId: sessionIdFor(run),
    taskEnvelope: taskEnvelope(run),
    exactCliArgs: cliArgs(run),
  })),
  thresholds: {
    operationalAndTreatmentAdherent: "3/3",
    exactOneViewOneEdit: "3/3",
    unsupportedCriticalActionsMaximum: 0,
    validSchemaCompactReturnIsolation: "3/3",
    meanTupleF1Minimum: 0.85,
    everyRunTupleF1Minimum: 0.75,
    everyRunTotalModelTokensMaximum: tokenLimit,
    everyRunWallTimeMsMaximum: wallTimeLimitMs,
    thresholdSofteningAllowed: false,
    retriesAllowed: false,
  },
};
writeOnce(resolve(experimentRoot, "design", "fixture-manifest.json"), {
  formatVersion: 2,
  protocolId,
  frozenBeforeAnyRun: true,
  v1ImmutabilityReference: {
    mergeCommit: "4900bdde8250292c86d4040d242359359ac050a0",
    pullRequest: 26,
    contentReadOrCopiedByV2Validation: false,
  },
  candidate,
  fixtures,
});
writeOnce(resolve(experimentRoot, "design", "execution-plan.json"), executionPlan);
writeOnce(resolve(experimentRoot, "design", "development-gate.json"), {
  formatVersion: 2,
  protocolId,
  phase: "development-unit",
  run: executionPlan.runs[0],
  fixture: fixtures[0],
  permanentlyExcludedFromConfirmation: true,
  frozenBeforeStart: true,
  executeExactlyOnceLater: true,
  passRequirements: {
    operationalSuccess: true,
    treatmentAdherent: true,
    skillLoadedFromProject: true,
    oneDelegationToFixedWorker: true,
    workerViewStartComplete: 1,
    workerEditStartComplete: 1,
    sentinelReplaced: true,
    parentTranscriptOrLedgerFileCalls: 0,
    workerToolsSchemasContain: ["view", "edit"],
    validSchema: true,
    compactReturn: true,
    candidateIsolation: true,
    totalModelTokensMaximum: tokenLimit,
    wallTimeMsMaximum: wallTimeLimitMs,
  },
  failureRule: "Preserve evidence, persist NO-GO, start zero pilots, and stop without retry.",
});
const sealedPaths = ["fixture-manifest.json", "execution-plan.json", "development-gate.json"];
writeOnce(resolve(experimentRoot, "design", "foundation-lock.json"), {
  formatVersion: 2,
  protocolId,
  writeOnce: true,
  files: sealedPaths.map((name) => {
    const bytes = readFileSync(resolve(experimentRoot, "design", name));
    return { path: `design/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
  }),
});
process.stdout.write("Frozen v2 fixtures, gold, candidate, sessions, gates, and CLI arguments once\n");

function canonicalEnvelope(run) {
  return JSON.stringify(taskEnvelope(run));
}
