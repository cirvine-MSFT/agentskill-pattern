#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  candidateRoot,
  cliArgs,
  cliVersion,
  exactParentWarning,
  experimentRoot,
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
} from "./lib.mjs";

function writeOnce(path, value) {
  invariant(!existsSync(path), `${path} already exists; the freeze is write-once`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonBytes(value), { flag: "wx" });
}

function fileRecord(path, base = experimentRoot) {
  const bytes = readFileSync(path);
  return {
    path: path.slice(base.length + 1).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

const fixtureGenerator = fileRecord(resolve(experimentRoot, "design", "fixture-sources.mjs"));
const fixtures = runs.map((run) => {
  const transcript = readFileSync(transcriptPath(run));
  const gold = readFileSync(goldPath(run));
  return {
    ...run,
    transcriptPath: `fixtures/excluded-pilot/${run.transcriptId}.txt`,
    transcriptBytes: transcript.length,
    transcriptSha256: sha256(transcript),
    goldPath: `evaluator/gold/${run.transcriptId}.json`,
    goldBytes: gold.length,
    goldSha256: sha256(gold),
    sessionId: sessionIdFor(run),
    taskEnvelopeSha256: sha256(Buffer.from(canonicalTask(run), "utf8")),
  };
});
const candidate = manifestFor(candidateRoot);

writeOnce(resolve(experimentRoot, "design", "fixture-manifest.json"), {
  formatVersion: 3,
  protocolId,
  frozenBeforeAnyRun: true,
  v2ImmutabilityReference: {
    pullRequest: 27,
    mergeCommit: "9f3add6986105dd18ac1b4ed8f3cdf2edd639f5a",
    v2InputsIdsHashesEvidenceThresholdsDispositionsModifiedOrReused: false,
    v2PilotUnitsStarted: 0,
    frozenDisposition: "NO-GO",
    frozenDevelopmentEvidence: {
      tupleMatches: "12/12",
      precision: 1,
      recall: 1,
      f1: 1,
      rescissionReassignmentDateHandlingCorrect: true,
      unsupportedCommitments: 0,
      workerViews: 1,
      workerEdits: 1,
      parentFileCalls: 0,
      validSchemaCompactReturnIsolation: true,
      totalModelTokens: 38410,
      wallTimeSeconds: 55.08,
      sourceGrounding: "1/12",
      noGoReason: "Distinct parent/worker debug Tools blocks required by v2 were absent.",
    },
  },
  sourceGenerator: fixtureGenerator,
  candidate,
  fixtures,
});

writeOnce(resolve(experimentRoot, "design", "execution-plan.json"), {
  formatVersion: 3,
  protocolId,
  uuidNamespace,
  frozenBeforeAnyRun: true,
  phase: "excluded-pilot",
  arms: ["A4"],
  aiObservationsOutsideA4: 0,
  seeds: { used: false, value: null },
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
    agent: "action-ledger-v3-haiku",
    model: "claude-haiku-4.5",
    exactFrontmatterTools: workerFrontmatterTools,
    runtimeToolNamesInOrder: ["view", "edit"],
    exactSuccessfulStartsAndCompletions: { view: 1, edit: 1 },
    eventLinkage: "task toolCallId equals worker agentId and subagent toolCallId; every worker tool event carries that parentToolCallId",
    exactEventModels: { parentTask: "gpt-5.6-sol", workerLifecycleAndTools: "claude-haiku-4.5" },
    parentTranscriptOrLedgerCalls: 0,
    otherWorkerTools: 0,
  },
  candidateLayout: [
    ".github/agents/action-ledger-v3-haiku.agent.md",
    ".github/skills/action-ledger-v3/SKILL.md",
    "input/transcript.txt",
    "output/ledger.json",
  ],
  sentinel: {
    precreated: true,
    textSha256: sha256(Buffer.from('{"sentinel":"ACTION_ITEM_EXTRACTION_V3_REPLACE_ME"}\n')),
    replacementRequired: true,
  },
  warningRule: {
    prospectiveInstrumentationCorrection: true,
    v2Reinterpreted: false,
    exactToleratedRootWarning: exactParentWarning,
    exactCount: 1,
    noWorkerUnknownToolWarning: true,
    workerViewStructuredStartAndSuccessfulComplete: 1,
    workerEditStructuredStartAndSuccessfulComplete: 1,
    sentinelReplacedWithValidArtifact: true,
    expectedActorsAndModelsRequired: true,
    distinctDebugToolsBlocks: "informative-not-required",
    anyOtherWarningOrMissingCall: "fatal",
  },
  scoringDefinitions: {
    tuple: "A match requires canonical owner, semantically compatible action similarity at least 0.80, final due date, status, condition, and criticality.",
    pairing: "Candidate/gold pairing requires canonical owner, semantically compatible action polarity, and action similarity at least 0.55 before full tuple correctness is evaluated.",
    sourceGrounding: "Every matched action tuple and required ambiguity must use the exact gold line/range identifiers and complete prefixed transcript quote.",
    ambiguity: "Every required ambiguity needs exact gold citations, compatible semantic polarity, and note-to-gold-reason token F1 of at least 0.55.",
    changesAfterPilotStart: "forbidden",
  },
  runs: runs.map((run) => ({
    order: run.order,
    runId: run.runId,
    transcriptId: run.transcriptId,
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
    sourceGrounding: "100%",
    everyRunTotalModelTokensMaximum: tokenLimit,
    everyRunWallTimeMsMaximum: wallTimeLimitMs,
    thresholdSofteningAllowed: false,
    retriesAllowed: false,
  },
  executionAuthorizationBoundary: "The design PR and this session authorize no v3 start. After merge, only an explicit operator invocation of the guarded --execute entry point may start the three excluded A4 units. GO authorizes only a separate five-arm main-study preregistration PR, never main execution.",
});

writeOnce(resolve(experimentRoot, "design", "evidence-contract.json"), {
  formatVersion: 3,
  protocolId,
  frozenBeforeAnyRun: true,
  lifecycleOrder: [
    "validate frozen foundation",
    "reject existing runtime/evidence roots",
    "verify exact CLI version",
    "write preflight",
    "write durable start index",
    "start three A4 units in frozen order",
    "retain every post-start failure in ITT",
    "settle exact-session usage",
    "score and apply frozen gate",
    "write summary, report, and hash manifest",
    "independently reconstruct each run from raw events, stderr, ledger, usage, process metadata, and frozen inputs",
  ],
  runEvidenceFields: [
    "run identity and order",
    "session UUID",
    "start/end and wall time",
    "process status and raw JSONL/debug stderr",
    "raw process timing, signal, candidate file list, and capture failures",
    "parent/worker actor and model",
    "structured tool starts and matching successful completions",
    "parent file-call count",
    "warning observations and prospective rule result",
    "sentinel replacement and artifact hash",
    "schema, compact return, and candidate isolation",
    "settled exact-session usage and total model tokens",
    "tuple/field/change/unsupported/grounding scores",
    "ITT disposition and failure reasons",
  ],
  usageSettlement: {
    source: "isolated assistant_usage_events rows for exact session UUID",
    allRowsRequireFinishReason: true,
    numericInputAndOutputTokensRequired: true,
    expectedModels: ["gpt-5.6-sol", "claude-haiku-4.5"],
  },
  manifest: { algorithm: "sha256", pathsAndBytesIncluded: true, writeAfterSummary: true },
  certification: {
    frozenFoundationRevalidated: true,
    derivedRunEvidenceReconstructedFromRawArtifacts: true,
    summaryGateRecomputedFromReconstructedRuns: true,
  },
});

writeOnce(resolve(experimentRoot, "design", "main-study-reservation.json"), {
  formatVersion: 3,
  protocolId,
  reservationOnly: true,
  executionAuthorized: false,
  inputsGenerated: false,
  hashesGenerated: false,
  armsRequiredInSeparatePr: ["A0", "A1", "A2", "A3", "A4"],
  prerequisite: "v3 excluded-pilot GO",
  authorizationBoundary: "A v3 GO authorizes only a separate five-arm main-study preregistration PR. It does not authorize immediate main execution.",
});

writeOnce(resolve(experimentRoot, "design", "no-run-attestation.json"), {
  formatVersion: 3,
  protocolId,
  designOnly: true,
  v3AiUnitsStarted: 0,
  v3DevelopmentUnitsStarted: 0,
  v3PilotUnitsStarted: 0,
  v3MainUnitsStarted: 0,
  v3ResultEvidenceRootExists: false,
  v3RuntimeRootExists: false,
  lifecycleEvidenceCreated: false,
  copilotCliInvokedForV3Observation: false,
  attestation: "No v3 AI unit has started; this foundation freezes design only.",
});

const sealedDesignNames = [
  "fixture-manifest.json",
  "execution-plan.json",
  "evidence-contract.json",
  "main-study-reservation.json",
  "no-run-attestation.json",
];
const lifecyclePaths = [
  "package.json",
  "design/fixture-sources.mjs",
  "scripts/assert-no-run.mjs",
  "scripts/check-evidence.mjs",
  "scripts/evidence.mjs",
  "scripts/freeze-foundation.mjs",
  "scripts/generate-fixtures.mjs",
  "scripts/generate-report.mjs",
  "scripts/lib.mjs",
  "scripts/run-excluded-pilot.mjs",
  "scripts/validate-foundation.mjs",
  "evaluator/evaluate.mjs",
  "candidate/.github/skills/action-ledger-v3/SKILL.md",
  "candidate/.github/agents/action-ledger-v3-haiku.agent.md",
];
writeOnce(resolve(experimentRoot, "design", "foundation-lock.json"), {
  formatVersion: 3,
  protocolId,
  writeOnce: true,
  designFiles: sealedDesignNames.map((name) => fileRecord(resolve(experimentRoot, "design", name))),
  lifecycleAndCandidateFiles: lifecyclePaths.map((path) => fileRecord(resolve(experimentRoot, path))),
});

process.stdout.write("Frozen v3 fixtures, gold, identities, prompts, tooling, warning rule, gates, and lifecycle once\n");

function canonicalTask(run) {
  return JSON.stringify(taskEnvelope(run));
}
