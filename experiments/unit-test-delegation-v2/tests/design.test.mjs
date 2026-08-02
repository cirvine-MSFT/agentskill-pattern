import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tasks as v1Tasks } from "../../unit-test-delegation/corpus/catalog.mjs";
import { getTask, tasks } from "../corpus/catalog.mjs";
import { analyzeMain, evaluatePilot, finalizeDuplicateFlags } from "../scripts/analysis.mjs";
import {
  assertNoRun,
  canonical,
  evaluate,
  evaluateTrace,
  generateSchedule,
  materialize,
  parseCoverage,
  readJson,
  root,
  sha256,
  validateCatalog
} from "../scripts/lib.mjs";

test("fresh catalog gold and mutants are deterministic and discriminating", () => {
  assert.deepEqual(validateCatalog(), { taskCount: 7, hiddenCaseCount: 36, mutantCount: 28 });
  assert.deepEqual(tasks.map((entry) => entry.id), ["P11", "P12", "P13", "M11", "M12", "M13", "M14"]);
  assert.equal(tasks.some((entry) => v1Tasks.some((prior) => prior.id === entry.id)), false);
  const priorTaskHashes = new Set(v1Tasks.flatMap((entry) => [
    sha256(entry.candidate.requirements),
    sha256(entry.gold),
    sha256(canonical(entry.hiddenCases)),
    sha256(canonical(entry.mutants))
  ]));
  for (const entry of tasks) {
    for (const value of [
      entry.candidate.requirements,
      entry.gold,
      canonical(entry.hiddenCases),
      canonical(entry.mutants)
    ]) assert.equal(priorTaskHashes.has(sha256(value)), false, `${entry.id} reuses a v1 task artifact`);
  }
});

test("schedule contains three excluded pilot pairs and 24 held-out main pairs", () => {
  const generated = generateSchedule();
  const checkedIn = readJson(path.join(root, "design", "schedule.json"));
  assert.equal(canonical(generated), canonical(checkedIn));
  assert.equal(generated.pilot.length, 3);
  assert.equal(generated.main.length, 24);
  const ids = new Set();
  for (const block of [...generated.pilot, ...generated.main]) {
    assert.deepEqual([...block.arms].sort(), ["A1", "A2"]);
    for (const observation of block.observations) {
      assert.equal(ids.has(observation.observationId), false);
      assert.equal(/(?:P0[12]|M0[1-6])/u.test(observation.observationId), false);
      ids.add(observation.observationId);
    }
  }
});

test("candidate materialization freezes framework, sentinel, and Sonnet routing without evaluator leakage", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-materialize-"));
  const output = path.join(parent, "candidate");
  try {
    const result = materialize({ taskId: "M14", arm: "A2", runId: "materialize-v2-m14-a2", out: output });
    const files = readJson(path.join(output, ".study", "candidate-manifest.json")).files.map((entry) => entry.path);
    assert(files.includes(".github/agents/unit-test-author-sonnet-v2.agent.md"));
    assert(files.includes(".github/skills/unit-test-authoring/SKILL.md"));
    assert(!files.some((file) => /(?:gold|hidden|mutant|schedule|evidence)/iu.test(file)));
    assert.deepEqual(result.envelope.framework, {
      runner: "node:test",
      assertions: "node:assert/strict",
      moduleSystem: "commonjs"
    });
    assert.equal(fs.readFileSync(path.join(output, result.envelope.targetTestPath), "utf8"),
      result.envelope.targetSentinel);
    assert.throws(() =>
      materialize({ taskId: "M14", arm: "A2", runId: "materialize-v2-m14-a2", out: output }),
    /already exists/u);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("trace evaluator enforces frozen reads, one direct target write, and parent trust", () => {
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
    { seq: 4, actor: "worker", kind: "edit", path: "test/feature.test.js" },
    { seq: 5, actor: "worker", kind: "terminal" }
  ];
  assert.deepEqual(evaluateTrace({ events }, envelope), { adherent: true, reasons: [] });
  const targetRead = evaluateTrace({ events: [
    ...events.slice(0, 4),
    { seq: 4, actor: "worker", kind: "view", path: "test/feature.test.js" },
    ...events.slice(4).map((entry) => ({ ...entry, seq: entry.seq + 1 }))
  ] }, envelope);
  assert.equal(targetRead.adherent, false);
  assert(targetRead.reasons.includes("worker read set/count mismatch"));
  const parentReview = evaluateTrace({ events: [
    ...events,
    { seq: 6, actor: "parent", kind: "shell", path: null }
  ] }, envelope);
  assert.equal(parentReview.adherent, false);
  assert(parentReview.reasons.includes("parent tool after worker return"));
});

test("coverage parser selects the feature branch and line columns", () => {
  const report = "# src/feature.js | 88.89 | 80.00 | 66.67 | 10-11\n# all files | 99.00 | 98.00 | 97.00 |";
  assert.deepEqual(parseCoverage(report), { branch: 0.8, statement: 0.8889 });
});

test("external evaluator separates P11 feature correctness from mutation quality", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-evaluate-"));
  const output = path.join(parent, "candidate");
  try {
    materialize({ taskId: "P11", arm: "A2", runId: "evaluate-v2-p11-a2", out: output });
    fs.writeFileSync(path.join(output, "src", "feature.js"), getTask("P11").gold);
    fs.writeFileSync(path.join(output, "test", "feature.test.js"), `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAllocationSpec } = require("../src/feature.js");
test("parses lines and preserves tag order", () => {
  assert.deepEqual(parseAllocationSpec("# c\\n OPS | 1.25 | z,a"), {
    allocations: [{ line: 2, account: "OPS", amountCents: 125, tags: ["z", "a"] }],
    totalCents: 125
  });
});
test("rejects duplicate accounts", () => {
  assert.throws(() => parseAllocationSpec("OPS|1.00|a\\nOPS|2.00|b"), /duplicate/u);
});
test("requires exact cents", () => {
  assert.throws(() => parseAllocationSpec("OPS|1.2|a"), /amount/u);
});
test("reports physical line positions", () => {
  assert.equal(parseAllocationSpec("\\n\\nOPS|1.00|a").allocations[0].line, 3);
});
`);
    const trace = { events: [
      { seq: 0, actor: "parent", kind: "task", toolName: "task" },
      { seq: 1, actor: "worker", kind: "view", path: "TASK.md" },
      { seq: 2, actor: "worker", kind: "view", path: "src/feature.js" },
      { seq: 3, actor: "worker", kind: "view", path: "test/conventions.test.js" },
      { seq: 4, actor: "worker", kind: "edit", path: "test/feature.test.js" },
      { seq: 5, actor: "worker", kind: "terminal" }
    ] };
    const result = evaluate({ workspace: output, taskId: "P11", arm: "A2", trace });
    assert.equal(result.feature.score, 1);
    assert.equal(result.tests.visiblePass, true);
    assert.equal(result.tests.goldPass, true);
    assert.equal(result.tests.mutants.length, 4);
    assert(result.tests.mutants.every((mutant) => mutant.killed));
    assert.notEqual(result.tests.branchCoverage, null);
    assert.equal(result.adherence.adherent, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("no-run attestation authorizes only the guarded excluded pilot", () => {
  assert.deepEqual(assertNoRun(), {
    pilot: "authorized",
    main: "forbidden",
    evidencePresent: false,
    observationsStarted: 0,
    idsConsumed: 0
  });
});

function syntheticObservation({ observationId, blockId, taskId, repetition, arm }) {
  const treatment = arm === "A2";
  return {
    schemaVersion: 2,
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
      parent: {
        credits: treatment ? 5 : 10,
        nanoAiu: treatment ? 5_000_000_000 : 10_000_000_000,
        inputTokens: treatment ? 5000 : 10000,
        outputTokens: 1000,
        completions: treatment ? 3 : 5
      },
      worker: treatment
        ? { credits: 2.5, nanoAiu: 2_500_000_000, inputTokens: 2500, outputTokens: 700, completions: 1 }
        : { credits: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, completions: 0 },
      combinedCredits: treatment ? 7.5 : 10,
      combinedNanoAiu: treatment ? 7_500_000_000 : 10_000_000_000,
      totalModelTokens: treatment ? 9200 : 11000
    },
    parentContext: {
      cumulativeInputTokens: treatment ? 7000 : 10000,
      peakInputTokens: treatment ? 8500 : 10000
    },
    timing: {
      parentActiveMs: treatment ? 7000 : 10000,
      workerActiveMs: treatment ? 3000 : 0,
      parentWaitMs: treatment ? 3000 : 0,
      wallMs: treatment ? 11000 : 10000
    },
    tools: { parentCalls: treatment ? 5 : 8, workerCalls: treatment ? 4 : 0, resultBytes: 500 },
    evaluation: {
      feature: { score: 1 },
      tests: {
        normalizedHash: `${taskId}-${arm}-${repetition}`,
        duplicate: null,
        trivial: false,
        visiblePass: true,
        goldPass: true,
        branchCoverage: 1,
        components: {
          compilePass: 1,
          meaningfulAssertions: 1,
          mutantKill: 1,
          branchCoverage: 1,
          statementCoverage: 1,
          noFalsePositive: 1,
          isolation: 1,
          nontrivial: 1
        }
      },
      adherence: { adherent: true, reasons: [] }
    },
    diagnostics: []
  };
}

test("analysis applies prospective economics, quality, pilot, and guardrail gates", () => {
  const schedule = generateSchedule();
  const expand = (blocks) => blocks.flatMap((block) =>
    block.observations.map((observation) =>
      syntheticObservation({ ...observation, blockId: block.blockId, taskId: block.taskId, repetition: block.repetition })));
  const main = expand(schedule.main);
  const result = analyzeMain(main);
  assert.equal(result.pairCount, 24);
  assert.equal(result.positiveSignal, true);
  assert.equal(result.ratios.combinedCredits.estimate.toFixed(2), "0.75");
  const invalid = structuredClone(main);
  invalid.find((entry) => entry.arm === "A2").usage.combinedCredits = 0;
  assert.throws(() => analyzeMain(invalid), /credit arithmetic mismatch/u);
  const duplicates = structuredClone(main.slice(0, 2));
  duplicates[1].taskId = duplicates[0].taskId;
  duplicates[1].evaluation.tests.normalizedHash = duplicates[0].evaluation.tests.normalizedHash;
  assert(finalizeDuplicateFlags(duplicates).every((entry) => entry.evaluation.tests.duplicate));
  const pilot = expand(schedule.pilot);
  const pilotResult = evaluatePilot(pilot);
  assert.equal(pilotResult.decision, "GO");
  assert.equal(pilotResult.validPairs.length, 3);
  const oneFailure = structuredClone(pilot);
  oneFailure[0].status = "malformed-result";
  assert.equal(evaluatePilot(oneFailure).decision, "GO");
});
