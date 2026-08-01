#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEvidencePackage } from "./package-v5-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(root, "results", "v5-b01");
const reportPath = resolve(root, "report.md");
const summaryPath = resolve(root, "results", "v5-final-summary.json");
const csvPath = resolve(root, "results", "v5-final-arm-summary.csv");
const PROTOCOL_ID = "semantic-test-corpus-execution-v5";
const EXPECTED = {
  sourceCommit: "58642d097ffab46fe5452380fbe7d8c66a183577",
  closureSha256: "d0d86f7f43b20ef3bd95cdc76929cd74973d77e5c0867acf2e8ca0ebd114433c",
  packageSha256: "613dcf903e59273b9dae27f7d7684609c9c0e6af46af83c75d25e76c188350e3",
  aiCredits: 1876.523305,
  nanoAiu: 1876523305000,
  inputTokens: 7057963,
  outputTokens: 809569,
  reasoningTokens: 39230,
  completions: 464,
  summedWallMs: 7321549
};
const ARM_LABELS = [
  "A0 deterministic script",
  "A1 GPT-5.6 Sol inline",
  "A2 GPT parent -> inherited GPT worker",
  "A3 Haiku inline",
  "A4 Haiku parent -> inherited Haiku worker",
  "A5 GPT parent -> fixed Haiku worker"
];
const TARGET_ENDPOINTS = [
  "promotionRate",
  "pathCoverage",
  "mutantKillRate",
  "parentCumulativeInputTokens",
  "totalAiCredits",
  "totalNanoAiu",
  "totalInputTokens",
  "totalOutputTokens",
  "totalModelTokens",
  "wallMs"
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function statistic(point) {
  const values = point.blockValues.map((entry) => entry.value);
  return {
    n: point.n,
    mean: point.mean,
    median: point.median,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null
  };
}

function pairedComparison(targetPoint, referencePoint, referenceArm) {
  const targetByBlock = new Map(targetPoint.blockValues
    .map((entry) => [entry.blockId, entry.value]));
  const pairs = referencePoint.blockValues.flatMap((reference) => {
    const target = targetByBlock.get(reference.blockId);
    return Number.isFinite(target) && Number.isFinite(reference.value)
      ? [{
          blockId: reference.blockId,
          target,
          reference: reference.value,
          difference: target - reference.value,
          ratio: reference.value > 0 ? target / reference.value : null
        }]
      : [];
  });
  const differences = pairs.map((pair) => pair.difference);
  const targetMean = pairs.length > 0
    ? pairs.reduce((sum, pair) => sum + pair.target, 0) / pairs.length
    : null;
  const referenceMean = pairs.length > 0
    ? pairs.reduce((sum, pair) => sum + pair.reference, 0) / pairs.length
    : null;
  return {
    referenceArm,
    n: pairs.length,
    targetMean,
    referenceMean,
    meanDifference: differences.length > 0
      ? differences.reduce((sum, value) => sum + value, 0) / differences.length
      : null,
    medianDifference: median(differences),
    ratioOfMeans: Number.isFinite(targetMean) && referenceMean > 0
      ? targetMean / referenceMean
      : null,
    percentChange: Number.isFinite(targetMean) && referenceMean > 0
      ? ((targetMean - referenceMean) / referenceMean) * 100
      : null,
    blockValues: pairs
  };
}

function countValues(values) {
  return Object.fromEntries([...new Set(values)].sort()
    .map((value) => [value, values.filter((candidate) => candidate === value).length]));
}

function telemetryAvailability(bundles, armId) {
  if (armId === 0) {
    return {
      status: "not-applicable",
      reason: "The deterministic arm has no model-session telemetry."
    };
  }
  const fields = {};
  for (const bundle of bundles.filter((candidate) => candidate.armId === armId)) {
    for (const [name, availability] of Object.entries(
      bundle.localEvidence.availability.fields
    )) {
      fields[name] ??= { available: 0, unavailable: 0, reasons: {} };
      fields[name][availability.status] += 1;
      for (const reason of availability.reasons) {
        fields[name].reasons[reason] = (fields[name].reasons[reason] ?? 0) + 1;
      }
    }
  }
  return { status: "available", fields };
}

function exposedToolStatistic(bundles, armId) {
  if (armId === 0) {
    return { n: 12, mean: 0, median: 0, minimum: 0, maximum: 0 };
  }
  const values = bundles.filter((bundle) => bundle.armId === armId)
    .map((bundle) => bundle.localEvidence.tools.exposed.names.length);
  return {
    n: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values),
    minimum: Math.min(...values),
    maximum: Math.max(...values)
  };
}

function asciiComparison() {
  const ascii = readJson(resolve(
    root,
    "..",
    "ascii-art-powershell-cli",
    "results",
    "summary.json"
  ));
  const outcome = (name) => ascii.intentToTreat.outcomes
    .find((candidate) => candidate.outcome === name);
  return {
    protocolId: ascii.protocolId,
    completePairs: ascii.intentToTreat.completeAssignedPairs,
    totalNanoAiuPercentChange: outcome("totalSessionNanoAiu").percentChangeFromControl,
    parentCumulativeInputPercentChange:
      outcome("parentCumulativeInputTokens").percentChangeFromControl,
    wallLatencyPercentChange: outcome("wallLatencyMs").percentChangeFromControl,
    deterministicPassDifference:
      outcome("deterministicPass").meanPairedDifference,
    overallQualityDifference: outcome("overallQuality").meanPairedDifference,
    inferenceWithheld: outcome("totalSessionNanoAiu").promptClusteredBootstrap95
      .status === "unavailable"
  };
}

function buildSummary() {
  const verification = verifyEvidencePackage(evidenceRoot);
  const manifest = readJson(resolve(evidenceRoot, "manifest.json"));
  const results = readJson(resolve(
    evidenceRoot,
    "analysis",
    "descriptive-results.json"
  ));
  const availability = readJson(resolve(
    evidenceRoot,
    "analysis",
    "availability.json"
  ));
  const closureTotals = readJson(resolve(
    evidenceRoot,
    "raw",
    "closure.json"
  )).closure.totals;
  const bundles = readdirSync(resolve(evidenceRoot, "raw", "runs"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(resolve(evidenceRoot, "raw", "runs", name)))
    .sort((left, right) => left.globalOrder - right.globalOrder);
  const armPoints = new Map(results.armPoints.map((arm) => [arm.armId, arm]));
  const flowByArm = new Map(results.outcomes.byArm.map((arm) => [arm.armId, arm]));
  const outcomesByArm = new Map(Array.from({ length: 6 }, (_, armId) => [
    armId,
    results.outcomes.runs.filter((run) => run.armId === armId)
  ]));
  const arms = Array.from({ length: 6 }, (_, armId) => {
    const outcomes = outcomesByArm.get(armId);
    return {
      armId,
      label: ARM_LABELS[armId],
      flow: flowByArm.get(armId),
      failureCategories: countValues(outcomes.flatMap((run) => run.failureKinds)),
      dispositionReasons: countValues(outcomes
        .filter((run) => run.disposition !== "success")
        .map((run) => results.measuredFailures
          .find((failure) => failure.runId === run.runId)?.reason ?? "unknown")),
      scoringSources: countValues(outcomes.map((run) => run.scoringSource)),
      exposedToolCount: exposedToolStatistic(bundles, armId),
      telemetryAvailability: telemetryAvailability(bundles, armId),
      endpointStatistics: Object.fromEntries(Object.entries(
        armPoints.get(armId).endpoints
      ).map(([name, point]) => [name, statistic(point)]))
    };
  });
  const targetArm = arms[5];
  const targetContrasts = [0, 1, 2, 3, 4].map((referenceArm) => ({
    targetArm: 5,
    referenceArm,
    label: `A5 - A${referenceArm}`,
    endpoints: Object.fromEntries(TARGET_ENDPOINTS.map((endpoint) => [
      endpoint,
      pairedComparison(
        armPoints.get(5).endpoints[endpoint],
        armPoints.get(referenceArm).endpoints[endpoint],
        referenceArm
      )
    ]))
  }));
  const reasoningTokens = bundles.filter((bundle) => bundle.armId !== 0)
    .reduce((sum, bundle) =>
      sum + bundle.analysis.descriptiveRun.endpoints.totalReasoningTokens, 0);
  const descriptiveSummedWallMs = bundles.reduce((sum, bundle) =>
      sum + bundle.analysis.descriptiveRun.endpoints.wallMs, 0);
  const allAttemptTotals = {
    ...results.allAttemptOperationalUsage.totals,
    reasoningTokens: {
      available: true,
      value: reasoningTokens,
      contributingRuns: 60,
      unavailableRunIds: []
    },
    summedWallMs: {
      available: true,
      value: closureTotals.wallMs,
      contributingRuns: 72,
      unavailableRunIds: []
    },
    descriptiveSummedWallMs: {
      available: true,
      value: descriptiveSummedWallMs,
      contributingRuns: 72,
      unavailableRunIds: []
    }
  };

  assert.equal(manifest.protocolId, PROTOCOL_ID);
  assert.equal(manifest.source.closureSha256, EXPECTED.closureSha256);
  assert.equal(manifest.packageSha256, EXPECTED.packageSha256);
  assert.equal(results.plannedRuns, 72);
  assert.equal(results.validatedUnits, 72);
  assert.equal(results.observedRuns, 72);
  assert.equal(results.completeBlocks.length, 12);
  assert.equal(results.unavailableRuns.length, 0);
  assert.equal(results.measuredFailures.length, 39);
  assert.equal(allAttemptTotals.nanoAiu.value, EXPECTED.nanoAiu);
  assert.equal(allAttemptTotals.inputTokens.value, EXPECTED.inputTokens);
  assert.equal(allAttemptTotals.outputTokens.value, EXPECTED.outputTokens);
  assert.equal(allAttemptTotals.reasoningTokens.value, EXPECTED.reasoningTokens);
  assert.equal(allAttemptTotals.completionCount.value, EXPECTED.completions);
  assert.equal(allAttemptTotals.summedWallMs.value, EXPECTED.summedWallMs);
  assert.equal(closureTotals.aiCredits, EXPECTED.aiCredits);
  assert.equal(closureTotals.nanoAiu, EXPECTED.nanoAiu);
  assert.equal(closureTotals.inputTokens, EXPECTED.inputTokens);
  assert.equal(closureTotals.outputTokens, EXPECTED.outputTokens);
  assert.equal(closureTotals.reasoningTokens, EXPECTED.reasoningTokens);
  assert.equal(closureTotals.completions, EXPECTED.completions);
  assert.ok(Math.abs(allAttemptTotals.aiCredits.value - EXPECTED.aiCredits) < 1e-9);

  return {
    formatVersion: 1,
    protocolId: PROTOCOL_ID,
    analysis: "descriptive ITT point estimates and paired block values only",
    generatedFrom: {
      defaultBranchEvidenceMergeCommit: EXPECTED.sourceCommit,
      evidenceRoot: "results/v5-b01",
      closureSha256: manifest.source.closureSha256,
      packageSha256: manifest.packageSha256,
      descriptiveResultsSha256: sha256(readFileSync(resolve(
        evidenceRoot,
        "analysis",
        "descriptive-results.json"
      ))),
      canonicalRegisteredContrasts:
        "results/v5-b01/analysis/descriptive-results.json#/registeredContrasts",
      verification
    },
    execution: {
      randomizedCompleteBlocks: 12,
      scheduledUnits: 72,
      aiUnits: 60,
      deterministicUnits: 12,
      missingSlots: 0,
      retries: 0,
      protocolDeviations: 0,
      measuredFailures: 39,
      allStartedUnitsIncludedInItt: true
    },
    arms,
    targetContrasts,
    targetArmDecisionRule: results.targetArmDecisionRule,
    allAttemptOperationalUsage: {
      runs: 60,
      totals: allAttemptTotals,
      excludedRuns: results.excludedOperationalUsage.runs.length
    },
    telemetryLimitations: availability.limitations,
    asciiComparison: asciiComparison(),
    limitations: [
      "Evidence is local, unsigned, and descriptive only.",
      "There is no detached trust anchor or compliance proof.",
      "No p-values, confidence intervals, significance, causal inference, or population generalization are supported.",
      "Unavailable telemetry is retained as null with canonical per-run reasons; absent fields are not inferred.",
      "Full candidate worktrees, staging documents, prompts, and raw JSONL events remain external and hash-bound rather than committed."
    ]
  };
}

function csvEscape(value) {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function buildCsv(summary) {
  const rows = [[
    "arm_id", "arm_label", "endpoint", "n", "mean", "median", "minimum", "maximum"
  ]];
  for (const arm of summary.arms) {
    for (const [endpoint, value] of Object.entries(arm.endpointStatistics)) {
      rows.push([
        arm.armId,
        arm.label,
        endpoint,
        value.n,
        value.mean,
        value.median,
        value.minimum,
        value.maximum
      ]);
    }
    rows.push([
      arm.armId,
      arm.label,
      "exposedToolCount",
      arm.exposedToolCount.n,
      arm.exposedToolCount.mean,
      arm.exposedToolCount.median,
      arm.exposedToolCount.minimum,
      arm.exposedToolCount.maximum
    ]);
  }
  return Buffer.from(`${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`);
}

function number(value, digits = 1) {
  if (!Number.isFinite(value)) return "unavailable";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function percent(value, digits = 1) {
  return Number.isFinite(value) ? `${number(value * 100, digits)}%` : "unavailable";
}

function signedPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${number(value, digits)}%`;
}

function signedNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${number(value, digits)}`;
}

function statCell(summary, armId, endpoint, options = {}) {
  const stat = summary.arms[armId].endpointStatistics[endpoint];
  if (!stat || stat.n === 0) return "unavailable (n=0)";
  const convert = options.percent
    ? (value) => percent(value, options.digits ?? 1)
    : options.seconds
      ? (value) => number(value / 1000, options.digits ?? 2)
      : options.billions
        ? (value) => number(value / 1e9, options.digits ?? 3)
        : (value) => number(value, options.digits ?? 1);
  return `${convert(stat.mean)} (${convert(stat.median)}; ${convert(stat.minimum)}-${convert(stat.maximum)}; n=${stat.n})`;
}

function metricTable(summary, definitions) {
  const lines = [
    "| Metric | A0 | A1 | A2 | A3 | A4 | A5 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const definition of definitions) {
    lines.push(`| ${definition.label} | ${Array.from({ length: 6 }, (_, armId) =>
      statCell(summary, armId, definition.endpoint, definition.options)).join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildReport(summary) {
  const target = summary.targetArmDecisionRule;
  const contrast = (armId, endpoint) => summary.targetContrasts
    .find((candidate) => candidate.referenceArm === armId).endpoints[endpoint];
  const a5A1 = summary.targetContrasts.find((candidate) => candidate.referenceArm === 1);
  const targetRows = summary.targetContrasts.map((comparison) => {
    const e = comparison.endpoints;
    return `| A${comparison.referenceArm} | 12 | ${signedNumber(e.promotionRate.meanDifference * 100)} pp | ${signedNumber(e.pathCoverage.meanDifference * 100)} pp | ${signedNumber(e.mutantKillRate.meanDifference * 100)} pp | ${signedPercent(e.parentCumulativeInputTokens.percentChange)} | ${signedPercent(e.totalAiCredits.percentChange)} | ${signedPercent(e.totalModelTokens.percentChange)} | ${signedPercent(e.wallMs.percentChange)} |`;
  }).join("\n");
  const thresholdRows = [
    ["Promotion vs A0", ">= -5 pp", target.quality.promotionRateDifference, target.qualityPasses.promotionRate, "pp"],
    ["Path coverage vs A0", ">= -3 pp", target.quality.pathCoverageDifference, target.qualityPasses.pathCoverage, "pp"],
    ["Mutant kill vs A0", ">= -5 pp", target.quality.mutantKillRateDifference, target.qualityPasses.mutantKillRate, "pp"],
    ["Parent cumulative input vs A1", "<= 85%", target.efficiency.parentCumulativeInputTokensRatio, target.efficiencyPasses.parentCumulativeInputTokens, "ratio"],
    ["Total nano-AIU vs A1", "<= 90%", target.efficiency.totalNanoAiuRatio, target.efficiencyPasses.totalNanoAiu, "ratio"],
    ["Total credits vs A1", "<= 90%", target.efficiency.totalAiCreditsRatio, target.efficiencyPasses.totalAiCredits, "ratio"],
    ["Wall time vs A1 (secondary)", "<= 80%", target.secondaryWallTarget.ratio, target.secondaryWallTarget.met, "ratio"]
  ].map(([label, criterion, observed, met, kind]) =>
    `| ${label} | ${criterion} | ${kind === "pp" ? `${signedNumber(observed * 100)} pp` : percent(observed)} | ${met ? "met" : "not met"} |`
  ).join("\n");
  const failureRows = summary.arms.map((arm) => {
    const categories = Object.entries(arm.failureCategories)
      .map(([name, count]) => `${name}=${count}`).join("; ") || "none";
    return `| A${arm.armId} | ${arm.flow.successfulDisposition}/12 | ${arm.flow.treatmentAdherent}/12 | ${arm.flow.operationallySuccessful}/12 | ${arm.flow.scoringSources["authenticated-snapshot"] ?? 0} full / ${arm.flow.scoringSources["authenticated-partial-snapshot"] ?? 0} partial | ${categories} |`;
  }).join("\n");
  const availabilityRows = ["premiumRequests", "toolSchemas", "exposedTools", "compaction",
    "reasoningTokens", "latencyDetails", "requestMultiplier", "parentWait", "sourceReadOnly"]
    .map((field) => {
      const cells = summary.arms.slice(1).map((arm) => {
        const entry = arm.telemetryAvailability.fields[field];
        const reason = Object.keys(entry.reasons).join("; ");
        return entry.available === 12
          ? "12/12"
          : `${entry.available}/12${reason ? ` (${reason})` : ""}`;
      });
      return `| ${field} | ${cells.join(" | ")} |`;
    }).join("\n");
  const totals = summary.allAttemptOperationalUsage.totals;
  const ascii = summary.asciiComparison;
  const report = `# Semantic test-corpus protocol-v5 benchmark report

**Result: the target Agent Skill Pattern arm did not satisfy the preregistered
positive-efficiency signal.** In all 12 complete randomized blocks, A5 used
${number((1 - target.efficiency.totalAiCreditsRatio) * 100, 1)}% fewer AI credits/nano-AIU
and ${number((1 - target.efficiency.parentCumulativeInputTokensRatio) * 100, 1)}% less
parent cumulative input than GPT inline, but used
${number(a5A1.endpoints.totalModelTokens.percentChange, 1)}% more total model tokens,
took ${number(a5A1.endpoints.wallMs.percentChange, 1)}% longer, missed the path and
mutant-quality floors, had 0/12 strict successes, and was treatment-adherent in only
1/12 units.

> **Evidence boundary.** These are local, unsigned, descriptive-only point estimates.
> There is no detached trust anchor or compliance proof. No p-values, confidence
> intervals, significance, causal inference, or population generalization are supported.
> Unavailable telemetry remains null with its recorded reason; absent telemetry is never
> inferred.

Machine-readable sources:

- [immutable protocol-v5 package](results/v5-b01/)
- [final summary JSON](results/v5-final-summary.json)
- [per-arm endpoint CSV](results/v5-final-arm-summary.csv)
- [canonical descriptive results](results/v5-b01/analysis/descriptive-results.json)

## Design, integrity, and ITT accounting

The benchmark contains 12 randomized complete blocks and 72 units: 60 AI units and
12 deterministic units. Every slot reached a final disposition; there were zero
missing slots, retries, or protocol deviations. All 39 measured failures crossed
the durable start boundary and remain in the intent-to-treat analysis with
deterministic quality scoring. No started unit was dropped or replaced.

| Frozen item | Value |
| --- | --- |
| Evidence merge commit | \`${summary.generatedFrom.defaultBranchEvidenceMergeCommit}\` |
| Closure SHA-256 | \`${summary.generatedFrom.closureSha256}\` |
| Package aggregate SHA-256 | \`${summary.generatedFrom.packageSha256}\` |
| Blocks / units | 12 / 72 |
| AI / deterministic units | 60 / 12 |
| Missing / retries / protocol deviations | 0 / 0 / 0 |
| Measured failures included in ITT | 39 |

## Arms and reliability

| Arm | Execution |
| ---: | --- |
${summary.arms.map((arm) => `| A${arm.armId} | ${arm.label.replace(/^A\d\s+/u, "")} |`).join("\n")}

| Arm | Strict success | Treatment-adherent | Operational success | Quality source | Failure categories |
| ---: | ---: | ---: | ---: | --- | --- |
${failureRows}

A1 and A2 failed only their strict model-token budget in 2/12 and 1/12 units,
respectively; every unit still produced an authenticated 60-scenario snapshot.
A3-A5 were operationally much stronger than their strict dispositions imply, but
their treatment/budget contracts were not: A3 was 0/12 adherent and 6/12
operationally successful; A4 and A5 were each 1/12 adherent and 10/12 operationally
successful. A4/A5 also had one partial terminal failure each (34 and 32 staged
scenarios), while one additional A5 snapshot contained 59 scenarios. Exact-task,
Skill ordering/provenance, terminal-return, duplicate-write, and budget failures are
retained rather than normalized away.

## Quality and diversity

Each cell is mean (median; range; denominator). Quality includes every started unit.

${metricTable(summary, [
  { label: "Promotion rate", endpoint: "promotionRate", options: { percent: true } },
  { label: "Rule coverage", endpoint: "ruleCoverage", options: { percent: true } },
  { label: "Path coverage", endpoint: "pathCoverage", options: { percent: true } },
  { label: "Invariant coverage", endpoint: "invariantCoverage", options: { percent: true } },
  { label: "Diagnostic coverage", endpoint: "diagnosticCoverage", options: { percent: true } },
  { label: "Mutant kill rate", endpoint: "mutantKillRate", options: { percent: true } }
])}

${metricTable(summary, [
  { label: "Semantic unique signatures", endpoint: "semanticUniqueSignatures" },
  { label: "Semantic duplicate cases", endpoint: "semanticDuplicateCases" },
  { label: "Exact duplicate cases", endpoint: "exactDuplicateCases" },
  { label: "Mean pairwise Jaccard distance", endpoint: "meanPairwiseJaccardDistance", options: { digits: 3 } }
])}

Promotion alone is not sufficient. A5's mean promotion was
${percent(summary.arms[5].endpointStatistics.promotionRate.mean)}, but its mean path
coverage was ${percent(summary.arms[5].endpointStatistics.pathCoverage.mean)} and
mutant kill was ${percent(summary.arms[5].endpointStatistics.mutantKillRate.mean)},
both materially below A0. Promotion verifies accepted structure; trace coverage and
mutation testing measure whether those accepted scenarios exercise and detect the
behavior the corpus exists to test. Treatment adherence separately verifies that the
claimed mechanism was actually followed.

## Cost, context, and completions

Each cell is mean (median; range; n). Nano-AIU is shown in billions.

${metricTable(summary, [
  { label: "Parent AI credits", endpoint: "parentAiCredits", options: { digits: 3 } },
  { label: "Worker AI credits", endpoint: "workerAiCredits", options: { digits: 3 } },
  { label: "Total AI credits", endpoint: "totalAiCredits", options: { digits: 3 } },
  { label: "Parent nano-AIU (B)", endpoint: "parentNanoAiu", options: { billions: true } },
  { label: "Worker nano-AIU (B)", endpoint: "workerNanoAiu", options: { billions: true } },
  { label: "Total nano-AIU (B)", endpoint: "totalNanoAiu", options: { billions: true } },
  { label: "Parent cumulative input", endpoint: "parentCumulativeInputTokens" },
  { label: "Parent peak input", endpoint: "parentPeakInputTokens" }
])}

${metricTable(summary, [
  { label: "Parent input tokens", endpoint: "parentInputTokens" },
  { label: "Worker input tokens", endpoint: "workerInputTokens" },
  { label: "Total input tokens", endpoint: "totalInputTokens" },
  { label: "Parent output tokens", endpoint: "parentOutputTokens" },
  { label: "Worker output tokens", endpoint: "workerOutputTokens" },
  { label: "Total output tokens", endpoint: "totalOutputTokens" },
  { label: "Parent cached tokens", endpoint: "parentCachedTokens" },
  { label: "Worker cached tokens", endpoint: "workerCachedTokens" },
  { label: "Total cached tokens", endpoint: "totalCachedTokens" },
  { label: "Parent reasoning tokens", endpoint: "parentReasoningTokens" },
  { label: "Worker reasoning tokens", endpoint: "workerReasoningTokens" },
  { label: "Total reasoning tokens", endpoint: "totalReasoningTokens" },
  { label: "Parent model tokens", endpoint: "parentModelTokens" },
  { label: "Worker model tokens", endpoint: "workerModelTokens" },
  { label: "Total model tokens", endpoint: "totalModelTokens" },
  { label: "Parent completions", endpoint: "parentCompletionCount" },
  { label: "Worker completions", endpoint: "workerCompletionCount" },
  { label: "Total completions", endpoint: "totalCompletionCount" }
])}

Premium-request fields are unavailable because the local usage store has no such
field. Credits are the available AI-credit measure and nano-AIU is reported
separately. Cache read and cache write values remain separately available in the
JSON/CSV; the table above reports the canonical combined cached-token endpoint.

## Tools and timing

${metricTable(summary, [
  { label: "Tool schema count", endpoint: "toolSchemaCount" },
  { label: "Tool calls", endpoint: "toolCallCount" },
  { label: "Tool results", endpoint: "toolResultCount" },
  { label: "Tool-result bytes", endpoint: "toolResultBytes" },
  { label: "Compact-return bytes", endpoint: "compactReturnBytes" },
  { label: "Wall seconds", endpoint: "wallMs", options: { seconds: true } },
  { label: "Parent active seconds", endpoint: "parentActiveMs", options: { seconds: true } },
  { label: "Worker active seconds", endpoint: "workerActiveMs", options: { seconds: true } },
  { label: "Parent wait seconds", endpoint: "parentWaitMs", options: { seconds: true } },
  { label: "Parent TTFT ms", endpoint: "parentMeanTimeToFirstTokenMs" },
  { label: "Worker TTFT ms", endpoint: "workerMeanTimeToFirstTokenMs" },
  { label: "Parent inter-token latency ms", endpoint: "parentMeanInterTokenLatencyMs", options: { digits: 2 } },
  { label: "Worker inter-token latency ms", endpoint: "workerMeanInterTokenLatencyMs", options: { digits: 2 } }
])}

Exposed-tool names were available in every AI unit: inline arms exposed the four
semantic MCP tools, while delegated arms exposed those four plus \`skill\` and
\`task\` (means 4 and 6 respectively; n=12 per arm). Complete tool-schema payloads
and authoritative compaction counts were unavailable in all AI units. Compact-return
bytes and parent wait were defined only for delegated arms. TTFT/inter-token fields
have the exact per-arm denominators above; partial availability is not imputed.

| Telemetry field | A1 | A2 | A3 | A4 | A5 |
| --- | --- | --- | --- | --- | --- |
${availabilityRows}

## Target contrasts

Differences are paired within all 12 blocks. Quality columns are A5 minus the
comparator in percentage points; other columns are percent change from the
comparator. Ratios against a zero deterministic cost are undefined.

| Comparator | n | Promotion | Path | Mutant kill | Parent cumulative input | Credits | Total model tokens | Wall |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${targetRows}

| Preregistered target | Criterion | Observed | Verdict |
| --- | ---: | ---: | --- |
${thresholdRows}

The three efficiency thresholds against A1 were individually met, but the
preregistered positive signal also required all three quality floors. Because path
coverage and mutant kill failed, the combined signal is **not met**. The secondary
wall target also failed.

## Complete-execution accounting

All 60 AI attempts contribute to the model-usage totals below, including measured
failures. Summed wall time covers all 72 units, including A0. There were no excluded
operational runs.

| Measure | Total | Contributing runs |
| --- | ---: | ---: |
| AI credits | ${number(totals.aiCredits.value, 6)} | ${totals.aiCredits.contributingRuns} |
| Nano-AIU | ${number(totals.nanoAiu.value, 0)} | ${totals.nanoAiu.contributingRuns} |
| Input tokens | ${number(totals.inputTokens.value, 0)} | ${totals.inputTokens.contributingRuns} |
| Output tokens | ${number(totals.outputTokens.value, 0)} | ${totals.outputTokens.contributingRuns} |
| Reasoning tokens | ${number(totals.reasoningTokens.value, 0)} | ${totals.reasoningTokens.contributingRuns} |
| Model tokens | ${number(totals.modelTokens.value, 0)} | ${totals.modelTokens.contributingRuns} |
| Completions | ${number(totals.completionCount.value, 0)} | ${totals.completionCount.contributingRuns} |
| Summed wall seconds | ${number(totals.summedWallMs.value / 1000, 3)} | ${totals.summedWallMs.contributingRuns} |
| Summed model duration seconds | ${number(totals.durationMs.value / 1000, 3)} | ${totals.durationMs.contributingRuns} |
| Tool calls / results | ${number(totals.toolCallCount.value, 0)} / ${number(totals.toolResultCount.value, 0)} | 60 |

The closure's complete-execution wall total uses lifecycle attempt elapsed time.
Per-arm wall point estimates use the canonical local-evidence/deterministic timing
endpoint and sum to ${number(totals.descriptiveSummedWallMs.value / 1000, 3)} seconds;
the ${number((totals.summedWallMs.value - totals.descriptiveSummedWallMs.value) / 1000, 3)}
second source-boundary difference is retained rather than silently reconciled.

## Direct answer to the hypothesis

**Observed facts.** Relative to GPT inline, the skill-routed fixed-Haiku arm reduced
AI credits/nano-AIU by ${number((1 - target.efficiency.totalAiCreditsRatio) * 100, 1)}%
and parent cumulative input by
${number((1 - target.efficiency.parentCumulativeInputTokensRatio) * 100, 1)}%.
It did not reduce total context/token use or wall time: total model tokens rose
${number(a5A1.endpoints.totalModelTokens.percentChange, 1)}%, total input rose
${number(a5A1.endpoints.totalInputTokens.percentChange, 1)}%, and wall time rose
${number(a5A1.endpoints.wallMs.percentChange, 1)}%. It preserved mean promotion within
the -5 pp floor, but not path coverage or mutant kill, and strict reliability was
0/12 with only 1/12 treatment adherence.

**Interpretation.** This benchmark does not support the central hypothesis as a
combined quality/reliability-and-efficiency claim. The low parent cumulative and
peak context in delegated arms is consistent with context isolation doing its
intended parent-side job. The fixed Haiku worker also lowered credit/nano-AIU cost
relative to GPT workers. However, worker context made total token use larger and
delegation/wait made wall time longer. Tool restriction cannot be credited as a
cause because the design did not isolate tool-surface size from model and delegation
effects; likewise, the observed overhead pattern is descriptive, not a causal
estimate. Delegation did not dominate credit cost, but it did coincide with worse
total-token and latency efficiency.

The strong deterministic script is the practical winner for this benchmark: 12/12
strict and operational success, 100% promotion, higher path coverage and mutant kill
than A5, and no AI cost. That makes an AI corpus-proposal step unsupported for this
specific, fully specified migration benchmark. It does not invalidate AI-assisted
test design generally, especially where important semantics exist only in
unstructured material not encoded in deterministic rules.

## Relation to the ASCII case study

The separate ASCII benchmark had ${ascii.completePairs} complete ITT pairs and found
the skill-routed treatment used ${number(ascii.totalNanoAiuPercentChange, 1)}% more
nano-AIU and ${number(ascii.parentCumulativeInputPercentChange, 1)}% more parent
cumulative input, while wall latency was
${number(Math.abs(ascii.wallLatencyPercentChange), 1)}% lower and quality was worse.
This corpus benchmark shows a different credit/parent-context direction but worse
wall latency and incomplete quality/reliability preservation. The tasks are not
pooled: task scale and structure may moderate delegation economics, but these two
case studies support only that hypothesis, not a general law.

## Limitations

- The evidence and package are local and unsigned; hashes establish byte identity,
  not an independent trust anchor, signature, or sandbox/compliance proof.
- The protocol permits descriptive ITT analysis only. No p-values, confidence
  intervals, significance, causal effects, or population generalization are claimed.
- Full candidate worktrees, staging payloads, prompts, raw JSONL events, and opaque
  payloads remain external. Their source bytes are hash-bound by the committed
  manifest but are not independently inspectable from this repository.
- Premium requests, full tool schemas, authoritative compaction counts, portable
  source-read-only state, and some latency details are unavailable. Null values and
  reasons are retained; no absent field is inferred.
- Treatment adherence was especially poor in A3-A5. Partial authenticated quality
  is valid ITT evidence, but it is not equivalent to successful execution of the
  intended treatment mechanism.

## Reproduction

From \`experiments/semantic-test-corpus\`:

\`\`\`powershell
npm run report:v5
npm run report:v5:check
npm test
npm run evidence:v5:verify
\`\`\`

\`report:v5\` verifies the immutable package, re-derives every table from committed
canonical artifacts, asserts the closure/package hashes and complete-execution
totals, and writes the Markdown/JSON/CSV outputs. \`report:v5:check\` regenerates in
memory and requires byte-for-byte equality.
`;
  return Buffer.from(report, "utf8");
}

export function generateFinalReport() {
  const summary = buildSummary();
  return {
    summary,
    summaryBytes: canonicalBytes(summary),
    csvBytes: buildCsv(summary),
    reportBytes: buildReport(summary)
  };
}

function writeOrCheck(check) {
  const generated = generateFinalReport();
  const files = [
    [summaryPath, generated.summaryBytes],
    [csvPath, generated.csvBytes],
    [reportPath, generated.reportBytes]
  ];
  if (check) {
    for (const [path, expected] of files) {
      assert.ok(readFileSync(path).equals(expected), `${path} is not byte-for-byte current`);
    }
    return;
  }
  for (const [path, bytes] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeOrCheck(process.argv.includes("--check"));
  console.log(process.argv.includes("--check")
    ? "Protocol-v5 final report is byte-for-byte current."
    : "Generated protocol-v5 final report, summary JSON, and arm CSV.");
}
