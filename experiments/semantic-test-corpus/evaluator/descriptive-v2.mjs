#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { canonicalMetricsBytes, deriveMetricsArtifact } from "./metrics.mjs";
import { canonicalStagingBytes, verifyLocalSnapshotWrites } from "./adapter.mjs";
import { preflightLocalModel } from "../scripts/preflight-local-model.mjs";
import { validateExecutionRecords } from "../scripts/validate-execution-records.mjs";
import { validateLocalEvidence } from "../scripts/validate-local-evidence.mjs";
import { validateStartOrder } from "../scripts/validate-start-order.mjs";

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
const dispositionSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "unit-disposition.schema.json"), "utf8")
);
const partialUsageSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "partial-usage.schema.json"), "utf8")
);
const usageExportSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "local-usage-export.schema.json"), "utf8")
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

function targetDecisionRule(runs) {
  const rule = contrastContract.targetArmDecisionRule;
  const requiredComparableBlocks = rule.requiredComparableBlocks;
  const comparison = (endpoint, referenceArm) => {
    const pairs = [];
    for (let block = 1; block <= 12; block += 1) {
      const blockId = `B${String(block).padStart(2, "0")}`;
      const target = runs.find((run) =>
        run.blockId === blockId && run.armId === rule.armId)?.endpoints[endpoint];
      const reference = runs.find((run) =>
        run.blockId === blockId && run.armId === referenceArm)?.endpoints[endpoint];
      if (Number.isFinite(target) && Number.isFinite(reference)) {
        pairs.push({ blockId, target, reference });
      }
    }
    const targetMean = point(pairs.map((pair) => pair.target)).mean;
    const referenceMean = point(pairs.map((pair) => pair.reference)).mean;
    return {
      endpoint,
      referenceArm,
      n: pairs.length,
      complete: pairs.length === requiredComparableBlocks,
      targetMean,
      referenceMean,
      difference: Number.isFinite(targetMean) && Number.isFinite(referenceMean)
        ? targetMean - referenceMean
        : null,
      ratio: Number.isFinite(targetMean) && Number.isFinite(referenceMean)
        && referenceMean > 0
        ? targetMean / referenceMean
        : null,
      blockValues: pairs
    };
  };
  const qualityComparisons = {
    promotionRate: comparison("promotionRate", rule.qualityFloorsAgainstArm),
    pathCoverage: comparison("pathCoverage", rule.qualityFloorsAgainstArm),
    mutantKillRate: comparison("mutantKillRate", rule.qualityFloorsAgainstArm)
  };
  const quality = {
    promotionRateDifference: qualityComparisons.promotionRate.difference,
    pathCoverageDifference: qualityComparisons.pathCoverage.difference,
    mutantKillRateDifference: qualityComparisons.mutantKillRate.difference
  };
  const qualityPasses = {
    promotionRate: qualityComparisons.promotionRate.complete
      && Number.isFinite(quality.promotionRateDifference)
      && quality.promotionRateDifference
        >= rule.qualityFloors.promotionRateDifferenceMinimum,
    pathCoverage: qualityComparisons.pathCoverage.complete
      && Number.isFinite(quality.pathCoverageDifference)
      && quality.pathCoverageDifference
        >= rule.qualityFloors.pathCoverageDifferenceMinimum,
    mutantKillRate: qualityComparisons.mutantKillRate.complete
      && Number.isFinite(quality.mutantKillRateDifference)
      && quality.mutantKillRateDifference
        >= rule.qualityFloors.mutantKillRateDifferenceMinimum
  };
  const efficiencyComparisons = {
    parentCumulativeInputTokens: comparison(
      "parentCumulativeInputTokens",
      rule.positiveEfficiencySignalAgainstArm
    ),
    totalNanoAiu: comparison(
      "totalNanoAiu",
      rule.positiveEfficiencySignalAgainstArm
    ),
    totalAiCredits: comparison(
      "totalAiCredits",
      rule.positiveEfficiencySignalAgainstArm
    )
  };
  const efficiency = {
    parentCumulativeInputTokensRatio:
      efficiencyComparisons.parentCumulativeInputTokens.ratio,
    totalNanoAiuRatio: efficiencyComparisons.totalNanoAiu.ratio,
    totalAiCreditsRatio: efficiencyComparisons.totalAiCredits.ratio
  };
  const efficiencyPasses = {
    parentCumulativeInputTokens:
      efficiencyComparisons.parentCumulativeInputTokens.complete
      && Number.isFinite(efficiency.parentCumulativeInputTokensRatio)
      && efficiency.parentCumulativeInputTokensRatio
        <= rule.positiveEfficiencySignalRequires.parentCumulativeInputTokensRatioMaximum,
    totalNanoAiu: efficiencyComparisons.totalNanoAiu.complete
      && Number.isFinite(efficiency.totalNanoAiuRatio)
      && efficiency.totalNanoAiuRatio
        <= rule.positiveEfficiencySignalRequires.totalNanoAiuRatioMaximum,
    totalAiCredits: efficiencyComparisons.totalAiCredits.complete
      && Number.isFinite(efficiency.totalAiCreditsRatio)
      && efficiency.totalAiCreditsRatio
        <= rule.positiveEfficiencySignalRequires.totalAiCreditsRatioMaximum
  };
  const wallComparison = comparison(
    rule.secondaryWallTarget.endpoint,
    rule.positiveEfficiencySignalAgainstArm
  );
  const wallRatio = wallComparison.ratio;
  return {
    preregisteredRule: rule,
    qualityComparisons,
    quality,
    qualityPasses,
    efficiencyComparisons,
    efficiency,
    efficiencyPasses,
    positiveEfficiencySignal: Object.values(qualityPasses).every(Boolean)
      && Object.values(efficiencyPasses).every(Boolean),
    secondaryWallTarget: {
      comparison: wallComparison,
      ratio: wallRatio,
      met: wallComparison.complete && Number.isFinite(wallRatio)
        && wallRatio <= rule.secondaryWallTarget.ratioMaximum
    }
  };
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

const operationalMetricNames = [
  "aiCredits", "nanoAiu", "inputTokens", "outputTokens", "modelTokens",
  "completionCount", "durationMs", "toolCallCount", "toolResultCount"
];

function operationalMeasurement(value, reason) {
  return Number.isFinite(value) && value >= 0
    ? { available: true, value, reason: null }
    : { available: false, value: null, reason };
}

function fullOperationalMetrics(evidence) {
  const total = evidence.operationalUsage.total;
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
      evidence.tools.callCount,
      "tool call count unavailable"
    ),
    toolResultCount: operationalMeasurement(
      evidence.tools.resultCount,
      "tool result count unavailable"
    )
  };
}

function recomputePartialMetrics(partialUsage, partialUsagePath) {
  const unavailable = (reason) => operationalMeasurement(null, reason);
  let rows = null;
  const usageSource = partialUsage.sources.usage;
  if (usageSource.available) {
    const usageBytes = readFileSync(resolve(dirname(partialUsagePath), usageSource.path));
    const usage = JSON.parse(usageBytes);
    const errors = validateJsonSchema(usage, usageExportSchema, {
      schemaDir: schemaRoot
    });
    if (errors.length > 0
      || usage.rows.some((row) =>
        row.session_id !== usage.source.cliSessionId)) {
      throw new Error("Partial usage export is not valid single-session evidence");
    }
    rows = usage.rows;
  }
  const sum = (field) => {
    if (!rows || rows.some((row) =>
      !Number.isFinite(row[field]) || row[field] < 0)) {
      return unavailable(
        usageSource.reason ?? `usage export does not provide finite ${field}`
      );
    }
    return operationalMeasurement(
      rows.reduce((total, row) => total + row[field], 0),
      null
    );
  };
  const nanoAiu = sum("total_nano_aiu");
  const inputTokens = sum("input_tokens");
  const outputTokens = sum("output_tokens");
  let events = null;
  const eventsSource = partialUsage.sources.events;
  if (eventsSource.available) {
    events = readFileSync(resolve(dirname(partialUsagePath), eventsSource.path), "utf8")
      .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  }
  return {
    aiCredits: nanoAiu.available
      ? operationalMeasurement(nanoAiu.value / 1e9, null)
      : unavailable(usageSource.reason
        ?? "usage export does not provide finite AI credits"),
    nanoAiu,
    inputTokens,
    outputTokens,
    modelTokens: inputTokens.available && outputTokens.available
      ? operationalMeasurement(inputTokens.value + outputTokens.value, null)
      : unavailable(usageSource.reason
        ?? "usage export does not provide finite model tokens"),
    completionCount: rows
      ? operationalMeasurement(rows.length, null)
      : unavailable(usageSource.reason
        ?? "usage export does not provide finite completion count"),
    durationMs: sum("duration_ms"),
    toolCallCount: events
      ? operationalMeasurement(events.filter((event) =>
        event.type === "tool.execution_start").length, null)
      : unavailable(eventsSource.reason ?? "tool call count unavailable"),
    toolResultCount: events
      ? operationalMeasurement(events.filter((event) =>
        event.type === "tool.execution_complete").length, null)
      : unavailable(eventsSource.reason ?? "tool result count unavailable")
  };
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
  const startIndexPath = resolve(artifactRoot, input.startIndexPath);
  const startIndexBytes = readFileSync(startIndexPath);
  const startIndexSha256 = sha256(startIndexBytes);
  const startIndexShaBytes = readFileSync(
    resolve(artifactRoot, input.startIndexSha256Path)
  );
  if (startIndexShaBytes.toString("utf8") !== `${startIndexSha256}\n`) {
    throw new Error("Finalized start-index SHA-256 file differs from exact index bytes");
  }
  const startIndex = JSON.parse(startIndexBytes);
  const startErrors = validateStartOrder(startIndex, {
    requireComplete: true,
    baseDir: dirname(startIndexPath)
  });
  if (startErrors.length > 0) {
    throw new Error(`Finalized start index is invalid: ${startErrors[0]}`);
  }
  const withinArtifactRoot = (path) => {
    const child = relative(resolve(artifactRoot), resolve(path));
    return child === "" || (!isAbsolute(child) && child !== ".."
      && !child.startsWith(`..\\`) && !child.startsWith("../"));
  };
  const appSessions = new Set();
  const cliSessions = new Set();
  const seenUnits = new Set();
  const unitRecords = input.runs.map((definition, unitIndex) => {
    const planned = schedule.runs.find((run) => run.runId === definition.runId);
    const orderCapture = startIndex.captures[unitIndex];
    if (!planned
      || planned.blockId !== definition.blockId
      || planned.armId !== definition.armId
      || seenUnits.has(definition.runId)
      || orderCapture?.runId !== definition.runId
      || orderCapture?.sequence !== planned.globalOrder) {
      throw new Error(`Unit identity is duplicate or differs from the frozen schedule: ${definition.runId}`);
    }
    seenUnits.add(definition.runId);
    if (definition.status === "eligible") {
      if (orderCapture.disposition !== "started") {
        throw new Error(`Eligible unit does not have a started order record: ${definition.runId}`);
      }
      return {
        runId: definition.runId,
        blockId: definition.blockId,
        armId: definition.armId,
        status: "eligible",
        reason: null,
        operationalMetrics: null
      };
    }
    const dispositionPath = resolve(artifactRoot, definition.dispositionPath);
    const dispositionBytes = readFileSync(dispositionPath);
    const disposition = JSON.parse(dispositionBytes);
    const dispositionErrors = validateJsonSchema(disposition, dispositionSchema, {
      schemaDir: schemaRoot
    });
    const sourceBytes = dispositionErrors.length === 0
      ? readFileSync(resolve(dirname(dispositionPath), disposition.sourcePath))
      : Buffer.alloc(0);
    const orderSourcePath = dispositionErrors.length === 0
      ? resolve(dirname(startIndexPath), disposition.orderSourcePath)
      : "";
    const captureSourcePath = resolve(dirname(startIndexPath), orderCapture.sourcePath);
    const orderSourceBytes = dispositionErrors.length === 0
      ? readFileSync(orderSourcePath)
      : Buffer.alloc(0);
    if (dispositionErrors.length > 0
      || disposition.runId !== definition.runId
      || disposition.blockId !== definition.blockId
      || disposition.armId !== definition.armId
      || disposition.status !== definition.status
      || disposition.sourceSha256 !== sha256(sourceBytes)
      || orderSourcePath !== captureSourcePath
      || disposition.orderSourceSha256 !== sha256(orderSourceBytes)
      || disposition.orderSourceSha256 !== orderCapture.sourceSha256) {
      throw new Error(`Unavailable/excluded unit lacks exact evidence binding: ${definition.runId}`);
    }
    const source = JSON.parse(sourceBytes);
    const expectedKinds = definition.status === "excluded"
      ? ["model-excluded"]
      : ["preflight-unavailable", "retry-exhausted", "started-uncertain"];
    if (!expectedKinds.includes(disposition.evidenceKind)) {
      throw new Error(`Unit disposition evidence kind is invalid: ${definition.runId}`);
    }
    if (disposition.evidenceKind === "started-uncertain"
      ? (!disposition.partialUsagePath || !disposition.partialUsageSha256)
      : (disposition.partialUsagePath !== null
        || disposition.partialUsageSha256 !== null)) {
      throw new Error(`Unit disposition partial-usage binding is invalid: ${definition.runId}`);
    }
    if (["preflight-unavailable", "retry-exhausted"].includes(disposition.evidenceKind)) {
      if (source.runId !== definition.runId
        || source.blockId !== definition.blockId
        || source.armId !== definition.armId
        || source.disposition !== "unavailable"
        || source.recordedAt !== orderCapture.recordedAt) {
        throw new Error(`Unavailable order evidence is invalid: ${definition.runId}`);
      }
    }
    if (disposition.evidenceKind === "started-uncertain") {
      if (source.runId !== definition.runId
        || source.blockId !== definition.blockId
        || source.armId !== definition.armId
        || source.status !== "started-uncertain"
        || source.lifecycleSha256 !== sha256(orderSourceBytes)
        || !Array.isArray(source.preservedFiles)) {
        throw new Error(`Started/uncertain evidence is invalid: ${definition.runId}`);
      }
      for (const file of source.preservedFiles) {
        const filePath = resolve(dirname(dispositionPath), file.path);
        if (!withinArtifactRoot(filePath)) {
          throw new Error(`Started/uncertain evidence escapes artifact root: ${definition.runId}`);
        }
        const bytes = readFileSync(filePath);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
          throw new Error(`Started/uncertain preserved file differs: ${definition.runId}/${file.path}`);
        }
      }
    }
    let operationalMetrics = null;
    if (disposition.evidenceKind === "started-uncertain") {
      const partialUsagePath = resolve(
        dirname(dispositionPath),
        disposition.partialUsagePath
      );
      const partialUsageBytes = readFileSync(partialUsagePath);
      const partialUsage = JSON.parse(partialUsageBytes);
      const partialErrors = validateJsonSchema(partialUsage, partialUsageSchema, {
        schemaDir: schemaRoot
      });
      if (partialErrors.length > 0
        || disposition.partialUsageSha256 !== sha256(partialUsageBytes)
        || partialUsage.runId !== definition.runId
        || partialUsage.blockId !== definition.blockId
        || partialUsage.armId !== definition.armId
        || partialUsage.lifecycle.sha256 !== disposition.orderSourceSha256
        || partialUsage.lifecycle.path !== relative(
          dirname(dispositionPath),
          orderSourcePath
        ).replaceAll("\\", "/")) {
        throw new Error(`Started/uncertain partial usage is invalid: ${definition.runId}`);
      }
      for (const sourceDefinition of Object.values(partialUsage.sources)) {
        if (!sourceDefinition.path) {
          if (sourceDefinition.sha256 !== null) {
            throw new Error(`Started/uncertain source binding is invalid: ${definition.runId}`);
          }
          continue;
        }
        const path = resolve(dirname(partialUsagePath), sourceDefinition.path);
        if (!withinArtifactRoot(path)
          || sha256(readFileSync(path)) !== sourceDefinition.sha256) {
          throw new Error(`Started/uncertain usage source differs: ${definition.runId}`);
        }
      }
      if (partialUsage.attempt.available) {
        const attemptPath = resolve(
          dirname(partialUsagePath),
          partialUsage.attempt.path
        );
        const attemptBytes = readFileSync(attemptPath);
        const attempt = JSON.parse(attemptBytes);
        if (!withinArtifactRoot(attemptPath)
          || sha256(attemptBytes) !== partialUsage.attempt.sha256
          || attempt.attemptId !== partialUsage.attempt.attemptId
          || attempt.runId !== definition.runId) {
          throw new Error(`Started/uncertain attempt binding differs: ${definition.runId}`);
        }
      }
      const preservedAttempt = source.preservedFiles.find((file) =>
        file.path === "attempt-1.json");
      if (Boolean(preservedAttempt) !== partialUsage.attempt.available
        || (preservedAttempt
          && preservedAttempt.sha256 !== partialUsage.attempt.sha256)) {
        throw new Error(`Started/uncertain attempt availability differs: ${definition.runId}`);
      }
      const recomputedMetrics = recomputePartialMetrics(
        partialUsage,
        partialUsagePath
      );
      if (JSON.stringify(partialUsage.metrics) !== JSON.stringify(recomputedMetrics)) {
        throw new Error(`Started/uncertain partial metrics differ: ${definition.runId}`);
      }
      operationalMetrics = recomputedMetrics;
    }
    if (disposition.evidenceKind === "model-excluded") {
      const evidencePath = resolve(artifactRoot, definition.localEvidencePath);
      const evidenceBytes = readFileSync(evidencePath);
      const evidence = JSON.parse(evidenceBytes);
      const evidenceErrors = validateLocalEvidence(evidence, {
        artifactRoot: dirname(evidencePath),
        candidateRoot: resolve(artifactRoot, definition.candidateRoot)
      });
      const preflightPath = resolve(artifactRoot, definition.modelPreflightPath);
      const preflightBytes = readFileSync(preflightPath);
      const preflight = JSON.parse(preflightBytes);
      const recomputed = preflightLocalModel(evidence, evidenceBytes);
      if (evidenceErrors.length > 0
        || evidence.runId !== definition.runId
        || evidence.blockId !== definition.blockId
        || evidence.armId !== definition.armId
        || preflightPath !== resolve(dirname(dispositionPath), disposition.sourcePath)
        || !preflightBytes.equals(sourceBytes)
        || JSON.stringify(preflight) !== JSON.stringify(recomputed)
        || preflight.status === "pass") {
        throw new Error(`Excluded unit local evidence is invalid: ${definition.runId}`);
      }
      const records = readExecutionRecords(evidence, evidencePath);
      for (const attempt of records.attempts) {
        for (const [label, value, set] of [
          ["app project", attempt.appProjectSessionId, appSessions],
          ["CLI", attempt.cliSessionId, cliSessions]
        ]) {
          if (set.has(value)) {
            throw new Error(`${label} session is reused across AI attempts: ${value}`);
          }
          set.add(value);
        }
      }
      operationalMetrics = fullOperationalMetrics(evidence);
    }
    return {
      runId: definition.runId,
      blockId: definition.blockId,
      armId: definition.armId,
      status: definition.status,
      reason: disposition.reason,
      operationalMetrics
    };
  });
  if (seenUnits.size !== schedule.runs.length) {
    throw new Error("Exactly 72 unique frozen unit records are required");
  }
  const runs = input.runs.filter((definition) => definition.status === "eligible")
    .map((definition) => {
    const planned = schedule.runs.find((run) => run.runId === definition.runId);
    const orderCapture = startIndex.captures.find((capture) =>
      capture.runId === definition.runId);
    const unitRecord = unitRecords.find((unit) => unit.runId === definition.runId);
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
      const startBytes = readFileSync(resolve(artifactRoot, definition.startEvidencePath));
      const endBytes = readFileSync(resolve(artifactRoot, definition.endEvidencePath));
      const startEvidence = JSON.parse(startBytes);
      const endEvidence = JSON.parse(endBytes);
      const executionErrors = validateJsonSchema(execution, deterministicSchema, {
        schemaDir: schemaRoot
      });
      if (executionErrors.length > 0
        || execution.runId !== definition.runId
        || execution.blockId !== definition.blockId
        || execution.armId !== planned.armId
        || execution.seed !== planned.seed
        || execution.scheduleOrder !== planned.order
        || execution.globalOrder !== planned.globalOrder
        || evaluation.executionSha256 !== sha256(executionBytes)
        || execution.stagingSha256 !== metrics.snapshotSha256
        || execution.startEvidenceSha256 !== sha256(startBytes)
        || execution.startEvidenceSha256 !== orderCapture.sourceSha256
        || execution.endEvidenceSha256 !== sha256(endBytes)
        || startEvidence.runId !== planned.runId
        || startEvidence.blockId !== planned.blockId
        || startEvidence.armId !== planned.armId
        || startEvidence.seed !== planned.seed
        || startEvidence.scheduleOrder !== planned.order
        || startEvidence.globalOrder !== planned.globalOrder
        || startEvidence.startedAt !== execution.startedAt
        || endEvidence.runId !== planned.runId
        || endEvidence.blockId !== planned.blockId
        || endEvidence.armId !== planned.armId
        || endEvidence.endedAt !== execution.endedAt
        || execution.wallMs !== Date.parse(endEvidence.endedAt)
          - Date.parse(startEvidence.startedAt)
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
        parentPremiumRequests: 0,
        workerPremiumRequests: 0,
        totalPremiumRequests: 0,
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
        parentReasoningTokens: 0,
        workerReasoningTokens: 0,
        totalReasoningTokens: 0,
        parentRequestMultiplier: 0,
        workerRequestMultiplier: 0,
        totalRequestMultiplier: 0,
        parentDurationMs: 0,
        workerDurationMs: 0,
        totalDurationMs: 0,
        parentMeanTimeToFirstTokenMs: 0,
        workerMeanTimeToFirstTokenMs: 0,
        totalMeanTimeToFirstTokenMs: 0,
        parentMeanInterTokenLatencyMs: 0,
        workerMeanInterTokenLatencyMs: 0,
        totalMeanInterTokenLatencyMs: 0,
        operationalTotalAiCredits: 0,
        operationalTotalNanoAiu: 0,
        operationalTotalModelTokens: 0,
        operationalTotalCompletionCount: 0,
        parentCumulativeInputTokens: 0,
        parentPeakInputTokens: 0,
        toolSchemaCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        toolResultBytes: 0,
        compactReturnBytes: 0,
        compactionCount: 0,
        wallMs: execution.wallMs,
        parentActiveMs: 0,
        workerActiveMs: 0,
        parentWaitMs: 0,
        sessionEvidenceAvailable: 0,
        modelEvidenceAvailable: 0,
        mechanismEvidenceAvailable: 0,
        deviationCount: 0
      });
      unitRecord.operationalMetrics = Object.fromEntries(
        operationalMetricNames.map((name) => [
          name,
          operationalMeasurement(0, null)
        ])
      );
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
      unitRecord.operationalMetrics = fullOperationalMetrics(evidence);
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
  Object.defineProperty(runs, "unitRecords", {
    value: unitRecords,
    enumerable: false
  });
  return runs;
}

export function summarizeDescriptive(runs) {
  const units = runs.unitRecords ?? runs.map((run) => ({
    runId: run.runId,
    blockId: run.blockId,
    armId: run.armId,
    status: "eligible",
    reason: null
  }));
  if (units.length !== schedule.runs.length) {
    throw new Error("Exactly 72 validated unit records are required; omissions are invalid");
  }
  for (const [index, unit] of units.entries()) {
    const planned = schedule.runs[index];
    if (unit.runId !== planned.runId
      || unit.blockId !== planned.blockId
      || unit.armId !== planned.armId
      || !["eligible", "unavailable", "excluded"].includes(unit.status)) {
      throw new Error(`Unit record ${index + 1} differs from the frozen schedule`);
    }
  }
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
  const operationalRuns = units
    .filter((unit) => unit.armId !== 0 && unit.operationalMetrics)
    .map((unit) => ({
      runId: unit.runId,
      blockId: unit.blockId,
      armId: unit.armId,
      status: unit.status,
      metrics: unit.operationalMetrics
    }));
  const operationalTotals = Object.fromEntries(
    operationalMetricNames.map((name) => {
      const available = operationalRuns
        .filter((run) => run.metrics[name].available);
      const unavailableRunIds = operationalRuns
        .filter((run) => !run.metrics[name].available)
        .map((run) => run.runId);
      return [name, {
        available: available.length > 0,
        value: available.length > 0
          ? available.reduce((sum, run) => sum + run.metrics[name].value, 0)
          : null,
        contributingRuns: available.length,
        unavailableRunIds
      }];
    })
  );
  return {
    formatVersion: 1,
    protocolId: "semantic-test-corpus-execution-v2",
    analysis: "descriptive-point-estimates-and-within-block-pairs-only",
    plannedRuns: 72,
    validatedUnits: units.length,
    observedRuns: runs.length,
    unavailableRuns: units
      .filter((unit) => unit.status !== "eligible")
      .map(({ operationalMetrics: _operationalMetrics, ...unit }) => unit),
    allAttemptOperationalUsage: {
      runs: operationalRuns,
      totals: operationalTotals
    },
    excludedOperationalUsage: {
      runs: operationalRuns.filter((run) => run.status === "excluded")
    },
    armPoints,
    pairs,
    registeredContrasts: registeredContrasts(runs, endpointNames),
    targetArmDecisionRule: targetDecisionRule(runs)
  };
}

export function analyzeDescriptiveArtifacts(input, artifactRoot) {
  const runs = buildDescriptiveRuns(input, artifactRoot);
  const summary = summarizeDescriptive(runs);
  summary.fieldAvailabilityByRun = input.runs
    .filter((definition) => definition.status === "eligible" && definition.armId !== 0)
    .map((definition) => {
      const evidence = JSON.parse(
        readFileSync(resolve(artifactRoot, definition.localEvidencePath), "utf8")
      );
      return {
        runId: definition.runId,
        fields: evidence.availability.fields
      };
    });
  return summary;
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
