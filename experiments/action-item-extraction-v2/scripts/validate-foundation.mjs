#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSources } from "../design/fixture-sources.mjs";
import {
  acceptedParentWarnings,
  candidateRoot,
  cliArgs,
  cliVersion,
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
  ["final commitment", /\bI will\b/iu],
  ["suggestion", /\b(?:maybe|suggestion|could|should)\b/iu],
  ["negation", /\b(?:will not|nobody is assigned|do not)\b/iu],
  ["rescission", /\b(?:withdraw|released|do not carry)\b/iu],
  ["reassignment", /\b(?:will own|instead of|released)\b/iu],
  ["date change", /\b(?:move its due date|superseded)\b/iu],
  ["conditional work", /\b(?:only if|conditional|blocked until)\b/iu],
  ["decision only", /\bdecision only\b/iu],
  ["material ambiguity", /\bmaterially ambiguous\b/iu],
  ["distractor", /\b(?:context only|observation|completed work|distractor)\b/iu],
];

function normalizedPaths(value, runtimeRoot) {
  if (typeof value === "string") return value.replaceAll(runtimeRoot, "<runtime>").replaceAll("\\", "/");
  if (Array.isArray(value)) return value.map((entry) => normalizedPaths(entry, runtimeRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizedPaths(entry, runtimeRoot)]));
  }
  return value;
}

export function validateFoundation() {
  invariant(protocolId === "action-item-extraction-v2", "protocol ID changed");
  invariant(uuidNamespace === "a3f947dc-bfa8-4d93-84a9-837b507c621e", "UUID namespace changed");
  const manifest = readJson(resolve(experimentRoot, "design", "fixture-manifest.json"));
  const plan = readJson(resolve(experimentRoot, "design", "execution-plan.json"));
  const devGate = readJson(resolve(experimentRoot, "design", "development-gate.json"));
  const foundationLock = readJson(resolve(experimentRoot, "design", "foundation-lock.json"));
  const arms = readJson(resolve(experimentRoot, "design", "arms.json"));
  const reservation = readJson(resolve(experimentRoot, "design", "main-study-reservation.json"));
  invariant(arms.protocolId === protocolId && arms.arms.map((arm) => arm.id).join(",") === "A0,A1,A2,A3,A4", "five-arm reservation changed");
  invariant(arms.executionAuthorized === false, "AI arm execution became authorized");
  invariant(reservation.reservationOnly && !reservation.executionAuthorized && !reservation.inputsGenerated
    && !reservation.inputHashesGenerated && !reservation.inputHashesExposed, "main reservation exposes or authorizes inputs");
  invariant(reservation.reservedMainIds.length === new Set(reservation.reservedMainIds).size, "reserved main IDs repeat");
  invariant(Object.values(reservation.laterSeparatePrMustFreeze).every((value) =>
    value === true || Array.isArray(value)), "later preregistration requirements are incomplete");
  invariant(manifest.v1ImmutabilityReference.mergeCommit === "4900bdde8250292c86d4040d242359359ac050a0"
    && manifest.v1ImmutabilityReference.pullRequest === 26
    && manifest.v1ImmutabilityReference.contentReadOrCopiedByV2Validation === false, "v1 immutability reference changed");
  invariant(manifest.fixtures.length === 4 && runs.length === 4, "expected one development and three pilot fixtures");
  invariant(runs[0].phase === "development-unit" && runs.slice(1).every((run) => run.phase === "excluded-pilot"), "phase ordering changed");
  invariant(runs.length === new Set(runs.map((run) => run.runId)).size, "run IDs repeat");
  invariant(runs.length === new Set(runs.map(sessionIdFor)).size, "session UUIDs repeat");
  for (const [index, run] of runs.entries()) {
    const source = fixtureSources[index];
    const transcriptBytes = readFileSync(transcriptPath(run));
    const goldBytes = readFileSync(goldPath(run));
    const transcript = transcriptBytes.toString("utf8");
    const gold = JSON.parse(goldBytes);
    invariant(transcript === source.transcript, `${run.runId} concrete transcript differs from fresh source definition`);
    invariant(Buffer.compare(goldBytes, jsonBytes(source.gold)) === 0, `${run.runId} concrete gold differs from source definition`);
    invariant(transcriptBytes.length >= 4_000 && transcriptBytes.length < 18_000, `${run.runId} transcript size outside [4KB,18KB)`);
    for (const [name, pattern] of phenomena) invariant(pattern.test(transcript), `${run.runId} lacks ${name}`);
    invariant(gold.evaluatorOnly === true && gold.expectedItems.length >= 8 && gold.expectedOmissions.length >= 4, `${run.runId} gold coverage is insufficient`);
    const lines = transcript.split(/\r?\n/u);
    for (const record of [...gold.expectedItems, ...gold.expectedOmissions]) {
      for (const span of record.sourceSpans) {
        invariant(lines.slice(span.startLine - 1, span.endLine).join("\n").includes(span.quote),
          `${run.runId} ungrounded gold span ${span.startLine}-${span.endLine}`);
      }
    }
    const frozen = manifest.fixtures.find((entry) => entry.runId === run.runId);
    invariant(frozen?.transcriptSha256 === sha256(transcriptBytes)
      && frozen.transcriptBytes === transcriptBytes.length
      && frozen.goldSha256 === sha256(goldBytes)
      && frozen.goldBytes === goldBytes.length
      && frozen.sessionId === sessionIdFor(run), `${run.runId} fixture/gold/session freeze mismatch`);
    invariant(frozen.taskEnvelopeSha256 === sha256(Buffer.from(JSON.stringify(taskEnvelope(run)), "utf8")),
      `${run.runId} task envelope hash mismatch`);
    const planned = plan.runs[index];
    invariant(planned.runId === run.runId && planned.sessionId === sessionIdFor(run), `${run.runId} execution identity changed`);
    invariant(JSON.stringify(normalizedPaths(planned.taskEnvelope, planned.taskEnvelope.transcriptPath.split("\\candidates\\")[0]))
      === JSON.stringify(normalizedPaths(taskEnvelope(run), taskEnvelope(run).transcriptPath.split("\\candidates\\")[0])), `${run.runId} task envelope changed`);
    invariant(JSON.stringify(normalizedPaths(planned.exactCliArgs, planned.taskEnvelope.transcriptPath.split("\\candidates\\")[0]))
      === JSON.stringify(normalizedPaths(cliArgs(run), taskEnvelope(run).transcriptPath.split("\\candidates\\")[0])), `${run.runId} exact CLI args changed`);
  }
  const candidate = manifestFor(candidateRoot);
  invariant(candidate.files.map((file) => file.path).join(",")
    === ".github/agents/action-ledger-v2-haiku.agent.md,.github/skills/action-ledger-v2/SKILL.md", "candidate file set is not exactly agent plus Skill");
  invariant(candidate.fileSetSha256 === manifest.candidate.fileSetSha256
    && JSON.stringify(candidate.files) === JSON.stringify(manifest.candidate.files), "candidate contents differ from freeze");
  const agent = readFileSync(resolve(candidateRoot, ".github", "agents", "action-ledger-v2-haiku.agent.md"), "utf8");
  const skill = readFileSync(resolve(candidateRoot, ".github", "skills", "action-ledger-v2", "SKILL.md"), "utf8");
  invariant((agent.match(/^tools:.*$/gmu) ?? []).join("") === 'tools: ["read", "edit"]', "agent frontmatter tools are not exactly read/edit");
  invariant(agent.includes("model: claude-haiku-4.5"), "worker model pin changed");
  invariant(agent.includes("runtime `view` exactly once") && agent.includes("runtime `edit` exactly once"), "worker one-view/one-edit contract missing");
  invariant((skill.match(/`action-ledger-v2-haiku`/gu) ?? []).length === 1 && skill.includes("Route exactly once"), "Skill does not route exactly once");
  invariant(plan.cli.exactVersion === cliVersion
    && JSON.stringify(plan.cli.exactGlobalToolFilter) === JSON.stringify(globalToolFilter)
    && plan.cli.allowAllTools && plan.cli.builtinMcpsDisabled && plan.cli.logLevel === "debug", "CLI controls changed");
  invariant(plan.runs.every((entry) => entry.exactCliArgs.includes("--available-tools=task,view,edit")
    && entry.exactCliArgs.includes("--allow-all-tools")
    && entry.exactCliArgs.includes("--disable-builtin-mcps")
    && entry.exactCliArgs.includes("--log-level")
    && !entry.exactCliArgs.some((arg) => /^--available-tools=(?!task,view,edit$)/u.test(arg))), "exact global tool filter changed");
  invariant(JSON.stringify(plan.acceptedParentWarnings) === JSON.stringify(acceptedParentWarnings), "accepted warning evidence policy changed");
  invariant(JSON.stringify(plan.thresholds) === JSON.stringify({
    operationalAndTreatmentAdherent: "3/3",
    exactOneViewOneEdit: "3/3",
    unsupportedCriticalActionsMaximum: 0,
    validSchemaCompactReturnIsolation: "3/3",
    meanTupleF1Minimum: 0.85,
    everyRunTupleF1Minimum: 0.75,
    everyRunTotalModelTokensMaximum: 40000,
    everyRunWallTimeMsMaximum: 180000,
    thresholdSofteningAllowed: false,
    retriesAllowed: false,
  }), "GO thresholds changed");
  invariant(devGate.run.runId === runs[0].runId && devGate.executeExactlyOnceLater
    && devGate.failureRule.includes("start zero pilots"), "development stop rule changed");
  invariant(foundationLock.writeOnce === true && foundationLock.files.length === 3, "foundation lock is incomplete");
  for (const file of foundationLock.files) {
    const bytes = readFileSync(resolve(experimentRoot, file.path));
    invariant(bytes.length === file.bytes && sha256(bytes) === file.sha256, `${file.path} differs from foundation lock`);
  }
  return { transcripts: runs.length, goldItems: fixtureSources.reduce((sum, fixture) => sum + fixture.gold.expectedItems.length, 0), candidateFiles: candidate.files.length };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = validateFoundation();
  process.stdout.write(`Validated ${result.transcripts} v2 transcripts, ${result.goldItems} gold items, and ${result.candidateFiles} candidate files\n`);
}
