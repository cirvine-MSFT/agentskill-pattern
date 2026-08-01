#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFiles } from "../evaluator/evaluate.mjs";
import { assert, jsonBytes, readJson, root } from "./lib.mjs";

export function derivePilotSummary(evidenceRoot = resolve(root, "results", "excluded-pilot")) {
  const gate = readJson(resolve(root, "design", "pilot-gate.json"));
  const index = readJson(resolve(evidenceRoot, "start-index.json"));
  assert(index.captures.length === 3, "pilot start index must preserve exactly three started units");
  assert(
    JSON.stringify(index.captures.map((item) => item.dossierId)) === JSON.stringify(gate.runOrder),
    "pilot start order differs from the frozen gate",
  );
  const records = [];
  const gateFailures = [];
  let unsupportedCriticalClaims = 0;
  let unsupportedCriticalClaimsAvailable = true;
  let ambiguities = 0;
  for (const capture of index.captures) {
    const runRoot = resolve(evidenceRoot, "runs", capture.runId);
    const evidence = readJson(resolve(runRoot, "run-evidence.json"));
    const reviewAddendumPath = resolve(runRoot, "review-addendum.json");
    const reviewAddendum = existsSync(reviewAddendumPath) ? readJson(reviewAddendumPath) : null;
    const dossierPath = resolve(root, "fixtures", "dossiers", "excluded-pilot", `${capture.dossierId}.json`);
    const goldPath = resolve(root, "evaluator", "gold", `${capture.dossierId}.json`);
    const draftPath = resolve(evidenceRoot, "drafts", `${capture.dossierId}.md`);
    const evaluation = existsSync(draftPath)
      ? evaluateFiles(dossierPath, goldPath, draftPath)
      : null;
    if (evaluation) {
      unsupportedCriticalClaims += evaluation.deterministicScreen.unsupportedCriticalClaims.length;
    } else {
      unsupportedCriticalClaimsAvailable = false;
    }
    const failures = [];
    if (!evidence.operationalSuccess) failures.push("operational failure");
    if (!evidence.treatmentAdherent) failures.push("treatment nonadherence");
    if (!reviewAddendum?.returnBoundary.compactReturnValid) {
      failures.push("compact return or model-visible leakage boundary violated");
    }
    if (!reviewAddendum?.runtimeIsolation.established) {
      failures.push("runtime evaluator-filesystem isolation not established");
    }
    if (!evidence.boundary?.boundariesObservable) failures.push("required boundaries not observable");
    if (evidence.boundary?.reads !== gate.required.readsPerRun) failures.push("read count differs from gate");
    if (evidence.boundary?.writes !== gate.required.writesPerRun) failures.push("write count differs from gate");
    if (evidence.boundary?.mcpCalls !== gate.limits.mcpCallsPerRun) failures.push("MCP call count differs from gate");
    if (evidence.usage?.total?.modelTokens === null || evidence.usage?.total?.modelTokens === undefined) {
      failures.push("total model-token outcome unavailable");
    } else if (evidence.usage.total.modelTokens > gate.limits.totalModelTokensPerRun) {
      failures.push("total model-token cap violated");
    }
    if ((evidence.timing?.wallTimeMs ?? Infinity) > gate.limits.wallTimeMsPerRun) {
      failures.push("wall-time cap violated or unavailable");
    }
    if (!evaluation) {
      failures.push("unsupported-critical-claim outcome unavailable because no draft was written");
    } else if (evaluation.deterministicScreen.unsupportedCriticalClaims.length > 0) {
      failures.push("unsupported critical claim observed");
    }
    if ((evidence.failureReasons?.length ?? 0) > 0) ambiguities += 1;
    gateFailures.push(...failures.map((failure) => `${capture.runId}: ${failure}`));
    records.push({ capture, evidence, reviewAddendum, evaluation, gateFailures: failures });
  }
  if (ambiguities !== gate.required.protocolInfrastructureAmbiguities) {
    gateFailures.push(`protocol/infrastructure ambiguities: ${ambiguities}`);
  }
  const operationalSuccessCount = records.filter((record) => record.evidence.operationalSuccess).length;
  const adherenceSuccessCount = records.filter((record) => record.evidence.treatmentAdherent).length;
  if (operationalSuccessCount !== gate.required.operationalSuccessCount) {
    gateFailures.push(`operational success ${operationalSuccessCount}/3`);
  }
  if (adherenceSuccessCount !== gate.required.adherenceSuccessCount) {
    gateFailures.push(`adherence success ${adherenceSuccessCount}/3`);
  }
  if (!unsupportedCriticalClaimsAvailable) {
    gateFailures.push("unsupported-critical-claim outcome unavailable for one or more runs");
  } else if (unsupportedCriticalClaims !== gate.required.unsupportedCriticalClaims) {
    gateFailures.push(`unsupported critical claims: ${unsupportedCriticalClaims}`);
  }
  return {
    formatVersion: 1,
    protocolId: gate.protocolId,
    phase: "excluded-pilot",
    permanentlyExcludedFromConfirmation: true,
    disposition: gateFailures.length === 0 ? "GO" : "NO-GO",
    frozenGateSatisfied: gateFailures.length === 0,
    gateFailures: [...new Set(gateFailures)],
    counts: {
      planned: 3,
      started: index.captures.length,
      operationalSuccess: operationalSuccessCount,
      treatmentAdherent: adherenceSuccessCount,
      unsupportedCriticalClaims: unsupportedCriticalClaimsAvailable ? unsupportedCriticalClaims : null,
      unsupportedCriticalClaimsAvailable,
      protocolInfrastructureAmbiguities: ambiguities,
    },
    runs: records.map((record) => ({
      runId: record.evidence.runId,
      dossierId: record.evidence.dossierId,
      disposition: record.evidence.disposition,
      gateFailures: record.gateFailures,
      deterministicScreen: record.evaluation?.deterministicScreen ?? null,
      telemetry: {
        parent: record.evidence.usage?.parent ?? null,
        worker: record.evidence.usage?.worker ?? null,
        total: record.evidence.usage?.total ?? null,
        timing: record.evidence.timing ?? null,
        boundary: record.evidence.boundary ?? null,
      },
      reviewAddendum: record.reviewAddendum,
    })),
    conclusion: gateFailures.length === 0
      ? "The excluded pilot supports proceeding to a separate confirmatory preregistration; it is not confirmatory evidence."
      : "The frozen feasibility gate failed. Do not tune, retry, relabel, or begin main execution.",
  };
}

function report(summary) {
  const rows = summary.runs.map((run) =>
    `| ${run.runId} | ${run.dossierId} | ${run.disposition} | ${run.telemetry.total?.modelTokens ?? "unavailable"} | ${run.gateFailures.join("; ") || "none"} |`);
  const zeroMcp = summary.runs.every((run) => run.telemetry.boundary?.mcpCalls === 0);
  return [
    "# Excluded feasibility pilot",
    "",
    `**Frozen disposition: ${summary.disposition}.** ${summary.conclusion}`,
    "",
    "These outcomes are permanently excluded from any later confirmation.",
    "",
    "| Run | Dossier | Outcome | Total model tokens | Gate failures |",
    "|---|---|---|---:|---|",
    ...rows,
    "",
    "## Gate totals",
    "",
    `- Operational success: ${summary.counts.operationalSuccess}/3`,
    `- Treatment adherence: ${summary.counts.treatmentAdherent}/3`,
    `- Unsupported critical claims: ${summary.counts.unsupportedCriticalClaimsAvailable ? summary.counts.unsupportedCriticalClaims : "unavailable because no draft artifact was written"}`,
    `- Protocol/infrastructure ambiguities: ${summary.counts.protocolInfrastructureAmbiguities}`,
    "",
    ...(zeroMcp
      ? [
          "## Feasibility diagnosis",
          "",
          "The Skill and fixed-Haiku delegation lifecycles were observed in all three runs,",
          "but the worker emitted XML-like pseudo tool calls as assistant text. The runtime",
          "recorded zero release-note MCP calls, each server audit stopped at",
          "`service.started`, and no draft artifact was written. All three runs also exceeded",
          "the frozen 20,000 total-model-token cap. Review also confirmed that worker narration",
          "and fabricated drafts crossed the compact-return boundary, and that the pilot used",
          "the repository workspace rather than an evaluator-inaccessible isolated workspace.",
          "These are observed mechanism/infrastructure failures, not quality misses that may be",
          "tuned away inside the pilot.",
          "",
        ]
      : []),
    ...(summary.gateFailures.length === 0
      ? []
      : ["## Frozen gate failures", "", ...summary.gateFailures.map((failure) => `- ${failure}`), ""]),
    "Main runs remain forbidden until a separate merged preregistration freezes the full",
    "confirmatory design named in `design/main-study-reservation.json`.",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidenceRoot = resolve(root, "results", "excluded-pilot");
  const summary = derivePilotSummary(evidenceRoot);
  writeFileSync(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
  writeFileSync(resolve(evidenceRoot, "report.md"), report(summary));
  process.stdout.write(`Excluded pilot disposition: ${summary.disposition}\n`);
}
