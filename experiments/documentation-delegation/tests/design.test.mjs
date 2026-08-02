import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import {evaluate} from "../scripts/evaluate.mjs";
import {evaluateAdherence} from "../scripts/evaluate-adherence.mjs";
import {materializeFixture} from "../scripts/generate-fixture.mjs";
import {createSchedule} from "../scripts/schedule.mjs";
import {verifyNoRun} from "../scripts/verify-no-run.mjs";
import {experimentRoot, walkFiles} from "../scripts/lib.mjs";

test("schedule freezes 24 paired main blocks and separate pilot IDs", () => {
  const first = createSchedule();
  const second = createSchedule();
  assert.deepEqual(first, second);
  assert.equal(first.main.length, 24);
  assert.equal(first.pilot.length, 2);
  assert.equal(first.main.flatMap((block) => block.runs).length, 48);
  assert.equal(first.pilot.flatMap((block) => block.runs).length, 4);
  for (const block of [...first.main, ...first.pilot]) {
    assert.deepEqual(new Set(block.runs.map((run) => run.arm)), new Set(["A1", "A2"]));
    assert.equal(new Set(block.runs.map((run) => run.parentSessionId)).size, 2);
    assert.equal(block.runs.find((run) => run.arm === "A1").workerSessionId, null);
    assert.match(block.runs.find((run) => run.arm === "A2").workerSessionId, /^[a-f0-9-]{36}$/u);
  }
});

test("materializer keeps hidden checks outside the candidate and precreates target", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-fixture-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "cursor-pagination",
      variantId: "v2",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "TEST"
    });
    assert.equal(readFileSync(resolve(candidate, "docs", "pagination-guide.md"), "utf8"), "");
    assert.match(readFileSync(resolve(candidate, "TASK.md"), "utf8"), /default limit is 3/iu);
    assert.match(readFileSync(resolve(evaluator, "hidden-spec.json"), "utf8"), /featureChecks/u);
    assert.equal(
      walkFiles(candidate).some((path) => /hidden|schedule|evaluator/iu.test(path.replace(candidate, ""))),
      false
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("external evaluator runs feature and documentation examples", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-evaluator-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "pilot-slug-codec",
      variantId: "v1",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "PILOT-TEST"
    });
    writeFileSync(resolve(candidate, "src", "index.mjs"), `export function toSlug(value) {
  const slug = value.toLowerCase().match(/[a-z0-9]+/gu)?.join("-") ?? "";
  if (!slug) throw new Error("empty slug");
  return slug;
}
`);
    const goodDocumentation = `# Slug codec

## Overview

\`toSlug\` lowercases ASCII words and collapses repeated whitespace. It does not
support Unicode transliteration.

## API

Call \`toSlug(value)\` with a string.

## Examples

\`\`\`js executable
import assert from "node:assert/strict";
import {toSlug} from "./src/index.mjs";
assert.equal(toSlug("Hello   Pilot"), "hello-pilot");
\`\`\`

\`\`\`js executable
import assert from "node:assert/strict";
import {toSlug} from "./src/index.mjs";
assert.equal(toSlug("One Two"), "one-two");
\`\`\`

## Errors

Input with no ASCII word produces an empty-result error.
`;
    writeFileSync(resolve(candidate, "docs", "slug-codec.md"), goodDocumentation);
    const result = await evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(result.pass, true, JSON.stringify(result, null, 2));
    assert.equal(result.documentation.unsupportedClaims, 0);

    writeFileSync(resolve(candidate, "docs", "slug-codec.md"), "# Slug\n\nSupports Unicode transliteration.\n");
    const mutant = await evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(mutant.pass, false);
    assert.equal(mutant.documentation.unsupportedClaims, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("feature equality ignores object key insertion order", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-object-order-"));
  try {
    const candidate = resolve(root, "candidate");
    const evaluator = resolve(root, "evaluator");
    materializeFixture({
      fixtureId: "cursor-pagination",
      variantId: "v1",
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: "ORDER-TEST"
    });
    writeFileSync(resolve(candidate, "src", "index.mjs"), `export function paginateRecords(records, options = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  const limit = options.limit ?? 2;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("invalid limit");
  const start = options.cursor === undefined || options.cursor === null
    ? 0
    : Number(/^c:(\\d+)$/u.exec(options.cursor)?.[1]);
  if (!Number.isInteger(start)) throw new Error("invalid cursor");
  const items = records.slice(start, start + limit);
  const nextCursor = start + items.length < records.length ? \`c:\${start + items.length}\` : null;
  return {nextCursor, items};
}
`);
    const result = await evaluate({candidateRoot: candidate, evaluatorRoot: evaluator});
    assert.equal(result.feature.score, 1, JSON.stringify(result.feature, null, 2));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("adherence is derived from exact worker and parent events", () => {
  const root = resolve(tmpdir(), "adherence-candidate");
  const target = resolve(root, "docs", "guide.md");
  const record = {
    arm: "A2",
    workerSessionId: "worker-1",
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
      {type: "agent_invocation", actor: "parent", agent: "feature-documentation-haiku"},
      {type: "session_created", actor: "worker", sessionId: "worker-1", model: "claude-haiku-4.5"},
      {type: "tool", actor: "worker", tool: "read", path: resolve(root, "TASK.md"), success: true},
      {type: "tool", actor: "worker", tool: "edit", path: target, success: true},
      {type: "terminal", actor: "worker", text: `${target} - SUCCESS`}
    ]
  };
  assert.deepEqual(evaluateAdherence(record), {
    schemaVersion: 1,
    arm: "A2",
    adherent: true,
    violations: []
  });
  record.events.push({type: "tool", actor: "parent", tool: "read", path: target, success: true});
  const violation = evaluateAdherence(record);
  assert.equal(violation.adherent, false);
  assert.match(violation.violations.join("\n"), /Parent read or edited/iu);

  const caseVariant = structuredClone(record);
  caseVariant.events.pop();
  caseVariant.events[2].path = resolve(root, "task.md");
  const caseViolation = evaluateAdherence(caseVariant);
  assert.equal(caseViolation.adherent, false);
  assert.match(caseViolation.violations.join("\n"), /outside the allowlist/iu);
});

test("schemas parse and no-run attestation is enforceable", () => {
  for (const path of walkFiles(resolve(experimentRoot, "schemas"))) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), path);
  }
  assert.equal(verifyNoRun(), true);
});
