import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import {
  buildCopilotArgs,
  dryRun,
  freezeCandidatePolicy,
  inspectCandidateLaunch,
  markStarted,
  reserveSlot,
  rootsOverlap,
  terminalDisposition
} from "../scripts/pilot-runner.mjs";

const run = {
  observationId: "V2P-01-A2-0123456789",
  arm: "A2",
  parentSessionId: "10000000-0000-4000-a000-000000000001",
  workerSessionId: "20000000-0000-4000-a000-000000000002",
  worktreeId: "30000000-0000-4000-a000-000000000003"
};

test("runner is explicitly non-executing and exposes the frozen pilot order", () => {
  const result = dryRun();
  assert.equal(result.canExecute, false);
  assert.deepEqual(result.modes, ["dry-run", "preflight"]);
  assert.equal(result.pilotOrder.length, 12);
});

test("runner rejects equal and nested external roots", () => {
  const root = resolve(tmpdir(), "documentation-v2-external");
  assert.equal(rootsOverlap(root, root), true);
  assert.equal(rootsOverlap(root, resolve(root, "nested")), true);
  assert.equal(rootsOverlap(resolve(root, "nested"), root), false);
  assert.equal(
    rootsOverlap(resolve(tmpdir(), "documentation-v2-a"), resolve(tmpdir(), "documentation-v2-b")),
    false
  );
});

test("exact CLI arguments pin model, effort, tools, and candidate root", () => {
  const candidate = resolve(tmpdir(), "v2-candidate-cli");
  const args = buildCopilotArgs(run, candidate, ["example-mcp"]);
  assert.deepEqual(args.slice(0, 8), [
    "-p", args[1],
    "--session-id", run.parentSessionId,
    "--model", "gpt-5.6-sol",
    "--output-format", "json"
  ]);
  assert(args.includes(`--available-tools=read,edit,bash,skill,task`));
  assert(args.includes("--disable-builtin-mcps"));
  assert(args.includes("--no-custom-instructions"));
  assert.deepEqual(args.slice(-4), ["--context", "default", "--effort", "medium"]);

  const inspection = inspectCandidateLaunch({
    candidateRoot: candidate,
    args,
    environment: {PATH: "safe"},
    forbiddenPaths: [resolve(tmpdir(), "hidden-evaluator"), resolve(tmpdir(), "evidence")]
  });
  assert.equal(inspection.pass, true);
  const disclosed = inspectCandidateLaunch({
    candidateRoot: candidate,
    args: [...args, resolve(tmpdir(), "hidden-evaluator")],
    environment: {},
    forbiddenPaths: [resolve(tmpdir(), "hidden-evaluator")]
  });
  assert.equal(disclosed.pass, false);
});

test("candidate policy is immutable in memory and ignores later manifest mutation", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-policy-"));
  try {
    mkdirSync(resolve(root, "docs"));
    mkdirSync(resolve(root, "src"));
    writeFileSync(resolve(root, "CANDIDATE.json"), JSON.stringify({
      protocolId: "feature-documentation-delegation-v2-sonnet",
      sourcePath: "src/index.mjs",
      docTarget: "docs/guide.md",
      allowedWorkerReads: ["TASK.md", "docs/CONVENTIONS.md", "src/index.mjs", "docs/guide.md"],
      allowedWorkerWrites: ["docs/guide.md"],
      workerEditCount: 1
    }));
    const policy = freezeCandidatePolicy(root);
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.allowedWorkerReads), true);
    writeFileSync(resolve(root, "CANDIDATE.json"), JSON.stringify({
      protocolId: "feature-documentation-delegation-v2-sonnet",
      sourcePath: "../escape",
      docTarget: "../escape",
      allowedWorkerReads: ["../escape"],
      allowedWorkerWrites: ["../escape"],
      workerEditCount: 99
    }));
    assert.equal(policy.docTarget, resolve(root, "docs", "guide.md"));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("lifecycle files are write-once and reject duplicate start or disposition", () => {
  const root = mkdtempSync(resolve(tmpdir(), "documentation-v2-locks-"));
  try {
    const lock = reserveSlot(root, run, "a".repeat(64));
    assert.throws(() => reserveSlot(root, run, "a".repeat(64)));
    const started = markStarted(lock);
    assert.equal(started.startCount, 1);
    assert.throws(() => markStarted(lock), /more than once/iu);
    terminalDisposition(lock, "completed");
    assert.throws(() => terminalDisposition(lock, "failed"), /terminal disposition/iu);
    assert.equal(
      JSON.parse(readFileSync(resolve(lock, "terminal.json"), "utf8")).disposition,
      "completed"
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
