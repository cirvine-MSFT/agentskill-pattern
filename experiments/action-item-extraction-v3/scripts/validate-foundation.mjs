#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSources } from "../design/fixture-sources.mjs";
import { assertNoRun } from "./assert-no-run.mjs";
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
  readJson,
  runs,
  sessionIdFor,
  sha256,
  taskEnvelope,
  transcriptPath,
  uuidNamespace,
} from "./lib.mjs";

const phenomena = [
  ["commitment", /\bI will\b/iu],
  ["suggestion", /\b(?:suggesting|suggestion)\b/iu],
  ["negation", /\bwill not\b/iu],
  ["rescission", /\bwithdraw\b/iu],
  ["reassignment", /\bwill own\b/iu],
  ["date change", /\bmove my\b/iu],
  ["conditional item", /\bonly if\b/iu],
  ["blocked item", /\bblocked until\b/iu],
  ["decision without action", /\bdecision only\b/iu],
  ["ambiguity", /\bambiguity\b/iu],
  ["distractor", /\bdistractor\b/iu],
];

function fileMatches(record) {
  const path = resolve(experimentRoot, record.path);
  const bytes = readFileSync(path);
  return bytes.length === record.bytes && sha256(bytes) === record.sha256;
}

export function validateFoundation({ requireNoRun = true } = {}) {
  invariant(protocolId === "action-item-extraction-v3", "protocol ID changed");
  invariant(uuidNamespace === "d94fca73-b06f-4e21-9f7a-31eb42bf8a6d", "UUID namespace changed");
  invariant(runs.length === 3 && runs.every((run) => run.phase === "excluded-pilot" && run.arm === "A4"), "v3 must contain exactly three A4 excluded pilots");
  invariant(runs.map((run) => run.order).join(",") === "1,2,3", "run order changed");
  invariant(runs.length === new Set(runs.map((run) => run.runId)).size, "run IDs repeat");
  invariant(runs.length === new Set(runs.map(sessionIdFor)).size, "session UUIDs repeat");
  invariant(runs.every((run) => /^PILOT-ACTION-V3-A4-/u.test(run.runId) && /^v3-pilot-/u.test(run.transcriptId)), "non-v3 identity observed");

  const manifest = readJson(resolve(experimentRoot, "design", "fixture-manifest.json"));
  const plan = readJson(resolve(experimentRoot, "design", "execution-plan.json"));
  const evidenceContract = readJson(resolve(experimentRoot, "design", "evidence-contract.json"));
  const reservation = readJson(resolve(experimentRoot, "design", "main-study-reservation.json"));
  const attestation = readJson(resolve(experimentRoot, "design", "no-run-attestation.json"));
  const lock = readJson(resolve(experimentRoot, "design", "foundation-lock.json"));

  invariant(manifest.v2ImmutabilityReference.pullRequest === 27
    && manifest.v2ImmutabilityReference.mergeCommit === "9f3add6986105dd18ac1b4ed8f3cdf2edd639f5a"
    && manifest.v2ImmutabilityReference.v2InputsIdsHashesEvidenceThresholdsDispositionsModifiedOrReused === false
    && manifest.v2ImmutabilityReference.v2PilotUnitsStarted === 0
    && manifest.v2ImmutabilityReference.frozenDisposition === "NO-GO", "v2 immutable reference changed");
  invariant(manifest.v2ImmutabilityReference.frozenDevelopmentEvidence.totalModelTokens === 38410
    && manifest.v2ImmutabilityReference.frozenDevelopmentEvidence.wallTimeSeconds === 55.08
    && manifest.v2ImmutabilityReference.frozenDevelopmentEvidence.sourceGrounding === "1/12", "v2 evidence summary changed");
  invariant(manifest.fixtures.length === 3, "fixture manifest count changed");

  for (const [index, run] of runs.entries()) {
    const source = fixtureSources[index];
    const transcriptBytes = readFileSync(transcriptPath(run));
    const goldBytes = readFileSync(goldPath(run));
    const transcript = transcriptBytes.toString("utf8");
    const gold = JSON.parse(goldBytes);
    invariant(transcript === source.transcript, `${run.runId} transcript differs from source generator`);
    invariant(Buffer.compare(goldBytes, jsonBytes(source.gold)) === 0, `${run.runId} gold differs from source generator`);
    invariant(transcriptBytes.length > 0 && transcriptBytes.length <= 18 * 1024, `${run.runId} transcript exceeds 18 KB`);
    for (const [name, pattern] of phenomena) invariant(pattern.test(transcript), `${run.runId} lacks ${name}`);
    invariant(gold.evaluatorOnly === true && gold.expectedItems.length >= 8 && gold.expectedOmissions.length >= 5, `${run.runId} gold coverage is insufficient`);
    invariant(gold.ambiguityPolicy && gold.omissionPolicy, `${run.runId} ambiguity/omission policy missing`);
    const lines = transcript.trimEnd().split(/\r?\n/u);
    for (const record of [...gold.expectedItems, ...gold.expectedOmissions]) {
      invariant(record.canonicalPolicy || (record.owner && record.action && Object.hasOwn(record, "dueDate")
        && record.status && Object.hasOwn(record, "condition") && record.criticality), `${run.runId} gold record lacks canonical fields`);
      for (const citation of record.sourceCitations) {
        const start = Number.parseInt(citation.startLineId.slice(1, -1), 10);
        const end = Number.parseInt(citation.endLineId.slice(1, -1), 10);
        invariant(lines.slice(start - 1, end).join("\n") === citation.quote, `${run.runId} ungrounded ${citation.startLineId}-${citation.endLineId}`);
        invariant(lines[start - 1].startsWith(citation.startLineId) && lines[end - 1].startsWith(citation.endLineId), `${run.runId} citation prefix mismatch`);
      }
    }
    const frozen = manifest.fixtures[index];
    invariant(frozen.runId === run.runId && frozen.sessionId === sessionIdFor(run), `${run.runId} identity freeze mismatch`);
    invariant(frozen.transcriptSha256 === sha256(transcriptBytes) && frozen.goldSha256 === sha256(goldBytes), `${run.runId} source/gold hash mismatch`);
    invariant(frozen.taskEnvelopeSha256 === sha256(Buffer.from(JSON.stringify(taskEnvelope(run)), "utf8")), `${run.runId} envelope hash mismatch`);
    invariant(JSON.stringify(plan.runs[index].taskEnvelope) === JSON.stringify(taskEnvelope(run)), `${run.runId} task envelope changed`);
    invariant(JSON.stringify(plan.runs[index].exactCliArgs) === JSON.stringify(cliArgs(run)), `${run.runId} exact CLI arguments changed`);
  }

  const generatorBytes = readFileSync(resolve(experimentRoot, manifest.sourceGenerator.path));
  invariant(generatorBytes.length === manifest.sourceGenerator.bytes && sha256(generatorBytes) === manifest.sourceGenerator.sha256, "source generator hash mismatch");
  const candidate = manifestFor(candidateRoot);
  invariant(candidate.files.map((file) => file.path).join(",")
    === ".github/agents/action-ledger-v3-haiku.agent.md,.github/skills/action-ledger-v3/SKILL.md", "candidate source contains unexpected files");
  invariant(JSON.stringify(candidate) === JSON.stringify(manifest.candidate), "candidate source hash changed");
  invariant(candidate.files.every((file) => !/gold|evaluator|evidence/iu.test(file.path)), "candidate contains evaluator-only material");
  const agent = readFileSync(resolve(candidateRoot, ".github", "agents", "action-ledger-v3-haiku.agent.md"), "utf8");
  const skill = readFileSync(resolve(candidateRoot, ".github", "skills", "action-ledger-v3", "SKILL.md"), "utf8");
  invariant((agent.match(/^tools:.*$/gmu) ?? []).join("") === 'tools: ["read", "edit"]', "worker tools changed");
  invariant(agent.includes("model: claude-haiku-4.5") && /exact\s+bracketed identifiers/iu.test(agent), "worker model/citation contract changed");
  invariant((skill.match(/`action-ledger-v3-haiku`/gu) ?? []).length === 1 && skill.includes("exactly once"), "Skill route contract changed");

  invariant(plan.cli.exactVersion === cliVersion
    && JSON.stringify(plan.cli.exactGlobalToolFilter) === JSON.stringify(globalToolFilter)
    && plan.cli.allowAllTools && plan.cli.builtinMcpsDisabled, "CLI freeze changed");
  invariant(plan.arms.join(",") === "A4" && plan.aiObservationsOutsideA4 === 0 && plan.seeds.used === false, "A4-only design changed");
  invariant(plan.worker.eventLinkage.includes("task toolCallId equals worker agentId")
    && plan.worker.exactEventModels.parentTask === "gpt-5.6-sol"
    && plan.worker.exactEventModels.workerLifecycleAndTools === "claude-haiku-4.5", "event linkage/model proof changed");
  invariant(plan.runs.every((entry) => entry.exactCliArgs.includes("--available-tools=task,view,edit")
    && entry.exactCliArgs.includes("--allow-all-tools")
    && entry.exactCliArgs.includes("--disable-builtin-mcps")), "global tool arguments changed");
  invariant(plan.warningRule.exactToleratedRootWarning === exactParentWarning
    && plan.warningRule.exactCount === 1
    && plan.warningRule.distinctDebugToolsBlocks === "informative-not-required"
    && plan.warningRule.v2Reinterpreted === false, "prospective warning rule changed");
  invariant(plan.scoringDefinitions.tuple.includes("semantically compatible action similarity")
    && plan.scoringDefinitions.tuple.includes("final due date, status, condition, and criticality")
    && plan.scoringDefinitions.sourceGrounding.includes("required ambiguity")
    && plan.scoringDefinitions.changesAfterPilotStart === "forbidden", "scoring definitions changed");
  invariant(JSON.stringify(plan.thresholds) === JSON.stringify({
    operationalAndTreatmentAdherent: "3/3",
    exactOneViewOneEdit: "3/3",
    unsupportedCriticalActionsMaximum: 0,
    validSchemaCompactReturnIsolation: "3/3",
    meanTupleF1Minimum: 0.85,
    everyRunTupleF1Minimum: 0.75,
    sourceGrounding: "100%",
    everyRunTotalModelTokensMaximum: 40000,
    everyRunWallTimeMsMaximum: 180000,
    thresholdSofteningAllowed: false,
    retriesAllowed: false,
  }), "GO gate changed");
  invariant(evidenceContract.frozenBeforeAnyRun && evidenceContract.lifecycleOrder.includes("retain every post-start failure in ITT")
    && evidenceContract.lifecycleOrder.some((step) => step.startsWith("independently reconstruct"))
    && evidenceContract.usageSettlement.allRowsRequireFinishReason
    && evidenceContract.certification.derivedRunEvidenceReconstructedFromRawArtifacts
    && evidenceContract.certification.summaryGateRecomputedFromReconstructedRuns, "evidence lifecycle is incomplete");
  invariant(reservation.executionAuthorized === false && reservation.inputsGenerated === false
    && reservation.armsRequiredInSeparatePr.join(",") === "A0,A1,A2,A3,A4", "main-study boundary changed");
  invariant(attestation.v3AiUnitsStarted === 0 && !attestation.v3ResultEvidenceRootExists
    && !attestation.v3RuntimeRootExists && !attestation.lifecycleEvidenceCreated
    && !attestation.copilotCliInvokedForV3Observation, "no-run attestation changed");
  invariant(lock.writeOnce && lock.designFiles.every(fileMatches) && lock.lifecycleAndCandidateFiles.every(fileMatches), "foundation lock mismatch");
  if (requireNoRun) {
    assertNoRun();
    invariant(!existsSync(resolve(experimentRoot, "results")), "v3 results directory must not exist");
  }
  return {
    transcripts: runs.length,
    goldItems: fixtureSources.reduce((sum, fixture) => sum + fixture.gold.expectedItems.length, 0),
    candidateFiles: candidate.files.length,
    aiUnitsStarted: 0,
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = validateFoundation();
  process.stdout.write(`Validated ${result.transcripts} v3 transcripts, ${result.goldItems} gold items, ${result.candidateFiles} candidate files, and zero AI starts\n`);
}
