#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  canonicalTools,
  evidenceRoot,
  jsonBytes,
  parseEvents,
  readJson,
  tokenLimit,
  wallTimeLimitMs,
} from "./lib.mjs";
import { buildEvidenceManifest } from "./run-v2.mjs";

const runId = "DEV-V2-A4-01";

export function buildDiagnosis() {
  const runRoot = resolve(evidenceRoot, "runs", runId);
  const evidence = readJson(resolve(runRoot, "run-evidence.json"));
  const usage = readJson(resolve(runRoot, "usage.json"));
  const startIndex = readJson(resolve(evidenceRoot, "start-index.json"));
  const events = parseEvents(readFileSync(resolve(runRoot, "copilot-events.jsonl")));
  const usageModelTokens = usage.rows.reduce((total, row) => {
    assert(
      Number.isFinite(row.input_tokens) && Number.isFinite(row.output_tokens),
      "raw usage row lacks model-token fields",
    );
    return total + row.input_tokens + row.output_tokens;
  }, 0);
  assert(
    usageModelTokens === evidence.usage?.total?.modelTokens,
    "derived total model tokens differ from raw usage rows",
  );
  const capture = startIndex.captures.find((item) => item.runId === runId);
  assert(capture?.startedAt === evidence.startedAt, "run start differs from the durable lifecycle marker");
  const recordedWallTimeMs = Date.parse(evidence.endedAt) - Date.parse(capture.startedAt);
  assert(
    recordedWallTimeMs === evidence.timing?.wallTimeMs,
    "derived wall time differs from preserved start/end timestamps",
  );
  const resultEvent = events.find((event) => event.type === "result");
  const resultEventElapsedMs = resultEvent
    ? Date.parse(resultEvent.timestamp) - Date.parse(capture.startedAt)
    : null;
  const unknownToolWarnings = events
    .filter((event) =>
      event.type === "session.info"
      && /unknown tool name in the tool allowlist/iu.test(event.data?.message ?? ""))
    .map((event) => ({ actor: event.agentId ? "worker" : "parent", message: event.data.message }));
  const mcpFailures = events
    .filter((event) =>
      event.type === "session.mcp_server_status_changed"
      && event.data?.serverName === "release-notes"
      && event.data?.status === "failed")
    .map((event) => event.data.error);
  const skillSurface = events
    .filter((event) => event.type === "session.skills_loaded")
    .at(-1)?.data?.skills ?? [];
  const customAgentSchemaEvents = events
    .filter((event) => event.type === "session.custom_agents_updated");
  const pseudoToolCalls = events
    .filter((event) =>
      event.type === "assistant.message"
      && event.agentId
      && /<function_calls>|<invoke\s+name=/iu.test(event.data?.content ?? ""));
  const modelTokens = usageModelTokens;
  const wallTimeMs = recordedWallTimeMs;
  return {
    formatVersion: 1,
    runId,
    frozenDisposition: "NO-GO",
    abandonmentRuleFired: true,
    canonicalToolContract: {
      required: canonicalTools,
      unknownToolWarnings,
      structuredWorkerCalls: evidence.boundary?.workerOwnedMcpStarts ?? 0,
      satisfied: false,
    },
    sandboxIsolation: {
      releaseNotesMcpFailures: [...new Set(mcpFailures)],
      mcpConnected: false,
      attestationProduced: false,
      satisfied: false,
    },
    surfaceIsolation: {
      skills: skillSurface.map((skill) => ({ name: skill.name, source: skill.source })),
      unexpectedSkills: skillSurface
        .filter((skill) => skill.name !== "release-note-synthesis")
        .map((skill) => ({ name: skill.name, source: skill.source })),
      customAgentSchemaEventCount: customAgentSchemaEvents.length,
      satisfied: false,
    },
    modelBehavior: {
      parentModel: evidence.mechanism?.parentModel ?? null,
      workerModel: evidence.mechanism?.workerModel ?? null,
      pseudoToolCallMessages: pseudoToolCalls.length,
      compactEnvelopeValid: false,
    },
    ceilings: {
      totalModelTokens: modelTokens,
      totalModelTokensMaximum: tokenLimit,
      tokenExcess: modelTokens === null ? null : Math.max(0, modelTokens - tokenLimit),
      wallTimeMs,
      resultEventElapsedMs,
      wallTimeMsMaximum: wallTimeLimitMs,
      tokenCeilingSatisfied: modelTokens !== null && modelTokens <= tokenLimit,
      wallTimeCeilingSatisfied: wallTimeMs !== null && wallTimeMs <= wallTimeLimitMs,
    },
    downstream: {
      pilotGateFrozen: false,
      pilotUnitsStarted: 0,
      confirmationUnitsStarted: 0,
      semanticQualityTested: false,
    },
  };
}

function report(summary, diagnosis) {
  const sandboxError = diagnosis.sandboxIsolation.releaseNotesMcpFailures[0] ?? "unavailable";
  return [
    "# Release-note v2 repair disposition",
    "",
    `**${summary.disposition}.** ${summary.recommendation}`,
    "",
    "## Frozen development outcome",
    "",
    "| Run | Disposition | Model tokens | Wall time | Structured MCP calls |",
    "|---|---|---:|---:|---:|",
    `| ${summary.smoke.runId} | ${summary.smoke.disposition} | ${summary.smoke.modelTokens} | ${summary.smoke.wallTimeMs} ms | ${diagnosis.canonicalToolContract.structuredWorkerCalls}/2 |`,
    "",
    "The abandonment rule fired for independent, directly observed reasons:",
    "",
    `- CLI 1.0.77 emitted ${diagnosis.canonicalToolContract.unknownToolWarnings.length} unknown-tool warnings for the required canonical server/tool names across parent and worker.`,
    `- The release-notes MCP never connected: ${sandboxError}`,
    `- The Skill surface still exposed the built-in \`customize-cloud-agent\` Skill, and the raw stream contained ${diagnosis.surfaceIsolation.customAgentSchemaEventCount} custom-agent schema-resolution events.`,
    `- The worker emitted ${diagnosis.modelBehavior.pseudoToolCallMessages} pseudo-tool-call message and no structured MCP call.`,
    `- Total model use was ${diagnosis.ceilings.totalModelTokens} tokens, ${diagnosis.ceilings.tokenExcess} above the 20,000-token ceiling; wall time was ${diagnosis.ceilings.wallTimeMs} ms.`,
    "",
    "No pilot gate was frozen, no pilot or confirmatory unit started, and release-note semantic quality was not tested.",
    "",
    "The v0 evidence and identifiers remain immutable and are not part of this v2 disposition.",
    "",
  ].join("\n");
}

export function finalizeV2() {
  const summaryPath = resolve(evidenceRoot, "summary.json");
  const summary = readJson(summaryPath);
  const diagnosis = buildDiagnosis();
  const nextSummary = { ...summary, diagnosis };
  writeFileSync(resolve(evidenceRoot, "diagnosis.json"), jsonBytes(diagnosis));
  writeFileSync(summaryPath, jsonBytes(nextSummary));
  writeFileSync(resolve(evidenceRoot, "report.md"), report(nextSummary, diagnosis));
  writeFileSync(resolve(evidenceRoot, "manifest.json"), jsonBytes(buildEvidenceManifest()));
  return nextSummary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = finalizeV2();
  process.stdout.write(`Finalized v2 ${summary.disposition} diagnosis without rerunning any unit\n`);
}
