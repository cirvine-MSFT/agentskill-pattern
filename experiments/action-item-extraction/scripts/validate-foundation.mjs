#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  availableTools,
  candidateManifest,
  cliArgs,
  experimentRoot,
  goldPath,
  protocolId,
  readJson,
  runs,
  sha256,
  transcriptPath,
} from "./lib.mjs";

const requiredPhenomena = [
  /\bwill\b/iu,
  /\b(?:suggest|should|could|might|maybe)\b/iu,
  /\b(?:not a commitment|no action|do not|will not)\b/iu,
  /\b(?:rescind|withdraw|reassign|will own|instead)\b/iu,
  /\b(?:change|move|due date|deadline)\b/iu,
  /\b(?:if|conditional|after|only if)\b/iu,
  /\b(?:ambiguous|fixed date|state the date|more precisely|clarity|avoid duplication)\b/iu,
  /\bdecision\b/iu,
];

export function validateFoundation() {
  const arms = readJson(resolve(experimentRoot, "design", "arms.json"));
  const reservation = readJson(resolve(experimentRoot, "design", "main-study-reservation.json"));
  const fixtures = readJson(resolve(experimentRoot, "design", "fixture-manifest.json"));
  const gate = readJson(resolve(experimentRoot, "design", "development-gate.json"));
  assert(arms.protocolId === protocolId && arms.arms.length === 5, "five-arm design mismatch");
  assert(arms.confirmatoryExecutionAuthorized === false, "confirmation must remain disabled");
  assert(JSON.stringify(arms.primaryContrast) === JSON.stringify(["A4", "A1"]), "primary contrast mismatch");
  assert(reservation.executionAuthorized === false && reservation.inputsGenerated === false, "main inputs are not reserved-only");
  assert(reservation.reservedMainIds.length === new Set(reservation.reservedMainIds).size, "main IDs repeat");
  assert(fixtures.fixtures.length === 4, "fixture manifest must contain four excluded inputs");
  for (const run of runs) {
    const path = transcriptPath(run);
    const bytes = readFileSync(path);
    assert(bytes.length < 18_000, `${run.transcriptId} exceeds one-read size ceiling`);
    assert(bytes.length >= 4_000, `${run.transcriptId} is not a long transcript`);
    const text = bytes.toString("utf8");
    for (const pattern of requiredPhenomena) {
      assert(pattern.test(text), `${run.transcriptId} lacks required phenomenon ${pattern}`);
    }
    const fixture = fixtures.fixtures.find((entry) => entry.runId === run.runId);
    assert(fixture?.sha256 === sha256(bytes) && fixture.bytes === bytes.length, `${run.runId} fixture hash mismatch`);
    const gold = readJson(goldPath(run));
    assert(gold.transcriptId === run.transcriptId, `${run.runId} gold identity mismatch`);
    assert(gold.expectedItems.length >= 8, `${run.runId} gold is too small`);
    assert(gold.expectedOmissions.length >= 4, `${run.runId} omission policy is not instantiated`);
    for (const item of gold.expectedItems) {
      assert(item.owner && item.action && Array.isArray(item.sourceSpans), `${run.runId} gold tuple is incomplete`);
      assert(["open", "conditional", "blocked"].includes(item.status), `${run.runId} gold status invalid`);
      assert(["critical", "normal"].includes(item.criticality), `${run.runId} gold criticality invalid`);
      for (const span of item.sourceSpans) {
        const lines = text.split(/\r?\n/u).slice(span.startLine - 1, span.endLine).join("\n");
        assert(lines.includes(span.quote), `${run.runId} gold quote is not grounded at ${span.startLine}-${span.endLine}`);
      }
    }
  }
  const agent = readFileSync(resolve(experimentRoot, "candidate", ".github", "agents", "action-item-haiku.agent.md"), "utf8");
  const skill = readFileSync(resolve(experimentRoot, "candidate", ".github", "skills", "action-item-extraction", "SKILL.md"), "utf8");
  assert(/tools:\s*\["read",\s*"edit"\]/u.test(agent), "worker tools are not exactly read and edit");
  assert(agent.includes("model: claude-haiku-4.5"), "worker model is not fixed Haiku");
  assert(agent.includes("exactly once in one structured `read`"), "one-read instruction missing");
  assert(agent.includes("exactly once in one structured `edit`"), "one-edit instruction missing");
  assert(skill.includes("action-item-haiku"), "Skill route mismatch");
  const manifest = candidateManifest();
  assert(gate.candidateFileSetSha256 === manifest.fileSetSha256, "frozen candidate hash differs");
  assert(gate.transcriptSha256 === sha256(readFileSync(transcriptPath(runs[0]))), "smoke transcript hash differs");
  assert(JSON.stringify(gate.exactCliArgs) === JSON.stringify(cliArgs(runs[0])), "frozen CLI args differ");
  assert(JSON.stringify(gate.availableTools) === JSON.stringify(availableTools), "tool filter mismatch");
  assert(gate.frozenBeforeStart === true && gate.permanentlyExcludedFromConfirmation === true, "smoke gate is not frozen/excluded");
  return { fixtures: runs.length, candidateFiles: manifest.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateFoundation();
  process.stdout.write(`Validated ${result.fixtures} excluded transcripts and ${result.candidateFiles} candidate files\n`);
}
