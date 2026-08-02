import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createMutant, getTask, tasks } from "../corpus/catalog.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sentinelPrefix = "// UNIT_TEST_SENTINEL:";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function generateSchedule(study = readJson(path.join(root, "design", "study.json"))) {
  let counter = 0;
  const draw = (label) => sha256(`${study.seed}|${counter++}|${label}`);
  const build = (phase, ids, repetitions) => {
    const blocks = [];
    for (const taskId of ids) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const blockId = `${phase}-${taskId}-r${String(repetition).padStart(2, "0")}`;
        const first = Number.parseInt(draw(`${blockId}|arm`).slice(0, 8), 16) % 2 === 0 ? "A1" : "A2";
        blocks.push({
          blockId,
          taskId,
          repetition,
          orderKey: draw(`${blockId}|order`),
          arms: first === "A1" ? ["A1", "A2"] : ["A2", "A1"]
        });
      }
    }
    return blocks.sort((left, right) => left.orderKey.localeCompare(right.orderKey)).map(({ orderKey, ...block }, blockIndex) => ({
      ...block,
      blockIndex: blockIndex + 1,
      observations: block.arms.map((arm, armIndex) => ({
        arm,
        order: armIndex + 1,
        observationId: `${block.blockId}-${arm}`
      }))
    }));
  };
  return {
    schemaVersion: 1,
    seed: study.seed,
    algorithm: "sha256-counter-sort-v1",
    pilot: build("pilot", study.pilot.tasks, study.pilot.repetitions),
    main: build("main", study.main.tasks, study.main.repetitions)
  };
}

export function validateCatalog() {
  const ids = new Set();
  for (const task of tasks) {
    assert.match(task.id, /^(?:P|M)\d{2}$/u);
    assert(!ids.has(task.id), `duplicate task ${task.id}`);
    ids.add(task.id);
    assert.equal(task.phase, task.id.startsWith("P") ? "pilot" : "main");
    assert(task.candidate.requirements.length >= 600, `${task.id} requirements too small`);
    assert(task.gold.length >= 900, `${task.id} production task too small`);
    assert(task.hiddenCases.length >= 4, `${task.id} hidden cases too small`);
    assert(task.mutants.length >= 4, `${task.id} mutant set too small`);
    compileSource(task.gold, `${task.id}-gold`);
    for (const mutant of task.mutants) compileSource(createMutant(task, mutant), `${task.id}-${mutant.id}`);
    const gold = runHiddenCases(task.gold, task);
    assert.equal(gold.passed, gold.total, `${task.id} gold failed hidden cases: ${gold.failures.join("; ")}`);
    for (const mutant of task.mutants) {
      const score = runHiddenCases(createMutant(task, mutant), task);
      assert(score.passed < score.total, `${task.id}/${mutant.id} is equivalent to hidden cases`);
    }
  }
  assert.equal(tasks.filter((task) => task.phase === "pilot").length, 2);
  assert.equal(tasks.filter((task) => task.phase === "main").length, 6);
  return { taskCount: tasks.length, hiddenCaseCount: tasks.reduce((sum, task) => sum + task.hiddenCases.length, 0), mutantCount: tasks.reduce((sum, task) => sum + task.mutants.length, 0) };
}

function compileSource(source, label) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "utd-compile-")), `${label}.cjs`);
  try {
    fs.writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

export function runHiddenCases(source, task) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "utd-hidden-"));
  const file = path.join(directory, "feature.cjs");
  const failures = [];
  let feature;
  try {
    fs.writeFileSync(file, source);
    const require = createRequire(import.meta.url);
    delete require.cache[file];
    feature = require(file)[task.exportName];
    assert.equal(typeof feature, "function");
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    return { passed: 0, total: task.hiddenCases.length, failures: [`load: ${error.message}`] };
  }
  for (const testCase of task.hiddenCases) {
    try {
      let result;
      if (testCase.error) {
        assert.throws(() => testCase.spread ? feature(...testCase.input) : feature(testCase.input), new RegExp(testCase.error, "iu"));
      } else {
        result = testCase.spread ? feature(...testCase.input) : feature(testCase.input);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), testCase.expected);
        if (testCase.nullPrototype) {
          for (const record of result) assert.equal(Object.getPrototypeOf(record), null);
        }
      }
    } catch (error) {
      failures.push(`${testCase.name}: ${error.message}`);
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
  return { passed: task.hiddenCases.length - failures.length, total: task.hiddenCases.length, failures };
}

function sharedSource() {
  return `"use strict";
function normalizeCode(value) {
  if (typeof value !== "string") throw new TypeError("code must be a string");
  return value.trim().toUpperCase();
}
module.exports = { normalizeCode };
`;
}

function nearbyTest() {
  return `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCode } = require("../src/shared.js");

test("normalizeCode trims and normalizes case", () => {
  assert.equal(normalizeCode(" ab-1 "), "AB-1");
});

test("normalizeCode rejects non-string values", () => {
  assert.throws(() => normalizeCode(null), /string/u);
});
`;
}

export function materialize({ taskId, arm, runId, out }) {
  const task = getTask(taskId);
  if (!["A1", "A2"].includes(arm)) throw new Error("arm must be A1 or A2");
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/u.test(runId)) throw new Error("invalid run ID");
  const output = path.resolve(out);
  if (fs.existsSync(output)) throw new Error("output already exists; run IDs/workspaces are never reused");
  fs.mkdirSync(path.join(output, "src"), { recursive: true });
  fs.mkdirSync(path.join(output, "test"), { recursive: true });
  fs.mkdirSync(path.join(output, ".study"), { recursive: true });
  fs.writeFileSync(path.join(output, "src", "shared.js"), sharedSource());
  fs.writeFileSync(path.join(output, "src", "feature.js"), task.candidate.starter);
  fs.writeFileSync(path.join(output, "test", "conventions.test.js"), nearbyTest());
  fs.writeFileSync(path.join(output, "test", "feature.test.js"), `${sentinelPrefix}${runId}\n`);
  fs.writeFileSync(path.join(output, "TASK.md"), `# ${task.candidate.title}\n\n${task.candidate.requirements}\n`);
  writeJson(path.join(output, "package.json"), { name: `unit-test-study-${task.id.toLowerCase()}`, private: true, version: "1.0.0", scripts: { test: "node --test test/*.test.js" } });
  const envelope = {
    runId,
    requirementsPath: "TASK.md",
    changedProductionPaths: task.candidate.changedFiles,
    nearbyTestPaths: task.candidate.nearbyTests,
    targetTestPath: task.candidate.targetTest
  };
  envelope.statusHash = sha256(canonical(envelope));
  writeJson(path.join(output, ".study", "envelope.json"), envelope);
  const armInstruction = arm === "A1"
    ? "Implement the production feature and write comprehensive unit tests in test/feature.test.js yourself. Run the visible tests and fix your production code or tests as needed."
    : "Implement the production feature first. Then invoke the unit-test-authoring Skill exactly once with .study/envelope.json. Trust its result: after it returns, do not read, search, run, grade, edit, repair, rewrite, or describe test/feature.test.js.";
  fs.writeFileSync(path.join(output, "PROMPT.md"), `Implement the feature in TASK.md. You own requirements understanding, production code, integration, and a compact final response.\n\n${armInstruction}\n`);
  if (arm === "A2") {
    fs.cpSync(path.join(root, "candidate", ".github"), path.join(output, ".github"), { recursive: true });
  }
  const candidateFiles = listFiles(output);
  assert(!candidateFiles.some((file) => /(?:gold|hidden|mutant|schedule|evidence)/iu.test(file)), "candidate leakage");
  writeJson(path.join(output, ".study", "candidate-manifest.json"), {
    schemaVersion: 1,
    taskId,
    phase: task.phase,
    arm,
    runId,
    files: candidateFiles.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(output, file))) }))
  });
  execFileSync("git", ["init", "--quiet"], { cwd: output });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: output });
  execFileSync("git", ["config", "user.email", "study@example.invalid"], { cwd: output });
  execFileSync("git", ["config", "user.name", "Study Harness"], { cwd: output });
  execFileSync("git", ["add", "."], { cwd: output });
  execFileSync("git", ["commit", "--quiet", "-m", "Materialize observation"], {
    cwd: output,
    env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" }
  });
  const candidateCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: output, encoding: "utf8" }).trim();
  return { output, envelope, candidateCommitSha };
}

export function listFiles(directory) {
  const output = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else output.push(path.relative(directory, absolute).replaceAll("\\", "/"));
    }
  };
  visit(directory);
  return output.sort();
}

function runTests(workspace, source, coverage = false) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "utd-tests-"));
  try {
    fs.cpSync(workspace, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "src", "feature.js"), source);
    const args = coverage
      ? ["--experimental-test-coverage", "--test", "test/conventions.test.js", "test/feature.test.js"]
      : ["--test", "test/conventions.test.js", "test/feature.test.js"];
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { cwd: copy, encoding: "utf8", timeout: 30000, env: environment });
    const parsedCoverage = parseCoverage(result.stdout ?? "");
    if (coverage && parsedCoverage.branch === null) throw new Error(`unable to parse Node coverage report:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return { passed: result.status === 0, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", coverage: parsedCoverage };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

export function parseCoverage(output) {
  const lines = output.split(/\r?\n/u);
  const line = lines.find((entry) => /(?:^|\s)(?:src[\\/])?feature\.js\s*\|/iu.test(entry));
  if (!line) return { branch: null, statement: null };
  const numbers = line.split("|").slice(1).map((value) => Number.parseFloat(value.trim())).filter(Number.isFinite);
  return { branch: numbers.length >= 2 ? numbers[1] / 100 : null, statement: numbers.length >= 1 ? numbers[0] / 100 : null };
}

function inspectTests(source) {
  const assertions = [...source.matchAll(/\bassert\.(?:equal|deepEqual|strictEqual|throws|rejects|match|ok|notEqual|notDeepEqual)\s*\(/gu)].length;
  const declarations = [...source.matchAll(/\btest\s*\(/gu)].length;
  const normalized = source.replace(/\/\/.*$/gmu, "").replace(/\s+/gu, " ").trim();
  return {
    assertions,
    declarations,
    normalizedHash: sha256(normalized),
    trivial: assertions < 3 || declarations < 3 || source.includes(sentinelPrefix)
  };
}

export function evaluate({ workspace, taskId, arm, trace = null }) {
  const task = getTask(taskId);
  const production = fs.readFileSync(path.join(workspace, "src", "feature.js"), "utf8");
  const testSource = fs.readFileSync(path.join(workspace, "test", "feature.test.js"), "utf8");
  const hidden = runHiddenCases(production, task);
  const visible = runTests(workspace, production, true);
  const goldTests = runTests(workspace, task.gold);
  const mutants = task.mutants.map((mutant) => {
    const result = runTests(workspace, createMutant(task, mutant));
    return { id: mutant.id, killed: !result.passed };
  });
  const staticTests = inspectTests(testSource);
  const adherence = arm === "A2" ? evaluateTrace(trace, readJson(path.join(workspace, ".study", "envelope.json")), workspace) : { adherent: true, reasons: [] };
  const components = {
    compilePass: visible.passed ? 1 : 0,
    meaningfulAssertions: staticTests.assertions >= 3 ? 1 : 0,
    mutantKill: mutants.filter((mutant) => mutant.killed).length / mutants.length,
    branchCoverage: visible.coverage.branch ?? 0,
    statementCoverage: visible.coverage.statement ?? 0,
    noFalsePositive: goldTests.passed ? 1 : 0,
    isolation: adherence.adherent ? 1 : 0,
    nontrivial: staticTests.trivial ? 0 : 1
  };
  return {
    schemaVersion: 1,
    taskId,
    arm,
    feature: { passed: hidden.passed, total: hidden.total, score: hidden.passed / hidden.total, failures: hidden.failures },
    tests: {
      visiblePass: visible.passed,
      goldPass: goldTests.passed,
      assertions: staticTests.assertions,
      declarations: staticTests.declarations,
      normalizedHash: staticTests.normalizedHash,
      duplicate: null,
      trivial: staticTests.trivial,
      mutants,
      branchCoverage: visible.coverage.branch,
      statementCoverage: visible.coverage.statement,
      components,
      compositeBeforeDuplicate: Object.values(components).reduce((sum, value) => sum + value, 0) / Object.keys(components).length
    },
    adherence
  };
}

function normalizeTracePath(value, workspace) {
  if (typeof value !== "string") return "";
  let candidate = value;
  if (workspace && path.isAbsolute(candidate)) {
    const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return `!outside/${candidate.replaceAll("\\", "/")}`;
    candidate = relative;
  }
  return candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function evaluateTrace(trace, envelope, workspace = null) {
  const reasons = [];
  if (!trace || !Array.isArray(trace.events)) return { adherent: false, reasons: ["missing trace"] };
  const suppliedReads = [envelope.requirementsPath, ...envelope.changedProductionPaths, ...envelope.nearbyTestPaths, envelope.targetTestPath].map((value) => normalizeTracePath(value, workspace)).sort();
  const worker = trace.events.filter((event) => event.actor === "worker");
  const sequences = trace.events.map((event) => event.seq);
  if (sequences.some((value) => !Number.isInteger(value)) || new Set(sequences).size !== sequences.length || sequences.some((value, index) => index > 0 && value <= sequences[index - 1])) reasons.push("trace sequence mismatch");
  const parentTasks = trace.events.filter((event) => event.actor === "parent" && event.kind === "task");
  if (parentTasks.length !== 1) reasons.push("parent delegation count mismatch");
  const reads = worker.filter((event) => event.kind === "view").map((event) => normalizeTracePath(event.path, workspace)).sort();
  const edits = worker.filter((event) => event.kind === "edit");
  if (canonical(reads) !== canonical(suppliedReads)) reasons.push("worker read set/count mismatch");
  if (edits.length !== 1 || normalizeTracePath(edits[0]?.path, workspace) !== normalizeTracePath(envelope.targetTestPath, workspace)) reasons.push("worker edit mismatch");
  if (worker.some((event) => !["view", "edit", "terminal"].includes(event.kind))) reasons.push("worker used forbidden tool");
  const terminals = worker.filter((event) => event.kind === "terminal");
  const terminalSequence = Math.max(...terminals.map((event) => event.seq), -1);
  if (terminals.length !== 1) reasons.push("worker terminal count mismatch");
  if (trace.events.some((event) => event.actor === "parent" && event.seq > terminalSequence && event.kind !== "terminal")) reasons.push("parent tool after worker return");
  return { adherent: reasons.length === 0, reasons };
}

export function verifySourceManifest() {
  const manifestPath = path.join(root, "design", "source-manifest.json");
  const manifest = readJson(manifestPath);
  const actual = sourceEntries();
  assert.equal(canonical(manifest.files), canonical(actual), "source manifest drift");
  const rootHash = sha256(canonical(actual));
  assert.equal(manifest.rootHash, rootHash, "source manifest root hash drift");
  return { files: actual.length, rootHash };
}

function sourcePaths() {
  return listFiles(root)
    .filter((file) => file !== "design/source-manifest.json")
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("evidence/"));
}

export function sourceEntries() {
  const repositoryRoot = path.resolve(root, "..", "..");
  const rootRelative = path.relative(repositoryRoot, root).replaceAll("\\", "/");
  const indexPaths = execFileSync("git", ["ls-files", "--cached", "-z", "--", rootRelative], {
    cwd: repositoryRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => path.posix.relative(rootRelative, file))
    .filter((file) => file !== "design/source-manifest.json")
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("evidence/"))
    .sort();
  const actualPaths = sourcePaths();
  assert.deepEqual(indexPaths, actualPaths,
    "stage every current-source file before generating the source manifest");

  const unstaged = execFileSync("git", ["diff", "--name-only", "-z", "--", rootRelative], {
    cwd: repositoryRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => path.posix.relative(rootRelative, file))
    .filter((file) => file !== "design/source-manifest.json");
  assert.deepEqual(unstaged, [],
    "stage final current-source bytes before generating the source manifest");

  const entries = indexPaths.map((file) => ({
    path: file,
    sha256: sha256(execFileSync("git", ["show", `:${rootRelative}/${file}`], {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024
    }))
  }));
  const workingEntries = actualPaths
    .map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  assert.deepEqual(workingEntries, entries,
    "working-tree bytes differ from staged bytes; normalize the checkout before generating");
  return entries;
}

export function assertNoRun() {
  const authorization = readJson(path.join(root, "design", "authorization.json"));
  const attestation = readJson(path.join(root, "design", "no-run-attestation.json"));
  assert.equal(authorization.pilot, "authorized");
  assert.equal(authorization.main, "forbidden");
  assert.equal(authorization.requiresExecuteFlag, true);
  assert.equal(attestation.aiObservationsStarted, 0);
  assert.equal(attestation.pilotIdsConsumed, 0);
  assert.equal(attestation.resultEvidenceFiles, 0);
  assert.equal(attestation.pilotAuthorized, true);
  assert.equal(attestation.mainAuthorized, false);
  assert.equal(attestation.requiresExecuteFlag, true);
  assert.equal(attestation.authorizationId, authorization.authorizationId);
  assert(!fs.existsSync(path.join(root, "evidence")), "evidence directory must not exist");
  const forbidden = listFiles(root).filter((file) => /(?:^|\/)(?:observations?|usage|event-stream|run-marker|pilot-result|main-result)(?:[.-]|$)/iu.test(file) && !file.startsWith("schemas/"));
  assert.deepEqual(forbidden, [], `observation-like artifacts present: ${forbidden.join(", ")}`);
  return {
    pilot: authorization.pilot,
    main: authorization.main,
    evidencePresent: false,
    observationsStarted: 0,
    idsConsumed: 0
  };
}
