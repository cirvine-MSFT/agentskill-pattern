import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTask } from "../corpus/catalog.mjs";
import { analyzeMain, evaluatePilot, finalizeDuplicateFlags } from "../scripts/analysis.mjs";
import { assertNoRun, canonical, evaluate, evaluateTrace, generateSchedule, materialize, parseCoverage, readJson, root, validateCatalog } from "../scripts/lib.mjs";

test("catalog gold and mutants are deterministic and discriminating", () => {
  assert.deepEqual(validateCatalog(), { taskCount: 8, hiddenCaseCount: 40, mutantCount: 32 });
});

test("schedule contains the frozen complete paired sample", () => {
  const generated = generateSchedule();
  const checkedIn = readJson(path.join(root, "design", "schedule.json"));
  assert.equal(canonical(generated), canonical(checkedIn));
  assert.equal(generated.pilot.length, 2);
  assert.equal(generated.main.length, 30);
  for (const block of [...generated.pilot, ...generated.main]) {
    assert.deepEqual([...block.arms].sort(), ["A1", "A2"]);
    assert.equal(new Set(block.observations.map((entry) => entry.observationId)).size, 2);
  }
});

test("candidate materialization excludes evaluator assets and cannot reuse workspace", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd-materialize-"));
  const output = path.join(parent, "candidate");
  try {
    materialize({ taskId: "M03", arm: "A2", runId: "materialize-m03-a2", out: output });
    const files = readJson(path.join(output, ".study", "candidate-manifest.json")).files.map((entry) => entry.path);
    assert(files.includes(".github/agents/unit-test-author-haiku.agent.md"));
    assert(files.includes("test/feature.test.js"));
    assert(!files.some((file) => /(?:gold|hidden|mutant|schedule|evidence)/iu.test(file)));
    assert.throws(() => materialize({ taskId: "M03", arm: "A2", runId: "materialize-m03-a2", out: output }), /already exists/u);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("trace evaluator enforces exact worker reads, one target edit, and parent trust", () => {
  const envelope = {
    requirementsPath: "TASK.md",
    changedProductionPaths: ["src/feature.js"],
    nearbyTestPaths: ["test/conventions.test.js"],
    targetTestPath: "test/feature.test.js"
  };
  const events = [
    { seq: 0, actor: "parent", kind: "task", toolName: "task" },
    { seq: 1, actor: "worker", kind: "view", path: "TASK.md" },
    { seq: 2, actor: "worker", kind: "view", path: "src/feature.js" },
    { seq: 3, actor: "worker", kind: "view", path: "test/conventions.test.js" },
    { seq: 4, actor: "worker", kind: "view", path: "test/feature.test.js" },
    { seq: 5, actor: "worker", kind: "edit", path: "test/feature.test.js" },
    { seq: 6, actor: "worker", kind: "terminal" }
  ];
  assert.deepEqual(evaluateTrace({ events }, envelope), { adherent: true, reasons: [] });
  const windowsEvents = events.map((event) => event.path ? { ...event, path: event.path.replaceAll("/", "\\") } : event);
  assert.deepEqual(evaluateTrace({ events: windowsEvents }, envelope), { adherent: true, reasons: [] });
  const violated = evaluateTrace({ events: [...events, { seq: 7, actor: "parent", kind: "view", path: "test/feature.test.js" }] }, envelope);
  assert.equal(violated.adherent, false);
  assert(violated.reasons.includes("parent tool after worker return"));
});

test("coverage parser selects feature branch and line columns", () => {
  const report = "# src/feature.js | 88.89 | 80.00 | 66.67 | 10-11\n# all files | 99.00 | 98.00 | 97.00 |";
  assert.deepEqual(parseCoverage(report), { branch: 0.8, statement: 0.8889 });
});

test("external evaluator separates feature correctness and test mutation quality", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd-evaluate-"));
  const output = path.join(parent, "candidate");
  try {
    materialize({ taskId: "P01", arm: "A2", runId: "evaluate-p01-a2", out: output });
    fs.writeFileSync(path.join(output, "src", "feature.js"), getTask("P01").gold);
    fs.writeFileSync(path.join(output, "test", "feature.test.js"), `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyAdjustments } = require("../src/feature.js");
test("applies sequential percentages", () => {
  assert.deepEqual(applyAdjustments({ subtotalCents: 1001, adjustments: [{ type: "percent", basisPoints: 3333 }, { type: "percent", basisPoints: 5000 }] }).finalCents, 333);
});
test("clamps fixed reductions", () => {
  assert.equal(applyAdjustments({ subtotalCents: 50, adjustments: [{ type: "fixed", cents: 80 }] }).finalCents, 0);
});
test("rejects invalid percentages", () => {
  assert.throws(() => applyAdjustments({ subtotalCents: 50, adjustments: [{ type: "percent", basisPoints: 10001 }] }), /basisPoints/u);
});
test("rejects unsupported disabled types", () => {
  assert.throws(() => applyAdjustments({ subtotalCents: 50, adjustments: [{ type: "bogus", enabled: false }] }), /unsupported/u);
});
`);
    const trace = { events: [
      { seq: 0, actor: "parent", kind: "task", toolName: "task" },
      { seq: 1, actor: "worker", kind: "view", path: "TASK.md" },
      { seq: 2, actor: "worker", kind: "view", path: "src/feature.js" },
      { seq: 3, actor: "worker", kind: "view", path: "test/conventions.test.js" },
      { seq: 4, actor: "worker", kind: "view", path: "test/feature.test.js" },
      { seq: 5, actor: "worker", kind: "edit", path: "test/feature.test.js" },
      { seq: 6, actor: "worker", kind: "terminal" }
    ] };
    const result = evaluate({ workspace: output, taskId: "P01", arm: "A2", trace });
    assert.equal(result.feature.score, 1);
    assert.equal(result.tests.visiblePass, true);
    assert.equal(result.tests.goldPass, true);
    assert.equal(result.tests.mutants.length, 4);
    assert(result.tests.mutants.every((mutant) => typeof mutant.killed === "boolean"));
    assert.notEqual(result.tests.branchCoverage, null);
    assert.notEqual(result.tests.statementCoverage, null);
    assert.equal(result.adherence.adherent, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("no-run attestation permits only the guarded excluded pilot without starting it", () => {
  assert.deepEqual(assertNoRun(), {
    pilot: "authorized",
    main: "forbidden",
    evidencePresent: false,
    observationsStarted: 0
  });
});

function syntheticObservation({ observationId, blockId, taskId, repetition, arm }) {
  const treatment = arm === "A2";
  return {
    schemaVersion: 1,
    observationId,
    sessionId: `session-${observationId}`,
    worktreeId: `worktree-${observationId}`,
    candidateCommitSha: "a".repeat(40),
    blockId,
    taskId,
    repetition,
    arm,
    startDisposition: "started",
    status: "complete",
    usage: {
      parent: { credits: treatment ? 6 : 10, nanoAiu: treatment ? 6000000000 : 10000000000, inputTokens: treatment ? 6000 : 10000, outputTokens: 1000, completions: treatment ? 3 : 4 },
      worker: { credits: treatment ? 1 : 0, nanoAiu: treatment ? 1000000000 : 0, inputTokens: treatment ? 2000 : 0, outputTokens: treatment ? 500 : 0, completions: treatment ? 1 : 0 },
      combinedCredits: treatment ? 7 : 10,
      combinedNanoAiu: treatment ? 7000000000 : 10000000000,
      totalModelTokens: treatment ? 9500 : 11000
    },
    parentContext: { cumulativeInputTokens: treatment ? 7000 : 10000, peakInputTokens: treatment ? 8000 : 10000 },
    timing: { parentActiveMs: treatment ? 7000 : 10000, workerActiveMs: treatment ? 3000 : 0, parentWaitMs: treatment ? 3000 : 0, wallMs: treatment ? 12000 : 10000 },
    tools: { parentCalls: treatment ? 5 : 8, workerCalls: treatment ? 6 : 0, resultBytes: 1000 },
    evaluation: {
      feature: { score: 1 },
      tests: {
        normalizedHash: `${taskId}-${arm}`,
        duplicate: null,
        trivial: false,
        visiblePass: true,
        goldPass: true,
        branchCoverage: 1,
        components: { compilePass: 1, meaningfulAssertions: 1, mutantKill: 1, branchCoverage: 1, statementCoverage: 1, noFalsePositive: 1, isolation: 1, nontrivial: 1 }
      },
      adherence: { adherent: true, reasons: [] }
    }
  };
}

test("analysis applies the frozen paired gates and pilot boundary", () => {
  const schedule = generateSchedule();
  const main = schedule.main.flatMap((block) => block.observations.map((observation) => syntheticObservation({ ...observation, blockId: block.blockId, taskId: block.taskId, repetition: block.repetition })));
  const result = analyzeMain(main);
  assert.equal(result.pairCount, 30);
  assert.equal(result.positiveSignal, true);
  assert.equal(result.ratios.combinedCredits.estimate.toFixed(2), "0.70");
  const invalidRatio = structuredClone(main);
  invalidRatio.find((entry) => entry.arm === "A2").usage.combinedCredits = 0;
  assert.throws(() => analyzeMain(invalidRatio), /credit arithmetic mismatch/u);
  const zeroRatio = structuredClone(main);
  const zeroTreatment = zeroRatio.find((entry) => entry.arm === "A2");
  Object.assign(zeroTreatment.usage.parent, { credits: 0, nanoAiu: 0 });
  Object.assign(zeroTreatment.usage.worker, { credits: 0, nanoAiu: 0 });
  Object.assign(zeroTreatment.usage, { combinedCredits: 0, combinedNanoAiu: 0 });
  assert.equal(analyzeMain(zeroRatio).gates.combinedCredits, false);
  const duplicates = structuredClone(main.slice(0, 2));
  duplicates[1].taskId = duplicates[0].taskId;
  duplicates[1].evaluation.tests.normalizedHash = duplicates[0].evaluation.tests.normalizedHash;
  assert(finalizeDuplicateFlags(duplicates).every((entry) => entry.evaluation.tests.duplicate));
  const pilot = schedule.pilot.flatMap((block) => block.observations.map((observation) => syntheticObservation({ ...observation, blockId: block.blockId, taskId: block.taskId, repetition: block.repetition })));
  const pilotResult = evaluatePilot(pilot);
  assert.equal(pilotResult.decision, "GO");
  assert.equal(pilotResult.observations.length, 4);
  assert.match(pilotResult.sourceManifestRootHash, /^[a-f0-9]{64}$/u);
});
