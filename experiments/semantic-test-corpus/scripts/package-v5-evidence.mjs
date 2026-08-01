#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDescriptiveRuns,
  summarizeDescriptive
} from "../evaluator/descriptive-v2.mjs";
import { validateStartOrder } from "./validate-start-order.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "..", "..");
const schemaRoot = resolve(root, "schemas");
const packageRoot = resolve(root, "results", "v5-b01");
const schedulePath = resolve(root, "design", "v5", "schedule.json");
const sourcePinPath = resolve(root, "design", "v5", "source-pin.json");
const descriptiveInputSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "descriptive-input.schema.json"), "utf8")
);
const PROTOCOL_ID = "semantic-test-corpus-execution-v5";
const START_INDEX_SHA256 = "61f6a10627aab3286e7e98d48fedd5b8481c89cf66a5251742649713f3913a09";
const CLOSURE_SHA256 = "d0d86f7f43b20ef3bd95cdc76929cd74973d77e5c0867acf2e8ca0ebd114433c";
const SOURCE_AGGREGATE_SHA256 = "87091a3e1aa2d5a296079ea8977dfe8b52ba0f6bf6217f5151770e5cd3d139a4";
const SOURCE_FILE_COUNT = 9117;
const SOURCE_TOTAL_BYTES = 200128327;
const FORBIDDEN_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "content",
  "encrypted_content",
  "password",
  "prompt",
  "reasoning_content",
  "refresh_token",
  "sandbox_token",
  "secret",
  "token_details_json"
]);
const PRIVATE_PATH_TEXT = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s("'`])\/(?!\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|\.copilot[\\/]+session-state)/u;

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function pathContains(parent, child) {
  const childPath = relative(resolve(parent), resolve(child));
  return childPath === "" || (!isAbsolute(childPath)
    && childPath !== ".."
    && !childPath.startsWith(`..${sep}`));
}

function canonicalFilesystemPath(path) {
  let existing = resolve(path);
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...suffix);
}

export function pathsOverlap(left, right) {
  const canonicalLeft = canonicalFilesystemPath(left);
  const canonicalRight = canonicalFilesystemPath(right);
  return pathContains(canonicalLeft, canonicalRight)
    || pathContains(canonicalRight, canonicalLeft);
}

export function isMachinePrivatePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\]+\\[^\\]+/u.test(value)
    || (/^\//u.test(value) && !/^\/\//u.test(value))
    || /\.copilot[\\/]+session-state/u.test(value);
}

function writeCanonical(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalBytes(value), { flag: "wx" });
}

function walkSourceFiles(sourceRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = resolve(directory, entry.name);
      const path = portablePath(relative(sourceRoot, absolutePath));
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isSymbolicLink()) {
        const targetBytes = Buffer.from(readlinkSync(absolutePath), "utf8");
        files.push({
          path,
          kind: "symlink",
          bytes: targetBytes.length,
          sha256: sha256(targetBytes)
        });
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolutePath);
        files.push({ path, kind: "file", bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  walk(sourceRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function aggregateFileManifest(files) {
  return sha256(Buffer.from(files
    .map((file) => `${file.path}\0${file.kind}\0${file.bytes}\0${file.sha256}\n`)
    .join(""), "utf8"));
}

function portableClosure(closure, sourceRoot) {
  const convert = (value, key = "") => {
    if (Array.isArray(value)) return value.map((item) => convert(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .map(([name, child]) => [name, convert(child, name)]));
    }
    if (typeof value !== "string" || !isMachinePrivatePath(value)) return value;
    const resolved = resolve(value);
    if (pathContains(sourceRoot, resolved)) {
      return portablePath(relative(sourceRoot, resolved));
    }
    const normalized = portablePath(value);
    if (normalized.endsWith("/experiments/semantic-test-corpus/design/v5/schedule.json")) {
      return "design/v5/schedule.json";
    }
    if (normalized.endsWith("/experiments/semantic-test-corpus/design/v5/source-pin.json")) {
      return "design/v5/source-pin.json";
    }
    return key.toLowerCase().includes("path") ? "<machine-private-path-redacted>" : value;
  };
  return convert(closure);
}

function portableExecutionPreflight(preflight) {
  return {
    ...preflight,
    usageStore: {
      ...preflight.usageStore,
      path: "session-store.db"
    }
  };
}

function assertSourceClosure(sourceRoot, closure, startIndex, schedule, sourcePin) {
  assert.equal(closure.formatVersion, 1);
  assert.equal(closure.protocolId, PROTOCOL_ID);
  assert.equal(closure.status, "closed");
  assert.equal(closure.index.sha256, START_INDEX_SHA256);
  assert.equal(closure.index.captures, 72);
  assert.equal(closure.schedule.sha256, sha256(readFileSync(schedulePath)));
  assert.equal(closure.schedule.runs, 72);
  assert.equal(closure.sourcePin.sha256, sha256(readFileSync(sourcePinPath)));
  assert.equal(closure.sourcePin.sourceCommit, sourcePin.sourceCommit);
  assert.equal(closure.sourcePin.sourceTree, sourcePin.sourceTree);
  assert.equal(closure.sourcePin.generatorCommit, sourcePin.generatorCommit);
  assert.equal(closure.sourcePin.generatorTree, sourcePin.generatorTree);
  assert.deepEqual(closure.validation, {
    exactSchedule: true,
    terminalBundles: 72,
    aiExecutionRecords: 60,
    deterministicBundles: 12,
    uniqueScheduledSessionIds: 60,
    usageExportsSettled: 60,
    candidateTerminalCommitsMatched: 60,
    sourcePinsMatched: 72,
    missingSlots: 0,
    unscheduledMeasuredIds: 0,
    duplicateSessionIds: 0,
    retries: 0,
    attemptDeviationCount: 0
  });
  assert.deepEqual(closure.protocolDeviations, []);
  assert.equal(closure.runs.length, 72);
  assert.equal(startIndex.captures.length, 72);
  assert.equal(schedule.runs.length, 72);

  const startErrors = validateStartOrder(startIndex, {
    requireComplete: true,
    baseDir: resolve(sourceRoot, "artifacts")
  });
  assert.deepEqual(startErrors, []);

  const scheduledSessions = new Set(schedule.runs
    .map((run) => run.sessionId)
    .filter(Boolean));
  assert.equal(scheduledSessions.size, 60);
  const observedSessions = new Set();
  let terminalCommitCount = 0;
  const blocks = new Map();
  for (const [index, run] of closure.runs.entries()) {
    const planned = schedule.runs[index];
    assert.equal(run.globalOrder, planned.globalOrder);
    assert.equal(run.runId, planned.runId);
    assert.equal(run.blockId, planned.blockId);
    assert.equal(run.armId, planned.armId);
    assert.equal(run.sessionId, planned.sessionId);
    assert.ok(["success", "measured-failure"].includes(run.disposition));
    assert.equal(run.semanticQualityScored, true);
    assert.equal(run.retryCount, 0);
    assert.deepEqual(run.attemptDeviations, []);
    assert.ok(Array.isArray(run.measuredEvidenceDeviations));
    blocks.set(run.blockId, (blocks.get(run.blockId) ?? new Set()).add(run.armId));
    if (run.armId !== 0) {
      observedSessions.add(run.sessionId);
      const manifest = readJson(resolve(sourceRoot, "artifacts", run.runId, "run-manifest.json"));
      const attempt = readJson(resolve(sourceRoot, "artifacts", run.runId, "attempt-1.json"));
      assert.equal(manifest.cliSessionId, planned.sessionId);
      assert.equal(attempt.cliSessionId, planned.sessionId);
      assert.equal(manifest.attemptNumber, 1);
      assert.equal(attempt.attemptNumber, 1);
      assert.equal(attempt.attemptId, `${run.runId}-attempt-1`);
      assert.equal(attempt.treatment.sourceCommit, sourcePin.sourceCommit);
      assert.equal(attempt.treatment.sourceTree, sourcePin.sourceTree);
      assert.equal(attempt.treatment.terminalCommit, manifest.terminalCommit);
      assert.ok(existsSync(resolve(sourceRoot, "artifacts", run.runId, "captured.usage.json")));
      terminalCommitCount += 1;
    }
  }
  assert.deepEqual(observedSessions, scheduledSessions);
  assert.equal(terminalCommitCount, 60);
  assert.equal(blocks.size, 12);
  for (const arms of blocks.values()) assert.deepEqual([...arms].sort(), [0, 1, 2, 3, 4, 5]);
}

function descriptiveArtifactManifest(sourceRoot, schedule, closure) {
  const closureByRun = new Map(closure.runs.map((run) => [run.runId, run]));
  return {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    startIndexPath: "artifacts/start-index.json",
    startIndexSha256Path: "artifacts/start-index.json.sha256",
    runs: schedule.runs.map((planned) => {
      const closed = closureByRun.get(planned.runId);
      const runRoot = `artifacts/${planned.runId}`;
      const measuredFailure = closed.disposition === "measured-failure";
      return {
        runId: planned.runId,
        blockId: planned.blockId,
        armId: planned.armId,
        status: measuredFailure ? "measured-failure" : "eligible",
        snapshotPath: `${runRoot}/staging.json`,
        metricsPath: `${runRoot}/metrics.json`,
        executionPath: planned.armId === 0 ? `${runRoot}/execution.json` : null,
        localEvidencePath: planned.armId === 0 ? null : `${runRoot}/local-evidence.json`,
        modelPreflightPath: planned.armId === 0 ? null : `${runRoot}/model-preflight.json`,
        candidateRoot: planned.armId === 0 ? null : `candidates/${planned.runId}`,
        evaluationPath: `${runRoot}/evaluation.json`,
        startEvidencePath: planned.armId === 0 ? `${runRoot}/lifecycle-start.json` : null,
        endEvidencePath: planned.armId === 0 ? `${runRoot}/lifecycle-end.json` : null,
        dispositionPath: measuredFailure ? `${runRoot}/unit-disposition.json` : null
      };
    })
  };
}

function sourceBinding(sourceRoot, path) {
  const bytes = readFileSync(resolve(sourceRoot, path));
  return { path: portablePath(path), bytes: bytes.length, sha256: sha256(bytes) };
}

function sessionIdentity(sourceRoot, runRoot) {
  const path = `${runRoot}/session-creation.json`;
  const bytes = readFileSync(resolve(sourceRoot, path));
  const record = JSON.parse(bytes);
  return {
    source: { path, bytes: bytes.length, sha256: sha256(bytes) },
    operation: record.operation,
    capturedAt: record.capturedAt,
    request: {
      sessionId: record.request.session_id,
      model: record.request.model,
      agent: record.request.agent,
      outputFormat: record.request.output_format,
      candidateCommit: record.request.candidate_commit,
      availableTools: record.request.available_tools,
      disabledMcpServers: record.request.disabled_mcp_servers
    },
    response: {
      resultSessionId: record.response.result_session_id,
      exitCode: record.response.exit_code
    }
  };
}

function candidateIdentity(sourceRoot, runRoot) {
  const path = `${runRoot}/candidate-boundary.json`;
  const bytes = readFileSync(resolve(sourceRoot, path));
  const record = JSON.parse(bytes);
  return {
    source: { path, bytes: bytes.length, sha256: sha256(bytes) },
    formatVersion: record.formatVersion,
    manifestVersion: record.manifestVersion,
    sourceCommit: record.sourceCommit,
    sourceTree: record.sourceTree,
    blockId: record.blockId,
    seed: record.seed,
    taskSha256: record.taskSha256,
    networkPolicy: record.networkPolicy,
    filesystemPolicy: record.filesystemPolicy,
    files: record.files
  };
}

function provenanceIdentity(sourceRoot, runRoot) {
  const path = `${runRoot}/capture-provenance.json`;
  const bytes = readFileSync(resolve(sourceRoot, path));
  const record = JSON.parse(bytes);
  return {
    source: { path, bytes: bytes.length, sha256: sha256(bytes) },
    formatVersion: record.formatVersion,
    protocolId: record.protocolId,
    evidence: record.evidence,
    immutablePolicy: record.immutablePolicy,
    sourcePin: record.sourcePin,
    appProjectSessionId: record.appProjectSessionId,
    cliSessionId: record.cliSessionId,
    terminalCommit: record.terminalCommit,
    candidateBoundarySha256: record.candidateBoundarySha256
  };
}

function safeStagingRecord(sourceRoot, runRoot, evaluation, metrics) {
  const source = sourceBinding(sourceRoot, `${runRoot}/staging.json`);
  assert.equal(source.sha256, evaluation.snapshotSha256);
  return {
    recordKind: "safe-partial-hash-record",
    source,
    committedSnapshot: false,
    localAuthentication: "evaluation-record-sha256",
    scoringSource: metrics.outcome.scoringSource,
    submittedCases: metrics.metrics.promotion.submittedCases,
    promotedCases: metrics.metrics.promotion.promotedCases,
    invalidCases: metrics.metrics.promotion.invalidCases,
    missingSlots: metrics.metrics.promotion.missingSlots
  };
}

function buildRunBundle(
  sourceRoot,
  sourceFiles,
  planned,
  closed,
  descriptiveRun,
  unitRecord
) {
  const runRoot = `artifacts/${planned.runId}`;
  const readRun = (name) => readJson(resolve(sourceRoot, runRoot, name));
  const evaluation = readRun("evaluation.json");
  const metrics = readRun("metrics.json");
  const lifecycleStart = readRun("lifecycle-start.json");
  const startCapture = readRun("start-capture.json");
  const runSourceFiles = sourceFiles.filter((file) =>
    file.path.startsWith(`${runRoot}/`));
  const bundle = {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    runId: planned.runId,
    blockId: planned.blockId,
    armId: planned.armId,
    globalOrder: planned.globalOrder,
    scheduledSessionId: planned.sessionId,
    disposition: closed.disposition === "success"
      ? {
          status: "eligible",
          reason: null,
          evidenceKind: "evaluation-record",
          evaluationSha256: sourceBinding(sourceRoot, `${runRoot}/evaluation.json`).sha256,
          retryCount: 0
        }
      : readRun("unit-disposition.json"),
    lifecycleStart,
    startCapture,
    evaluation: {
      source: sourceBinding(sourceRoot, `${runRoot}/evaluation.json`),
      sourceBytesCommitted: false,
      record: portableClosure(evaluation, sourceRoot)
    },
    metrics,
    analysis: {
      descriptiveRun,
      unitRecord
    },
    stagingEvidence: safeStagingRecord(sourceRoot, runRoot, evaluation, metrics),
    provenance: portableClosure(provenanceIdentity(sourceRoot, runRoot), sourceRoot),
    sourceFiles: runSourceFiles,
    omittedPayloads: runSourceFiles
      .filter((file) => [
        "captured.events.jsonl",
        "kickoff.txt",
        "process-stdout.txt",
        "process-stderr.txt",
        "session-creation.json",
        "staging.json"
      ].includes(file.path.slice(runRoot.length + 1)))
      .map((file) => file.path),
    deviations: {
      closure: closed.measuredEvidenceDeviations,
      attempt: closed.attemptDeviations,
      retryCount: closed.retryCount
    }
  };
  if (planned.armId === 0) {
    bundle.deterministic = {
      execution: readRun("execution.json"),
      lifecycleEnd: readRun("lifecycle-end.json")
    };
  } else {
    const localEvidence = readRun("local-evidence.json");
    bundle.attemptStart = portableClosure(readRun("attempt-start.json"), sourceRoot);
    bundle.attempt = portableClosure(readRun("attempt-1.json"), sourceRoot);
    bundle.runManifest = portableClosure(readRun("run-manifest.json"), sourceRoot);
    bundle.modelPreflight = readRun("model-preflight.json");
    bundle.sessionIdentity = sessionIdentity(sourceRoot, runRoot);
    bundle.candidateIdentity = portableClosure(
      candidateIdentity(sourceRoot, runRoot),
      sourceRoot
    );
    bundle.localEvidence = localEvidence;
    bundle.usage = localEvidence.usage;
    bundle.operationalUsage = localEvidence.operationalUsage;
  }
  return bundle;
}

function assertNoSensitiveContent(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveContent(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && isMachinePrivatePath(value)) {
      throw new Error(`Machine-private path remains at ${path}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`Prohibited opaque or sensitive field remains at ${path}.${key}`);
    }
    assertNoSensitiveContent(child, `${path}.${key}`);
  }
}

function qualityEndpoints(metrics) {
  const { promotion, coverage, mutation, diversity } = metrics.metrics;
  return {
    promotionRate: promotion.promotionRate,
    structuralValidityRate: promotion.submittedCases === 0
      ? 0
      : promotion.promotedCases / promotion.submittedCases,
    tracedRuleCount: coverage.rules.exercised,
    ruleCoverage: coverage.rules.rate,
    tracedPathCount: coverage.paths.exercised,
    pathCoverage: coverage.paths.rate,
    tracedInvariantCount: coverage.invariants.exercised,
    invariantCoverage: coverage.invariants.rate,
    tracedDiagnosticCount: coverage.diagnostics.categories.length,
    diagnosticCoverage: coverage.diagnostics.rate,
    killedMutants: mutation.killed,
    mutantKillRate: mutation.killRate,
    ...diversity
  };
}

function operationalMeasurement(value, reason) {
  return Number.isFinite(value) && value >= 0
    ? { available: true, value, reason: null }
    : { available: false, value: null, reason };
}

function expectedOperationalMetrics(bundle) {
  if (bundle.armId === 0) {
    return Object.fromEntries([
      "aiCredits", "nanoAiu", "inputTokens", "outputTokens", "modelTokens",
      "completionCount", "durationMs", "toolCallCount", "toolResultCount"
    ].map((name) => [name, operationalMeasurement(0, null)]));
  }
  const total = bundle.localEvidence.operationalUsage.total;
  return {
    aiCredits: operationalMeasurement(total.aiCredits, "AI credits unavailable"),
    nanoAiu: operationalMeasurement(total.nanoAiu, "nano-AIU unavailable"),
    inputTokens: operationalMeasurement(total.inputTokens, "input tokens unavailable"),
    outputTokens: operationalMeasurement(total.outputTokens, "output tokens unavailable"),
    modelTokens: operationalMeasurement(total.modelTokens, "model tokens unavailable"),
    completionCount: operationalMeasurement(
      total.completionCount,
      "completion count unavailable"
    ),
    durationMs: operationalMeasurement(total.durationMs, "duration unavailable"),
    toolCallCount: operationalMeasurement(
      bundle.localEvidence.tools.callCount,
      "tool call count unavailable"
    ),
    toolResultCount: operationalMeasurement(
      bundle.localEvidence.tools.resultCount,
      "tool result count unavailable"
    )
  };
}

function expectedEndpoints(bundle) {
  const actual = bundle.analysis.descriptiveRun.endpoints;
  const expected = Object.fromEntries(Object.keys(actual).map((name) => [name, null]));
  Object.assign(expected, qualityEndpoints(bundle.metrics));
  if (bundle.armId === 0) {
    for (const name of Object.keys(expected)) {
      if (!(name in qualityEndpoints(bundle.metrics))) expected[name] = 0;
    }
    expected.wallMs = bundle.deterministic.execution.wallMs;
    return expected;
  }

  for (const role of ["parent", "worker", "total"]) {
    const usage = bundle.localEvidence.usage[role];
    for (const [suffix, field] of [
      ["AiCredits", "aiCredits"],
      ["PremiumRequests", "premiumRequests"],
      ["NanoAiu", "nanoAiu"],
      ["InputTokens", "inputTokens"],
      ["OutputTokens", "outputTokens"],
      ["CacheReadTokens", "cacheReadTokens"],
      ["CacheWriteTokens", "cacheWriteTokens"],
      ["CachedTokens", "cachedTokens"],
      ["ReasoningTokens", "reasoningTokens"],
      ["ModelTokens", "modelTokens"],
      ["RequestMultiplier", "requestMultiplier"],
      ["DurationMs", "durationMs"],
      ["MeanTimeToFirstTokenMs", "meanTimeToFirstTokenMs"],
      ["MeanInterTokenLatencyMs", "meanInterTokenLatencyMs"],
      ["CompletionCount", "completionCount"]
    ]) {
      expected[`${role}${suffix}`] = usage[field];
    }
  }
  const evidence = bundle.localEvidence;
  Object.assign(expected, {
    operationalTotalAiCredits: evidence.operationalUsage.total.aiCredits,
    operationalTotalNanoAiu: evidence.operationalUsage.total.nanoAiu,
    operationalTotalModelTokens: evidence.operationalUsage.total.modelTokens,
    operationalTotalCompletionCount: evidence.operationalUsage.total.completionCount,
    parentCumulativeInputTokens: evidence.parentContext.cumulativeInputTokens,
    parentPeakInputTokens: evidence.parentContext.peakInputTokens,
    toolSchemaCount: evidence.tools.schemas.count,
    toolCallCount: evidence.tools.callCount,
    toolResultCount: evidence.tools.resultCount,
    toolResultBytes: evidence.tools.resultBytes,
    compactReturnBytes: evidence.delegation.compactReturnBytes,
    compactionCount: evidence.events.compactionCount,
    wallMs: evidence.timing.wallMs,
    parentActiveMs: evidence.timing.parentActiveMs,
    workerActiveMs: evidence.timing.workerActiveMs,
    parentWaitMs: evidence.timing.parentWaitMs,
    sessionEvidenceAvailable: evidence.availability.session.status === "available" ? 1 : 0,
    modelEvidenceAvailable: evidence.availability.model.status === "available" ? 1 : 0,
    mechanismEvidenceAvailable: evidence.availability.mechanism.status === "available" ? 1 : 0,
    deviationCount: evidence.deviations.length
  });
  return expected;
}

function assertBundleAnalysis(bundle) {
  const run = bundle.analysis.descriptiveRun;
  const unit = bundle.analysis.unitRecord;
  assert.equal(run.runId, bundle.runId);
  assert.equal(run.blockId, bundle.blockId);
  assert.equal(run.armId, bundle.armId);
  assert.equal(unit.runId, bundle.runId);
  assert.equal(unit.blockId, bundle.blockId);
  assert.equal(unit.armId, bundle.armId);
  assert.equal(
    unit.status,
    bundle.disposition.status === "measured-failure" ? "measured-failure" : "eligible"
  );
  if (bundle.disposition.status === "measured-failure") {
    assert.equal(unit.reason, bundle.disposition.reason);
    assert.equal(unit.evidenceKind, bundle.disposition.evidenceKind);
  } else {
    assert.equal(unit.reason, null);
  }
  assert.deepEqual(run.outcome, bundle.metrics.outcome);
  assert.deepEqual(unit.outcome, bundle.metrics.outcome);
  assert.deepEqual(run.endpoints, expectedEndpoints(bundle));
  assert.deepEqual(unit.operationalMetrics, expectedOperationalMetrics(bundle));
}

function assertSourceBinding(binding, sourceByPath, expectedPath = binding.path) {
  assert.equal(binding.path, expectedPath);
  const source = sourceByPath.get(expectedPath);
  assert.ok(source, `Missing pinned source binding for ${expectedPath}`);
  assert.equal(binding.bytes, source.bytes);
  assert.equal(binding.sha256, source.sha256);
}

function assertExactSourceRecord(record, sourceByPath, path) {
  const source = sourceByPath.get(path);
  assert.ok(source, `Missing pinned exact source record ${path}`);
  const bytes = canonicalBytes(record);
  assert.equal(bytes.length, source.bytes, `Exact source byte count differs for ${path}`);
  assert.equal(sha256(bytes), source.sha256, `Exact source hash differs for ${path}`);
}

function assertBundleSourceAuthentication(bundle, sourceByPath, planned) {
  const runRoot = `artifacts/${bundle.runId}`;
  assert.deepEqual(
    bundle.sourceFiles,
    [...sourceByPath.values()].filter((file) => file.path.startsWith(`${runRoot}/`))
  );
  for (const binding of bundle.sourceFiles) {
    assertSourceBinding(binding, sourceByPath);
  }

  for (const [record, name] of [
    [bundle.lifecycleStart, "lifecycle-start.json"],
    [bundle.startCapture, "start-capture.json"],
    [bundle.metrics, "metrics.json"]
  ]) {
    assertExactSourceRecord(record, sourceByPath, `${runRoot}/${name}`);
  }
  assertSourceBinding(bundle.evaluation.source, sourceByPath);
  assertSourceBinding(bundle.stagingEvidence.source, sourceByPath);
  assertSourceBinding(bundle.provenance.source, sourceByPath);
  assert.equal(bundle.evaluation.record.runId, bundle.runId);
  assert.equal(bundle.evaluation.record.blockId, bundle.blockId);
  assert.equal(bundle.evaluation.record.armId, bundle.armId);
  assert.equal(bundle.evaluation.record.metricsSha256,
    sourceByPath.get(`${runRoot}/metrics.json`).sha256);
  assert.equal(bundle.evaluation.record.snapshotSha256,
    sourceByPath.get(`${runRoot}/staging.json`).sha256);
  assert.equal(bundle.evaluation.record.disposition, bundle.metrics.outcome.disposition);
  assert.equal(bundle.evaluation.record.retryCount, 0);

  if (bundle.disposition.status === "measured-failure") {
    assertExactSourceRecord(
      bundle.disposition,
      sourceByPath,
      `${runRoot}/unit-disposition.json`
    );
    assert.equal(bundle.disposition.metricsSha256,
      sourceByPath.get(`${runRoot}/metrics.json`).sha256);
    assert.equal(bundle.disposition.evaluationSha256,
      sourceByPath.get(`${runRoot}/evaluation.json`).sha256);
  }

  if (bundle.armId === 0) {
    assertExactSourceRecord(
      bundle.deterministic.execution,
      sourceByPath,
      `${runRoot}/execution.json`
    );
    assertExactSourceRecord(
      bundle.deterministic.lifecycleEnd,
      sourceByPath,
      `${runRoot}/lifecycle-end.json`
    );
    assert.equal(bundle.scheduledSessionId, null);
    return;
  }

  for (const [record, name] of [
    [bundle.attemptStart, "attempt-start.json"],
    [bundle.attempt, "attempt-1.json"],
    [bundle.runManifest, "run-manifest.json"],
    [bundle.modelPreflight, "model-preflight.json"],
    [bundle.localEvidence, "local-evidence.json"]
  ]) {
    assertExactSourceRecord(record, sourceByPath, `${runRoot}/${name}`);
  }
  assertSourceBinding(bundle.sessionIdentity.source, sourceByPath);
  assertSourceBinding(bundle.candidateIdentity.source, sourceByPath);
  for (const value of Object.values(bundle.localEvidence.source)) {
    for (const binding of Array.isArray(value) ? value : [value]) {
      if (!binding) continue;
      assertSourceBinding(
        { ...binding, path: `${runRoot}/${binding.path}` },
        sourceByPath
      );
    }
  }

  const { attempt, runManifest, localEvidence, sessionIdentity, candidateIdentity } = bundle;
  assert.equal(bundle.scheduledSessionId, planned.sessionId);
  assert.equal(attempt.attemptId, `${bundle.runId}-attempt-1`);
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(runManifest.attemptNumber, 1);
  assert.equal(attempt.cliSessionId, planned.sessionId);
  assert.equal(runManifest.cliSessionId, planned.sessionId);
  assert.equal(localEvidence.identity.cliSessionId, planned.sessionId);
  assert.equal(sessionIdentity.request.sessionId, planned.sessionId);
  assert.equal(sessionIdentity.response.resultSessionId, planned.sessionId);
  assert.equal(attempt.runId, bundle.runId);
  assert.equal(runManifest.runId, bundle.runId);
  assert.equal(localEvidence.runId, bundle.runId);
  assert.equal(attempt.treatment.blockId, bundle.blockId);
  assert.equal(attempt.treatment.armId, bundle.armId);
  assert.equal(attempt.treatment.seed, planned.seed);
  assert.equal(runManifest.blockId, bundle.blockId);
  assert.equal(runManifest.armId, bundle.armId);
  assert.equal(runManifest.seed, planned.seed);
  assert.equal(runManifest.globalOrder, bundle.globalOrder);
  assert.equal(attempt.treatment.sourceCommit, runManifest.sourceCommit);
  assert.equal(attempt.treatment.sourceTree, runManifest.sourceTree);
  assert.equal(localEvidence.identity.sourceCommit, runManifest.sourceCommit);
  assert.equal(localEvidence.identity.sourceTree, runManifest.sourceTree);
  assert.equal(candidateIdentity.sourceCommit, runManifest.sourceCommit);
  assert.equal(candidateIdentity.sourceTree, runManifest.sourceTree);
  assert.equal(attempt.treatment.terminalCommit, runManifest.terminalCommit);
  assert.equal(localEvidence.identity.terminalCommit, runManifest.terminalCommit);
  assert.equal(sessionIdentity.request.candidateCommit, runManifest.terminalCommit);
  assert.equal(attempt.treatment.candidateSnapshotSha256,
    runManifest.candidateSnapshotSha256);
  assert.equal(localEvidence.identity.candidateSnapshotSha256,
    runManifest.candidateSnapshotSha256);
  assert.equal(candidateIdentity.source.sha256, runManifest.candidateSnapshotSha256);
  assert.equal(bundle.modelPreflight.evidenceSha256,
    sourceByPath.get(`${runRoot}/local-evidence.json`).sha256);
  assert.equal(bundle.evaluation.record.localEvidenceSha256,
    sourceByPath.get(`${runRoot}/local-evidence.json`).sha256);
  assert.equal(bundle.evaluation.record.modelPreflightSha256,
    sourceByPath.get(`${runRoot}/model-preflight.json`).sha256);
  assert.deepEqual(bundle.usage, localEvidence.usage);
  assert.deepEqual(bundle.operationalUsage, localEvidence.operationalUsage);
}

function assertEmittedPrivacy(outputRoot) {
  for (const file of walkSourceFiles(outputRoot)) {
    const path = resolve(outputRoot, file.path);
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    if (file.path.endsWith(".json")) {
      assertNoSensitiveContent(JSON.parse(text), file.path);
    } else if (PRIVATE_PATH_TEXT.test(text)) {
      throw new Error(`Machine-private path remains in emitted file ${file.path}`);
    }
  }
}

function packageFileManifest(outputRoot) {
  return walkSourceFiles(outputRoot)
    .filter((file) => file.path !== "manifest.json")
    .map(({ kind: _kind, ...file }) => file);
}

function readme(closure) {
  const armRows = closure.outcomes.byArm.map((arm) =>
    `| ${arm.armId} | ${arm.runs} | ${arm.success} | ${arm.measuredFailure} | ${arm.treatmentPass} | ${arm.operationalPass} |`)
    .join("\n");
  return `# Protocol-v5 B01 evidence

Portable, sanitized, unsigned local evidence for the 72-unit
\`semantic-test-corpus-execution-v5\` descriptive ITT execution.

| Arm | Started | Success | Measured failure | Treatment-adherent | Operational success |
|---:|---:|---:|---:|---:|---:|
${armRows}

- Canonical descriptive input: \`analysis/descriptive-input.json\`
- Machine-readable descriptive results: \`analysis/descriptive-results.json\`
- Compact per-run evidence: \`raw/runs/\`
- Immutable start index and portable closure: \`raw/\`
- Full external source content binding: \`raw/external-source-manifest.json\`

Inference and significance are unavailable. The evidence is local, unsigned,
descriptive only, and does not establish causality, compliance, or population
generalization. Full candidate worktrees, staging payloads, prompts, raw JSONL
events, and opaque payloads are not committed; their source bytes remain bound
by SHA-256 manifests.
`;
}

function analysisAvailability() {
  return {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    descriptive: {
      status: "available",
      method: "descriptive-point-estimates-and-within-block-pairs-only"
    },
    inference: {
      status: "unavailable",
      reason: "Protocol v5 permits descriptive ITT analysis only; evidence is local and unsigned."
    },
    limitations: [
      "No significance, causal, compliance, or population-generalization claims are supported.",
      "Full candidate worktrees, staging documents, prompts, and raw JSONL events remain external.",
      "Unavailable telemetry fields remain explicit null values with per-run availability reasons."
    ]
  };
}

export function regenerateDescriptiveResults(outputRoot) {
  const bundles = readdirSync(resolve(outputRoot, "raw", "runs"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(resolve(outputRoot, "raw", "runs", name)))
    .sort((left, right) => left.globalOrder - right.globalOrder);
  const input = {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    runs: bundles.map((bundle) => bundle.analysis.descriptiveRun)
  };
  const unitRecords = bundles.map((bundle) => bundle.analysis.unitRecord);
  const schemaErrors = validateJsonSchema(input, descriptiveInputSchema, {
    schemaDir: schemaRoot
  });
  assert.deepEqual(schemaErrors, []);
  assert.equal(input.runs.length, 72);
  assert.equal(unitRecords.length, 72);
  Object.defineProperty(input.runs, "unitRecords", {
    value: unitRecords,
    enumerable: false
  });
  return summarizeDescriptive(input.runs);
}

export function verifyEvidencePackage(outputRoot = packageRoot) {
  const manifest = readJson(resolve(outputRoot, "manifest.json"));
  assert.equal(manifest.protocolId, PROTOCOL_ID);
  assert.equal(manifest.counts.scheduledUnits, 72);
  assert.equal(manifest.counts.aiUnits, 60);
  assert.equal(manifest.counts.deterministicUnits, 12);
  assert.equal(manifest.counts.blocks, 12);
  assert.equal(manifest.source.startIndexSha256, START_INDEX_SHA256);
  assert.equal(manifest.source.closureSha256, CLOSURE_SHA256);
  assert.equal(manifest.inference.status, "unavailable");

  const observedFiles = packageFileManifest(outputRoot);
  assert.deepEqual(observedFiles, manifest.files);
  assert.equal(aggregateFileManifest(observedFiles.map((file) => ({
    ...file,
    kind: "file"
  }))), manifest.packageSha256);

  const sourceManifest = readJson(resolve(
    outputRoot,
    "raw",
    "external-source-manifest.json"
  ));
  assert.equal(sourceManifest.fileCount, sourceManifest.files.length);
  assert.equal(sourceManifest.aggregateSha256, aggregateFileManifest(sourceManifest.files));
  assert.equal(sourceManifest.aggregateSha256, SOURCE_AGGREGATE_SHA256);
  assert.equal(sourceManifest.fileCount, SOURCE_FILE_COUNT);
  assert.equal(sourceManifest.totalBytes, SOURCE_TOTAL_BYTES);
  assert.equal(manifest.source.aggregateSha256, sourceManifest.aggregateSha256);
  assert.equal(manifest.source.fileCount, sourceManifest.fileCount);
  assert.equal(manifest.source.totalBytes, sourceManifest.totalBytes);
  const sourceByPath = new Map(sourceManifest.files.map((file) => [file.path, file]));
  assert.equal(
    sourceManifest.files.find((file) => file.path === "artifacts/start-index.json")?.sha256,
    START_INDEX_SHA256
  );
  assert.equal(
    sourceManifest.files.find((file) =>
      file.path === "artifacts/execution-closure-v5.json")?.sha256,
    CLOSURE_SHA256
  );

  const startIndexBytes = readFileSync(resolve(outputRoot, "raw", "start-index.json"));
  assert.equal(sha256(startIndexBytes), START_INDEX_SHA256);
  assert.equal(
    readFileSync(resolve(outputRoot, "raw", "start-index.json.sha256"), "utf8"),
    `${START_INDEX_SHA256}\n`
  );
  const startIndex = JSON.parse(startIndexBytes);
  assert.deepEqual(validateStartOrder(startIndex, { requireComplete: true }), []);

  const runFiles = readdirSync(resolve(outputRoot, "raw", "runs"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(runFiles.length, 72);
  const bundles = runFiles.map((name) =>
    readJson(resolve(outputRoot, "raw", "runs", name)))
    .sort((left, right) => left.globalOrder - right.globalOrder);
  const schedule = readJson(schedulePath);
  assert.equal(new Set(bundles.map((run) => run.runId)).size, 72);
  assert.equal(bundles.filter((run) => run.armId === 0).length, 12);
  assert.equal(bundles.filter((run) => run.armId !== 0).length, 60);
  assert.equal(bundles.filter((run) =>
    run.disposition.status === "measured-failure").length, 39);
  assert.equal(bundles.filter((run) => run.armId !== 0
    && run.attempt?.attemptNumber === 1
    && run.deviations.retryCount === 0).length, 60);
  assert.equal(bundles.filter((run) => run.armId !== 0
    && run.usage?.total?.completionCount > 0).length, 60);
  assert.equal(bundles.filter((run) => run.armId === 0
    && run.deterministic?.execution).length, 12);
  for (const [index, bundle] of bundles.entries()) {
    assertNoSensitiveContent(bundle);
    assertBundleAnalysis(bundle);
    assert.equal(bundle.runId, schedule.runs[index].runId);
    assertBundleSourceAuthentication(bundle, sourceByPath, schedule.runs[index]);
  }

  const committedInput = readJson(resolve(
    outputRoot,
    "analysis",
    "descriptive-input.json"
  ));
  const committedUnits = readJson(resolve(
    outputRoot,
    "analysis",
    "unit-records.json"
  ));
  assert.deepEqual(
    committedInput,
    {
      formatVersion: 1,
      protocolId: PROTOCOL_ID,
      runs: bundles.map((bundle) => bundle.analysis.descriptiveRun)
    }
  );
  assert.deepEqual(
    committedUnits,
    {
      formatVersion: 1,
      protocolId: PROTOCOL_ID,
      runs: bundles.map((bundle) => bundle.analysis.unitRecord)
    }
  );

  const regenerated = regenerateDescriptiveResults(outputRoot);
  const committed = readFileSync(resolve(
    outputRoot,
    "analysis",
    "descriptive-results.json"
  ));
  assert.ok(canonicalBytes(regenerated).equals(committed));
  assert.equal(regenerated.completeBlocks.length, 12);
  assert.equal(regenerated.measuredFailures.length, 39);
  assert.equal(regenerated.outcomes.runs.length, 72);
  assert.equal(regenerated.analysis, "descriptive-point-estimates-and-within-block-pairs-only");
  const closure = readJson(resolve(outputRoot, "raw", "closure.json")).closure;
  assert.deepEqual(manifest.counts, {
    scheduledUnits: bundles.length,
    aiUnits: bundles.filter((run) => run.armId !== 0).length,
    deterministicUnits: bundles.filter((run) => run.armId === 0).length,
    measuredFailures: bundles.filter((run) =>
      run.disposition.status === "measured-failure").length,
    blocks: new Set(bundles.map((run) => run.blockId)).size,
    completeBlocks: regenerated.completeBlocks.length,
    retries: bundles.reduce((sum, run) => sum + run.deviations.retryCount, 0),
    missingSlots: schedule.runs.length - bundles.length,
    protocolDeviations: closure.protocolDeviations.length
  });
  assertEmittedPrivacy(outputRoot);
  return {
    files: manifest.files.length + 1,
    sourceFiles: sourceManifest.fileCount,
    runs: bundles.length,
    measuredFailures: regenerated.measuredFailures.length,
    completeBlocks: regenerated.completeBlocks.length
  };
}

export function generateEvidencePackage(sourceRoot, outputRoot = packageRoot) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedOutputRoot = resolve(outputRoot);
  assert.ok(existsSync(resolvedSourceRoot), "External source evidence root is missing");
  assert.ok(!pathsOverlap(resolvedSourceRoot, resolvedOutputRoot),
    "Output and immutable source evidence must not overlap");
  assert.ok(!pathsOverlap(repositoryRoot, resolvedSourceRoot),
    "Measured evidence source must remain external to the repository");

  const artifactsRoot = resolve(resolvedSourceRoot, "artifacts");
  const startIndexPath = resolve(artifactsRoot, "start-index.json");
  const closurePath = resolve(artifactsRoot, "execution-closure-v5.json");
  const startIndexBytes = readFileSync(startIndexPath);
  const closureBytes = readFileSync(closurePath);
  assert.equal(sha256(startIndexBytes), START_INDEX_SHA256);
  assert.equal(sha256(closureBytes), CLOSURE_SHA256);
  assert.equal(readFileSync(`${startIndexPath}.sha256`, "utf8"), `${START_INDEX_SHA256}\n`);
  assert.equal(readFileSync(`${closurePath}.sha256`, "utf8"), `${CLOSURE_SHA256}\n`);

  const closure = JSON.parse(closureBytes);
  const startIndex = JSON.parse(startIndexBytes);
  const schedule = readJson(schedulePath);
  const sourcePin = readJson(sourcePinPath);
  assertSourceClosure(resolvedSourceRoot, closure, startIndex, schedule, sourcePin);

  const artifacts = descriptiveArtifactManifest(resolvedSourceRoot, schedule, closure);
  const runs = buildDescriptiveRuns(artifacts, resolvedSourceRoot);
  const unitRecords = runs.unitRecords;
  const descriptiveInput = {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    runs: runs.map((run) => ({ ...run }))
  };
  const schemaErrors = validateJsonSchema(descriptiveInput, descriptiveInputSchema, {
    schemaDir: schemaRoot
  });
  assert.deepEqual(schemaErrors, []);
  const descriptiveResults = summarizeDescriptive(runs);
  assert.equal(descriptiveResults.completeBlocks.length, 12);
  assert.equal(descriptiveResults.measuredFailures.length, 39);
  assert.equal(descriptiveResults.outcomes.runs.length, 72);

  const sourceFiles = walkSourceFiles(resolvedSourceRoot);
  const sourceManifest = {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    rootLabel: "semantic-corpus-v5-b01",
    fileCount: sourceFiles.length,
    totalBytes: sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
    aggregateSha256: aggregateFileManifest(sourceFiles),
    files: sourceFiles
  };
  assert.equal(sourceManifest.aggregateSha256, SOURCE_AGGREGATE_SHA256);
  assert.equal(sourceManifest.fileCount, SOURCE_FILE_COUNT);
  assert.equal(sourceManifest.totalBytes, SOURCE_TOTAL_BYTES);
  assert.equal(
    sourceFiles.find((file) => file.path === "artifacts/start-index.json")?.sha256,
    START_INDEX_SHA256
  );
  assert.equal(
    sourceFiles.find((file) =>
      file.path === "artifacts/execution-closure-v5.json")?.sha256,
    CLOSURE_SHA256
  );
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));

  const temporaryRoot = `${resolvedOutputRoot}.tmp-${process.pid}`;
  rmSync(temporaryRoot, { recursive: true, force: true });
  mkdirSync(resolve(temporaryRoot, "raw", "runs"), { recursive: true });
  mkdirSync(resolve(temporaryRoot, "analysis"), { recursive: true });
  writeFileSync(resolve(temporaryRoot, "README.md"), readme(closure), { flag: "wx" });
  writeFileSync(resolve(temporaryRoot, "raw", "start-index.json"), startIndexBytes, {
    flag: "wx"
  });
  writeFileSync(
    resolve(temporaryRoot, "raw", "start-index.json.sha256"),
    `${START_INDEX_SHA256}\n`,
    { flag: "wx" }
  );
  writeCanonical(resolve(temporaryRoot, "raw", "closure.json"), {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    sourceSha256: CLOSURE_SHA256,
    sanitization: {
      machinePrivatePaths: "portable-relative-or-redacted",
      sourceBytesCommitted: false
    },
    closure: portableClosure(closure, resolvedSourceRoot)
  });
  const preflightPath = resolve(resolvedSourceRoot, "preflight", "execution-preflight.json");
  const preflightBytes = readFileSync(preflightPath);
  writeCanonical(resolve(temporaryRoot, "raw", "execution-preflight.json"), {
    formatVersion: 1,
    sourceSha256: sha256(preflightBytes),
    sourceBytesCommitted: false,
    preflight: portableExecutionPreflight(JSON.parse(preflightBytes))
  });
  writeFileSync(
    resolve(temporaryRoot, "raw", "mcp-probe.json"),
    readFileSync(resolve(resolvedSourceRoot, "preflight", "mcp-probe.json")),
    { flag: "wx" }
  );
  writeCanonical(
    resolve(temporaryRoot, "raw", "external-source-manifest.json"),
    sourceManifest
  );

  const bundles = [];
  for (const [index, planned] of schedule.runs.entries()) {
    const closed = closure.runs[index];
    const bundle = buildRunBundle(
      resolvedSourceRoot,
      sourceFiles,
      planned,
      closed,
      runs[index],
      unitRecords[index]
    );
    assertNoSensitiveContent(bundle);
    assertBundleAnalysis(bundle);
    assertBundleSourceAuthentication(bundle, sourceByPath, planned);
    bundles.push(bundle);
    writeCanonical(
      resolve(temporaryRoot, "raw", "runs", `${planned.runId}.json`),
      bundle
    );
  }
  assert.deepEqual(
    descriptiveInput.runs,
    bundles.map((bundle) => bundle.analysis.descriptiveRun)
  );
  assert.deepEqual(
    unitRecords,
    bundles.map((bundle) => bundle.analysis.unitRecord)
  );
  writeCanonical(
    resolve(temporaryRoot, "analysis", "descriptive-input.json"),
    descriptiveInput
  );
  writeCanonical(resolve(temporaryRoot, "analysis", "unit-records.json"), {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    runs: unitRecords
  });
  writeCanonical(
    resolve(temporaryRoot, "analysis", "descriptive-results.json"),
    descriptiveResults
  );
  writeCanonical(
    resolve(temporaryRoot, "analysis", "availability.json"),
    analysisAvailability()
  );
  assertEmittedPrivacy(temporaryRoot);

  const files = packageFileManifest(temporaryRoot);
  const manifest = {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    source: {
      startIndexSha256: START_INDEX_SHA256,
      closureSha256: CLOSURE_SHA256,
      aggregateSha256: sourceManifest.aggregateSha256,
      fileCount: sourceManifest.fileCount,
      totalBytes: sourceManifest.totalBytes
    },
    counts: {
      scheduledUnits: 72,
      aiUnits: 60,
      deterministicUnits: 12,
      measuredFailures: 39,
      blocks: 12,
      completeBlocks: 12,
      retries: 0,
      missingSlots: 0,
      protocolDeviations: 0
    },
    inference: analysisAvailability().inference,
    privacy: {
      committedRawEvents: false,
      committedCandidateWorktrees: false,
      committedStagingPayloads: false,
      committedPrompts: false,
      committedOpaquePayloads: false,
      portablePathsOnly: true
    },
    packageSha256: aggregateFileManifest(files.map((file) => ({
      ...file,
      kind: "file"
    }))),
    files
  };
  writeCanonical(resolve(temporaryRoot, "manifest.json"), manifest);

  rmSync(resolvedOutputRoot, { recursive: true, force: true });
  mkdirSync(dirname(resolvedOutputRoot), { recursive: true });
  renameSync(temporaryRoot, resolvedOutputRoot);
  return verifyEvidencePackage(resolvedOutputRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = resolve(argument(process.argv, "--out") ?? packageRoot);
  if (process.argv.includes("--verify")) {
    const result = verifyEvidencePackage(outputRoot);
    process.stdout.write(
      `${result.runs} packaged runs verified; ${result.completeBlocks} complete blocks; `
      + `${result.measuredFailures} measured failures retained\n`
    );
  } else {
    const sourceRoot = argument(process.argv, "--source-root");
    if (!sourceRoot) {
      throw new Error(
        "Usage: node scripts/package-v5-evidence.mjs --source-root <immutable-root> "
        + "[--out <package-root>]"
      );
    }
    const result = await generateEvidencePackage(sourceRoot, outputRoot);
    process.stdout.write(
      `${result.runs} runs packaged from ${result.sourceFiles} source files; `
      + `${result.completeBlocks} complete blocks\n`
    );
  }
}
