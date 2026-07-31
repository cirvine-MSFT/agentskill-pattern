#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { canonicalMetricsBytes, deriveMetricsArtifact } from "./metrics.mjs";
import { canonicalStagingBytes, verifyLocalSnapshotWrites } from "./adapter.mjs";
import { preflightLocalModel } from "../scripts/preflight-local-model.mjs";
import { validateExecutionRecords } from "../scripts/validate-execution-records.mjs";
import { validateLocalEvidence } from "../scripts/validate-local-evidence.mjs";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(evaluatorRoot, "..");
const schemaRoot = resolve(root, "schemas");
const inputSchema = JSON.parse(readFileSync(resolve(schemaRoot, "descriptive-input.schema.json"), "utf8"));
const artifactSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "descriptive-artifacts.schema.json"), "utf8")
);
const deterministicSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "deterministic-execution.schema.json"), "utf8")
);
const evaluationSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "evaluation-record.schema.json"), "utf8")
);
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const contrastContract = JSON.parse(
  readFileSync(resolve(root, "design", "descriptive-contrasts.json"), "utf8")
);
const endpointNames = Object.keys(
  inputSchema.properties.runs.items.properties.endpoints.properties
);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function point(values) {
  return {
    n: values.length,
    mean: values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values)
  };
}

function registeredContrasts(runs, endpointNames) {
  return contrastContract.contrasts.flatMap((definition) =>
    endpointNames.map((endpoint) => {
      const blockValues = [];
      for (let block = 1; block <= 12; block += 1) {
        const blockId = `B${String(block).padStart(2, "0")}`;
        const terms = Object.entries(definition.coefficients).map(([armId, coefficient]) => ({
          coefficient,
          value: runs.find((run) =>
            run.blockId === blockId && run.armId === Number(armId))?.endpoints[endpoint]
        }));
        if (terms.every((term) => Number.isFinite(term.value))) {
          blockValues.push({
            blockId,
            value: terms.reduce((sum, term) => sum + term.coefficient * term.value, 0)
          });
        }
      }
      return {
        id: definition.id,
        label: definition.label,
        endpoint,
        coefficients: definition.coefficients,
        ...point(blockValues.map((entry) => entry.value)),
        blockValues
      };
    })
  );
}

function emptyEndpoints() {
  return Object.fromEntries(endpointNames.map((name) => [name, null]));
}

function qualityEndpoints(artifact) {
  const { promotion, coverage, mutation, diversity } = artifact.metrics;
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

function usageEndpoints(evidence) {
  const output = {};
  for (const role of ["parent", "worker", "total"]) {
    const usage = evidence.usage[role];
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
      output[`${role}${suffix}`] = usage[field];
    }
  }
  return output;
}

function readExecutionRecords(evidence, evidencePath) {
  const artifactRoot = dirname(evidencePath);
  const manifestPath = resolve(artifactRoot, evidence.source.runManifest.path);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const attempts = manifest.attempts.map((path) =>
    JSON.parse(readFileSync(resolve(artifactRoot, path), "utf8")));
  const preflights = manifest.preflights.map((path) =>
    JSON.parse(readFileSync(resolve(artifactRoot, path), "utf8")));
  const evidenceBytes = attempts.map((attempt) =>
    readFileSync(resolve(artifactRoot, attempt.localEvidencePath)));
  const preSessionFailures = manifest.preSessionFailures.map((path) =>
    JSON.parse(readFileSync(resolve(artifactRoot, path), "utf8")));
  const deviations = manifest.deviations.map((path) =>
    JSON.parse(readFileSync(resolve(artifactRoot, path), "utf8")));
  const errors = validateExecutionRecords({
    manifest,
    attempts,
    preflights,
    evidenceBytes,
    preSessionFailures,
    deviations
  });
  if (errors.length > 0) {
    throw new Error(`Execution records are invalid for ${evidence.runId}: ${errors[0]}`);
  }
  return { manifest, attempts, preflights, evidenceBytes, preSessionFailures };
}

export function buildDescriptiveRuns(input, artifactRoot) {
  const errors = validateJsonSchema(input, artifactSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Descriptive artifact manifest is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  const appSessions = new Set();
  const cliSessions = new Set();
  const runs = input.runs.map((definition) => {
    const planned = schedule.runs.find((run) => run.runId === definition.runId);
    if (!planned
      || planned.blockId !== definition.blockId
      || planned.armId !== definition.armId) {
      throw new Error(`Artifact identity differs from the frozen schedule: ${definition.runId}`);
    }
    const snapshotPath = resolve(artifactRoot, definition.snapshotPath);
    const metricsPath = resolve(artifactRoot, definition.metricsPath);
    const snapshotBytes = readFileSync(snapshotPath);
    const metricsBytes = readFileSync(metricsPath);
    const evaluation = JSON.parse(
      readFileSync(resolve(artifactRoot, definition.evaluationPath), "utf8")
    );
    const evaluationErrors = validateJsonSchema(evaluation, evaluationSchema, {
      schemaDir: schemaRoot
    });
    if (evaluationErrors.length > 0
      || evaluation.runId !== definition.runId
      || evaluation.blockId !== definition.blockId
      || evaluation.armId !== definition.armId
      || resolve(artifactRoot, evaluation.snapshotPath) !== snapshotPath
      || resolve(artifactRoot, evaluation.metricsPath) !== metricsPath
      || evaluation.snapshotSha256 !== sha256(snapshotBytes)
      || evaluation.metricsSha256 !== sha256(metricsBytes)) {
      throw new Error(`Evaluation record is not bound to exact run artifacts: ${definition.runId}`);
    }
    const metrics = deriveMetricsArtifact(snapshotBytes, definition);
    if (!canonicalMetricsBytes(metrics).equals(metricsBytes)) {
      throw new Error(`Metrics artifact is not exact deterministic output: ${definition.runId}`);
    }
    const endpoints = {
      ...emptyEndpoints(),
      ...qualityEndpoints(metrics)
    };

    if (definition.armId === 0) {
      const executionBytes = readFileSync(resolve(artifactRoot, definition.executionPath));
      const execution = JSON.parse(executionBytes);
      const executionErrors = validateJsonSchema(execution, deterministicSchema, {
        schemaDir: schemaRoot
      });
      if (executionErrors.length > 0
        || execution.runId !== definition.runId
        || execution.blockId !== definition.blockId
        || evaluation.executionSha256 !== sha256(executionBytes)
        || execution.stagingSha256 !== metrics.snapshotSha256
        || !canonicalStagingBytes(JSON.parse(snapshotBytes)).equals(snapshotBytes)) {
        throw new Error(`Deterministic execution is not bound to its exact snapshot: ${definition.runId}; ${JSON.stringify({
          executionErrors,
          executionRunId: execution.runId,
          executionBlockId: execution.blockId,
          executionShaMatches: evaluation.executionSha256 === sha256(executionBytes),
          snapshotShaMatches: execution.stagingSha256 === metrics.snapshotSha256,
          canonicalSnapshot: canonicalStagingBytes(JSON.parse(snapshotBytes)).equals(snapshotBytes)
        })}`);
      }
      if (evaluation.attemptId !== null
        || evaluation.localEvidenceSha256 !== null
        || evaluation.modelPreflightSha256 !== null) {
        throw new Error(`Baseline evaluation record cannot identify AI evidence: ${definition.runId}`);
      }
      Object.assign(endpoints, {
        parentAiCredits: 0,
        workerAiCredits: 0,
        totalAiCredits: 0,
        parentNanoAiu: 0,
        workerNanoAiu: 0,
        totalNanoAiu: 0,
        parentInputTokens: 0,
        workerInputTokens: 0,
        totalInputTokens: 0,
        parentOutputTokens: 0,
        workerOutputTokens: 0,
        totalOutputTokens: 0,
        parentCacheReadTokens: 0,
        workerCacheReadTokens: 0,
        totalCacheReadTokens: 0,
        parentCacheWriteTokens: 0,
        workerCacheWriteTokens: 0,
        totalCacheWriteTokens: 0,
        parentCachedTokens: 0,
        workerCachedTokens: 0,
        totalCachedTokens: 0,
        parentModelTokens: 0,
        workerModelTokens: 0,
        totalModelTokens: 0,
        parentCompletionCount: 0,
        workerCompletionCount: 0,
        totalCompletionCount: 0,
        parentCumulativeInputTokens: 0,
        parentPeakInputTokens: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        toolResultBytes: 0,
        wallMs: execution.wallMs,
        parentActiveMs: 0,
        workerActiveMs: 0,
        parentWaitMs: 0,
        deviationCount: 0
      });
    } else {
      const evidencePath = resolve(artifactRoot, definition.localEvidencePath);
      const evidenceBytes = readFileSync(evidencePath);
      const evidence = JSON.parse(evidenceBytes);
      const evidenceErrors = validateLocalEvidence(evidence, {
        artifactRoot: dirname(evidencePath),
        candidateRoot: resolve(artifactRoot, definition.candidateRoot)
      });
      if (evidenceErrors.length > 0
        || evidence.runId !== definition.runId
        || evidence.blockId !== definition.blockId
        || evidence.armId !== definition.armId) {
        throw new Error(`Local evidence is not bound to the artifact run: ${definition.runId}`);
      }
      if (evidence.availability.session.status !== "available"
        || evidence.availability.model.status !== "available"
        || evidence.availability.mechanism.status !== "available"
        || evidence.budgets.status !== "within-budget") {
        throw new Error(`Unavailable AI run must not be included in analysis: ${definition.runId}`);
      }
      verifyLocalSnapshotWrites(snapshotBytes, evidence);
      const preflightPath = resolve(artifactRoot, definition.modelPreflightPath);
      const preflightBytes = readFileSync(preflightPath);
      const preflight = JSON.parse(preflightBytes);
      const recomputedPreflight = preflightLocalModel(evidence, evidenceBytes);
      if (JSON.stringify(preflight) !== JSON.stringify(recomputedPreflight)
        || preflight.status !== "pass") {
        throw new Error(`Final model preflight is not an exact pass: ${definition.runId}`);
      }
      if (evaluation.localEvidenceSha256 !== sha256(evidenceBytes)
        || evaluation.modelPreflightSha256 !== sha256(preflightBytes)) {
        throw new Error(`Evaluation record is not bound to final evidence/preflight: ${definition.runId}`);
      }
      const records = readExecutionRecords(evidence, evidencePath);
      if (evaluation.attemptId !== records.attempts.at(-1)?.attemptId
        || evaluation.executionSha256 !== null
        || records.attempts.at(-1)?.status === "excluded") {
        throw new Error(`Evaluation record is not bound to the final eligible attempt: ${definition.runId}`);
      }
      if (resolve(dirname(evidencePath), records.manifest.preflights.at(-1)) !== preflightPath) {
        throw new Error(`Analysis preflight path differs from final execution record: ${definition.runId}`);
      }
      for (const [index, attempt] of records.attempts.entries()) {
        const attemptEvidence = JSON.parse(records.evidenceBytes[index]);
        const attemptEvidencePath = resolve(dirname(evidencePath), attempt.localEvidencePath);
        const attemptErrors = validateLocalEvidence(attemptEvidence, {
          artifactRoot: dirname(attemptEvidencePath),
          candidateRoot: resolve(artifactRoot, definition.candidateRoot)
        });
        if (attemptErrors.length > 0
          || attemptEvidence.runId !== definition.runId
          || attemptEvidence.attempt.attemptId !== attempt.attemptId
          || attemptEvidence.identity.appProjectSessionId !== attempt.appProjectSessionId
          || attemptEvidence.identity.cliSessionId !== attempt.cliSessionId) {
          throw new Error(`Attempt evidence is not source-bound to ${attempt.attemptId}`);
        }
        for (const [label, value, set] of [
          ["app project", attempt.appProjectSessionId, appSessions],
          ["CLI", attempt.cliSessionId, cliSessions]
        ]) {
          if (set.has(value)) throw new Error(`${label} session is reused across AI attempts: ${value}`);
          set.add(value);
        }
      }
      Object.assign(endpoints, usageEndpoints(evidence), {
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
    }
    return {
      runId: definition.runId,
      blockId: definition.blockId,
      armId: definition.armId,
      endpoints
    };
  });
  const internalInput = {
    formatVersion: 1,
    protocolId: "semantic-test-corpus-execution-v2",
    runs
  };
  const internalErrors = validateJsonSchema(internalInput, inputSchema, { schemaDir: schemaRoot });
  if (internalErrors.length > 0) {
    throw new Error(`Evaluator-built descriptive input is invalid: ${internalErrors[0].path} ${internalErrors[0].message}`);
  }
  return runs;
}

export function summarizeDescriptive(runs) {
  const seen = new Set();
  for (const run of runs) {
    const planned = schedule.runs.find((item) => item.runId === run.runId);
    if (!planned
      || planned.blockId !== run.blockId
      || planned.armId !== run.armId
      || seen.has(run.runId)) {
      throw new Error(`Run identity is duplicate or differs from the frozen schedule: ${run.runId}`);
    }
    seen.add(run.runId);
  }
  const endpointNames = [...new Set(runs.flatMap((run) => Object.keys(run.endpoints)))].sort();
  const armPoints = schedule.runs
    .map((run) => run.armId)
    .filter((armId, index, values) => values.indexOf(armId) === index)
    .sort((left, right) => left - right)
    .map((armId) => {
      const armRuns = runs.filter((run) => run.armId === armId);
      return {
        armId,
        planned: 12,
        observed: armRuns.length,
        endpoints: Object.fromEntries(endpointNames.map((endpoint) => [
          endpoint,
          {
            ...point(armRuns.map((run) => run.endpoints[endpoint]).filter(Number.isFinite)),
            blockValues: Array.from({ length: 12 }, (_, index) => {
              const blockId = `B${String(index + 1).padStart(2, "0")}`;
              return {
                blockId,
                value: armRuns.find((run) => run.blockId === blockId)?.endpoints[endpoint] ?? null
              };
            })
          }
        ]))
      };
    });
  const pairs = [];
  for (let armId = 1; armId <= 5; armId += 1) {
    for (const endpoint of endpointNames) {
      const blockPairs = [];
      for (let index = 1; index <= 12; index += 1) {
        const blockId = `B${String(index).padStart(2, "0")}`;
        const baseline = runs.find((run) => run.blockId === blockId && run.armId === 0)
          ?.endpoints[endpoint];
        const treatment = runs.find((run) => run.blockId === blockId && run.armId === armId)
          ?.endpoints[endpoint];
        if (Number.isFinite(baseline) && Number.isFinite(treatment)) {
          blockPairs.push({ blockId, baseline, treatment, difference: treatment - baseline });
        }
      }
      pairs.push({
        armId,
        endpoint,
        ...point(blockPairs.map((pair) => pair.difference)),
        blockPairs
      });
    }
  }
  return {
    formatVersion: 1,
    protocolId: "semantic-test-corpus-execution-v2",
    analysis: "descriptive-point-estimates-and-within-block-pairs-only",
    plannedRuns: 72,
    observedRuns: runs.length,
    unavailableRuns: schedule.runs
      .filter((planned) => !seen.has(planned.runId))
      .map((planned) => ({
        runId: planned.runId,
        blockId: planned.blockId,
        armId: planned.armId,
        reason: "No exact eligible artifact was supplied; unavailable runs are excluded"
      })),
    armPoints,
    pairs,
    registeredContrasts: registeredContrasts(runs, endpointNames)
  };
}

export function analyzeDescriptiveArtifacts(input, artifactRoot) {
  return summarizeDescriptive(buildDescriptiveRuns(input, artifactRoot));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = argument(process.argv, "--in");
  const outputPath = argument(process.argv, "--out");
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node evaluator/descriptive-v2.mjs --in <artifact-manifest.json> --out <summary.json>");
  }
  const resolvedInput = resolve(inputPath);
  const output = analyzeDescriptiveArtifacts(
    JSON.parse(readFileSync(resolvedInput, "utf8")),
    dirname(resolvedInput)
  );
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.observedRuns}/72 run units summarized descriptively\n`);
}
