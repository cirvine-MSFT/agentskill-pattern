import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import {evaluateAdherence} from "../scripts/evaluate-adherence.mjs";
import {evaluate} from "../scripts/evaluate.mjs";
import {materializeFixture} from "../scripts/generate-fixture.mjs";
import {experimentRoot, readJson, walkFiles} from "../scripts/lib.mjs";
import {createSchedule} from "../scripts/schedule.mjs";
import {verifyNoRun} from "../scripts/verify-no-run.mjs";

test("schedule is deterministic, paired, fresh, and sufficiently sized", () => {
  const first = createSchedule();
  assert.deepEqual(first, createSchedule());
  assert.equal(first.main.length, 24);
  assert.equal(first.pilot.length, 6);
  assert.equal(first.main.flatMap((block) => block.runs).length, 48);
  assert.equal(first.pilot.flatMap((block) => block.runs).length, 12);

  const identifiers = new Set();
  for (const block of [...first.main, ...first.pilot]) {
    assert.deepEqual(new Set(block.runs.map((run) => run.arm)), new Set(["A1", "A2"]));
    for (const run of block.runs) {
      for (const id of [
        run.observationId,
        run.parentSessionId,
        run.workerSessionId,
        run.worktreeId
      ].filter(Boolean)) {
        assert.equal(identifiers.has(id), false, `duplicate v2 identifier: ${id}`);
        identifiers.add(id);
      }
    }
  }

  const v1 = readJson(resolve(experimentRoot, "..", "documentation-delegation", "design", "schedule.json"));
  const v1Ids = new Set(JSON.stringify(v1).match(/[A-Za-z0-9-]{8,}/gu) ?? []);
  for (const id of identifiers) assert.equal(v1Ids.has(id), false, `v1 identifier reused: ${id}`);
});

test("materializer withholds evaluator and precreates a fresh bounded target", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-materialize-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "header-preference",
      variantId: "r2",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "V2-TEST"
    });
    assert.equal(readFileSync(resolve(candidate, "docs", "header-preference-cookbook.md"), "utf8"), "");
    assert.match(readFileSync(resolve(candidate, "TASK.md"), "utf8"), /default `options\.minimum` is 0\.5/iu);
    assert.match(readFileSync(resolve(evaluator, "hidden-spec.json"), "utf8"), /featureChecks/u);
    assert.equal(
      walkFiles(candidate).some((path) =>
        /(?:hidden|evaluator|schedule|evidence)/iu.test(path.replace(candidate, ""))),
      false
    );
    const agent = readFileSync(
      resolve(candidate, ".github", "agents", "feature-documentation-sonnet-v2.agent.md"),
      "utf8"
    );
    assert.match(agent, /model: claude-sonnet-4\.6/u);
    assert.match(agent, /tools: \["read", "edit"\]/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("materializer rejects nested roots and keeps paired candidate bytes arm-invariant", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-roots-"));
  try {
    assert.throws(() => materializeFixture({
      fixtureId: "label-fold",
      variantId: "p1",
      candidateRoot: resolve(root, "candidate"),
      evaluatorRoot: resolve(root, "candidate", "evaluator"),
      observationId: "V2-NESTED"
    }), /disjoint/iu);

    const left = resolve(root, "left");
    const right = resolve(root, "right");
    materializeFixture({
      fixtureId: "label-fold",
      variantId: "p1",
      candidateRoot: left,
      evaluatorRoot: resolve(root, "left-evaluator"),
      observationId: "V2P-01-A1-first"
    });
    materializeFixture({
      fixtureId: "label-fold",
      variantId: "p1",
      candidateRoot: right,
      evaluatorRoot: resolve(root, "right-evaluator"),
      observationId: "V2P-01-A2-second"
    });
    const leftManifest = readFileSync(resolve(left, "CANDIDATE.json"), "utf8");
    const rightManifest = readFileSync(resolve(right, "CANDIDATE.json"), "utf8");
    assert.equal(leftManifest, rightManifest);
    assert.doesNotMatch(leftManifest, /V2P|fixtureId|variantId|observationId/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("external evaluator separates feature checks and executable documentation", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-evaluate-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "label-fold",
      variantId: "p1",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "V2-EVAL"
    });
    writeFileSync(resolve(candidate, "src", "index.mjs"), `export function foldLabel(value) {
  if (typeof value !== "string") throw new Error("invalid label");
  const result = value.trim().toLowerCase().replace(/[\\s_]+/gu, "-").replace(/^-|-$/gu, "");
  if (!result) throw new Error("invalid label");
  return result;
}
`);
    writeFileSync(resolve(candidate, "docs", "label-fold-guide.md"), `# Label folding

See the [implementation](../src/index.mjs).

## Overview

\`foldLabel\` trims outer whitespace and normalizes labels. Digits are preserved; spaces
and underscores become one dash. It does not perform Unicode transliteration.

## API

Call \`foldLabel(value)\` with a string.

## Examples

\`\`\`js executable
import assert from "node:assert/strict";
import {foldLabel} from "./src/index.mjs";
assert.equal(foldLabel(" Build__42 Ready "), "build-42-ready");
\`\`\`

\`\`\`js executable
import assert from "node:assert/strict";
import {foldLabel} from "./src/index.mjs";
assert.equal(foldLabel("A B"), "a-b");
\`\`\`

## Errors

An empty normalized value throws \`invalid label\`.
`);
    const result = evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(result.pass, true, JSON.stringify(result, null, 2));
    assert.equal(result.feature.score, 1);
    assert.equal(result.documentation.executability, 1);

    writeFileSync(
      resolve(candidate, "docs", "label-fold-guide.md"),
      "# Label folding\n\nSupports Unicode transliteration.\n"
    );
    const mutant = evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(mutant.feature.score, 1);
    assert.equal(mutant.pass, false);
    assert.equal(mutant.documentation.unsupportedClaims, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("evaluator records escaping examples and input mutation as failures instead of crashing", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-mutants-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "chunk-view",
      variantId: "p1",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "V2-MUTANT"
    });
    writeFileSync(resolve(candidate, "src", "index.mjs"), `export function chunkView(values, size) {
  if (Array.isArray(values) && values.length) values.splice(0, 1);
  if (!Array.isArray(values) || !Number.isInteger(size) || size <= 0) throw new Error("invalid chunk");
  return [];
}
`);
    writeFileSync(resolve(candidate, "docs", "chunk-view-guide.md"), `# Chunk view

[escape](../../outside.md)

## Overview

Consecutive copied arrays include the final short chunk; empty input returns an empty array.

## API

\`chunkView(values, size)\` rejects an invalid chunk.

## Examples

\`\`\`console executable
$ node ../outside.mjs
\`\`\`

Prose breaks required adjacency.

\`\`\`text expected
no
\`\`\`

\`\`\`js executable
import {chunkView} from "./src/index.mjs";
chunkView([1], 1);
\`\`\`

## Errors

Invalid sizes throw \`invalid chunk\`.
`);
    const result = evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(result.pass, false);
    assert(result.feature.failures.some((failure) => /mutated/iu.test(failure)));
    assert(result.feature.failures.some((failure) => /Feature 3: argument 0 was mutated/iu.test(failure)));
    assert(result.documentation.details.some((detail) =>
      /Escaping link|missing adjacent|escapes the candidate/iu.test(detail)));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

function adherentRecord(root) {
  const target = resolve(root, "docs", "guide.md");
  return {
    arm: "A2",
    workerSessionId: "worker-v2",
    boundary: {
      caseSensitivePaths: true,
      docTarget: target,
      allowedWorkerReads: [
        resolve(root, "TASK.md"),
        resolve(root, "docs", "CONVENTIONS.md"),
        resolve(root, "src", "index.mjs"),
        target
      ],
      allowedWorkerWrites: [target]
    },
    events: [
      {type: "skill_load", actor: "parent", skill: "feature-documentation-sonnet-v2"},
      {type: "agent_invocation", actor: "parent", agent: "feature-documentation-sonnet-v2"},
      {
        type: "session_created",
        actor: "worker",
        sessionId: "worker-v2",
        requestedModel: "claude-sonnet-4.6",
        observedModel: "claude-sonnet-4.6"
      },
      {type: "tool", actor: "worker", tool: "read", path: resolve(root, "TASK.md"), success: true},
      {
        type: "tool",
        actor: "worker",
        tool: "edit",
        path: target,
        success: true,
        operation: "replace",
        complete: true
      },
      {
        type: "terminal",
        actor: "worker",
        text: JSON.stringify({status: "success", target, replaced: true})
      }
    ]
  };
}

test("adherence accepts exact routing and rejects bypass and pseudo-delegation", () => {
  const record = adherentRecord(resolve(tmpdir(), "documentation-v2-adherence"));
  assert.equal(evaluateAdherence(record).adherent, true);

  const bypass = structuredClone(record);
  bypass.events.shift();
  assert.match(
    evaluateAdherence(bypass).violations.join("\n"),
    /load the routing Skill exactly once/iu
  );

  const pseudo = structuredClone(record);
  pseudo.events = pseudo.events.filter((event) =>
    !["agent_invocation", "session_created"].includes(event.type));
  assert.equal(evaluateAdherence(pseudo).adherent, false);

  const wrongModel = structuredClone(record);
  wrongModel.events[2].observedModel = "claude-haiku-4.5";
  assert.match(evaluateAdherence(wrongModel).violations.join("\n"), /observed model/iu);

  const parentRead = structuredClone(record);
  parentRead.events.push({
    type: "tool",
    actor: "parent",
    tool: "read",
    path: record.boundary.docTarget,
    success: true
  });
  assert.match(evaluateAdherence(parentRead).violations.join("\n"), /Parent used a tool/iu);

  const reversed = adherentRecord(resolve(tmpdir(), "documentation-v2-order"));
  [reversed.events[0], reversed.events[1]] = [reversed.events[1], reversed.events[0]];
  assert.match(evaluateAdherence(reversed).violations.join("\n"), /must be ordered/iu);

  const editBeforeSession = adherentRecord(resolve(tmpdir(), "documentation-v2-edit-order"));
  const session = editBeforeSession.events.splice(2, 1)[0];
  editBeforeSession.events.splice(-1, 0, session);
  assert.match(evaluateAdherence(editBeforeSession).violations.join("\n"), /Routing chain/iu);

  const shellAfterEdit = adherentRecord(resolve(tmpdir(), "documentation-v2-shell"));
  shellAfterEdit.events.splice(-1, 0, {
    type: "tool",
    actor: "parent",
    tool: "bash",
    command: "git diff",
    success: true
  });
  assert.match(evaluateAdherence(shellAfterEdit).violations.join("\n"), /Parent used a tool/iu);
});

test("schemas parse and the zero-observation boundary is enforceable", () => {
  for (const path of walkFiles(resolve(experimentRoot, "schemas"))) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), path);
  }
  assert.equal(verifyNoRun(), true);
});
