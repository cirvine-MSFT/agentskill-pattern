#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateBaseline, PAIRWISE_FACTORS } from "../baseline/generate.mjs";
import { FiniteDomainSolver } from "../baseline/finite-domain-solver.mjs";
import { findUncoveredPairs, generatePairwiseCoveringArray } from "../baseline/pairwise.mjs";
import { mappingSpec, migrateV1ToV2 } from "../fixture/migration/index.mjs";
import { referenceOracle } from "../fixture/oracle/index.mjs";
import { mutants, executeMutant } from "../mutants/definitions.mjs";
import { buildKillMatrix } from "../mutants/run.mjs";
import { evaluateModelBindings } from "../scripts/preflight-models.mjs";
import { promoteStaging } from "../scripts/promote.mjs";
import { createSchedule } from "../scripts/randomize.mjs";
import { buildReport } from "../scripts/report.mjs";
import { validateStaging } from "../validators/staging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (...parts) => JSON.parse(readFileSync(resolve(root, ...parts), "utf8"));
const tests = [];

function test(name, action) {
  tests.push({ name, action });
}

function get(value, path) {
  return path.split(".").reduce((cursor, part) => cursor?.[part], value);
}

function diagnosticIds(result) {
  return result.diagnostics.map((item) => item.id).sort();
}

function assertCase(caseDefinition, executor) {
  const result = executor(caseDefinition.input);
  assert.equal(result.status, caseDefinition.expect.status, caseDefinition.id);
  assert.deepEqual(diagnosticIds(result), [...caseDefinition.expect.diagnosticIds].sort(), caseDefinition.id);
  for (const [path, expected] of Object.entries(caseDefinition.expect.configPaths)) {
    assert.deepEqual(get(result.config, path), expected, `${caseDefinition.id}: ${path}`);
  }
  for (const path of caseDefinition.expect.requiredTracePaths) {
    assert(result.trace.paths.includes(path), `${caseDefinition.id}: missing ${path}`);
  }
}

test("Node 20 or newer is active", () => {
  assert(Number(process.versions.node.split(".")[0]) >= 20);
});

test("mapping and invariant IDs are unique", () => {
  const ids = [
    ...mappingSpec.rules.map((rule) => rule.id),
    ...mappingSpec.invariants.map((invariant) => invariant.id)
  ];
  assert.equal(new Set(ids).size, ids.length);
  const paths = [
    ...mappingSpec.rules.flatMap((rule) => rule.paths),
    ...mappingSpec.invariants.flatMap((invariant) => invariant.paths)
  ];
  assert.equal(new Set(paths).size, paths.length);
});

test("baseline is deterministic and staging-valid", () => {
  const checked = readJson("staging", "baseline.json");
  assert.deepEqual(generateBaseline(), checked);
  assert.equal(checked.cases.length, 60);
  assert.deepEqual(validateStaging(checked), []);
  for (const tag of ["decision-table", "boundary-partition", "pairwise-covering", "grammar-property", "constraint-solver"]) {
    assert(checked.cases.some((scenario) => scenario.sourceTags.includes(tag)), `missing strategy ${tag}`);
  }
});

test("randomized complete-block schedule is frozen", () => {
  const schedule = createSchedule();
  assert.deepEqual(schedule, readJson("design", "schedule.json"));
  assert.equal(schedule.runs.length, 60);
  for (let block = 1; block <= 12; block += 1) {
    const id = `B${String(block).padStart(2, "0")}`;
    const rows = schedule.runs.filter((run) => run.blockId === id);
    assert.deepEqual(rows.map((run) => run.armId).toSorted(), [0, 1, 2, 3, 4]);
    assert.deepEqual(rows.map((run) => run.order).toSorted(), [1, 2, 3, 4, 5]);
  }
});

test("pairwise array covers every two-factor tuple", () => {
  const rows = generatePairwiseCoveringArray(PAIRWISE_FACTORS);
  assert.equal(findUncoveredPairs(rows, PAIRWISE_FACTORS).length, 0);
  assert(rows.length < 30, "covering array unexpectedly degenerated");
});

test("finite-domain solver enforces partial and complete constraints", () => {
  const solutions = new FiniteDomainSolver({ x: [0, 1, 2], y: [0, 1, 2] })
    .addConstraint(["x", "y"], ({ x, y }) => x + y === 2)
    .solve();
  assert.deepEqual(solutions, [{ x: 0, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
});

test("staging validator rejects precomputed acceptance content", () => {
  const staging = generateBaseline();
  staging.cases[0].expected = {};
  const errors = validateStaging(staging);
  assert(errors.some((error) => error.keyword === "additionalProperties"));
  assert(errors.some((error) => error.keyword === "acceptanceOpacity"));
});

test("promoted expected outputs come from the independent oracle", () => {
  const bytes = readFileSync(resolve(root, "staging", "baseline.json"));
  const staging = JSON.parse(bytes);
  const promoted = promoteStaging(staging, bytes, "2026-07-29T00:00:00.000Z");
  const checked = readJson("artifacts", "baseline-corpus.json");
  assert.deepEqual(promoted, checked);
  for (const scenario of promoted.cases) {
    assert.deepEqual(scenario.expected, referenceOracle(scenario.input), scenario.id);
  }
});

test("candidate and independent oracle agree across the baseline", () => {
  const corpus = readJson("artifacts", "baseline-corpus.json");
  for (const scenario of corpus.cases) {
    assert.deepEqual(migrateV1ToV2(scenario.input), scenario.expected, scenario.id);
  }
});

test("every promoted case carries known instrumentation IDs", () => {
  const corpus = readJson("artifacts", "baseline-corpus.json");
  const rules = new Set(mappingSpec.rules.map((rule) => rule.id));
  const paths = new Set([
    ...mappingSpec.rules.flatMap((rule) => rule.paths),
    ...mappingSpec.invariants.flatMap((invariant) => invariant.paths)
  ]);
  const invariants = new Set(mappingSpec.invariants.map((invariant) => invariant.id));
  for (const scenario of corpus.cases) {
    assert(scenario.expected.trace.rules.length > 0, scenario.id);
    assert(scenario.expected.trace.paths.length > 0, scenario.id);
    assert(scenario.expected.trace.invariants.length > 0, scenario.id);
    assert(scenario.expected.trace.rules.every((id) => rules.has(id)), `${scenario.id}: unknown rule`);
    assert(scenario.expected.trace.paths.every((id) => paths.has(id)), `${scenario.id}: unknown path`);
    assert(scenario.expected.trace.invariants.every((id) => invariants.has(id)), `${scenario.id}: unknown invariant`);
  }
});

test("manually reviewed goldens anchor oracle correctness", () => {
  const golden = readJson("tests", "golden-cases.json");
  assert.equal(golden.review.status, "reviewed");
  for (const scenario of golden.cases) {
    assertCase(scenario, referenceOracle);
    assertCase(scenario, migrateV1ToV2);
  }
});

test("held-out rules and examples remain acceptance-only", () => {
  const heldOut = readJson("acceptance", "held-out-examples.json");
  const provenance = readJson("acceptance", "held-out-rules.json");
  assert.equal(provenance.generatorAccess.suppliedToArms, false);
  assert.match(provenance.provenance.authoredAgainstCommit, /^[a-f0-9]{40}$/);
  assert.match(provenance.provenance.trainingLeakageClaim, /^No claim/);
  for (const scenario of heldOut.cases) {
    assertCase(scenario, referenceOracle);
    assertCase(scenario, migrateV1ToV2);
  }
});

test("metamorphic properties independently constrain the oracle", () => {
  const base = readJson("tests", "golden-cases.json").cases[0].input;
  const reordered = structuredClone(base);
  reordered.features.flags = { beta: false, alpha: true };
  const reorderedAgain = structuredClone(base);
  reorderedAgain.features.flags = { alpha: true, beta: false };
  assert.deepEqual(referenceOracle(reordered).config, referenceOracle(reorderedAgain).config);

  const staleOne = structuredClone(base);
  staleOne.cache = { enabled: false, provider: "memory", ttlSeconds: 1 };
  const staleTwo = structuredClone(base);
  staleTwo.cache = { enabled: false, provider: "redis", ttlSeconds: 999, endpoint: "redis://ignored:6379" };
  assert.deepEqual(referenceOracle(staleOne).config.cache, referenceOracle(staleTwo).config.cache);

  const canonical = structuredClone(base);
  canonical.service.region = "eastus";
  const legacy = structuredClone(base);
  legacy.service.region = "us";
  assert.deepEqual(referenceOracle(canonical).config, referenceOracle(legacy).config);

  const timeoutSeven = structuredClone(base);
  timeoutSeven.service.timeoutSeconds = 7;
  const timeoutEight = structuredClone(base);
  timeoutEight.service.timeoutSeconds = 8;
  assert.equal(referenceOracle(timeoutEight).config.runtime.timeoutMs - referenceOracle(timeoutSeven).config.runtime.timeoutMs, 1000);

  const duplicateOrigin = structuredClone(base);
  duplicateOrigin.security.allowedOrigins = ["https://EXAMPLE.test", "https://example.test/"];
  assert.deepEqual(referenceOracle(duplicateOrigin).config.http.cors.origins, referenceOracle(base).config.http.cors.origins);
});

test("all meaningful deterministic mutants are killed", () => {
  assert(mutants.length >= 20);
  const corpus = readJson("artifacts", "baseline-corpus.json");
  const matrix = buildKillMatrix(corpus);
  assert.deepEqual(matrix, readJson("artifacts", "baseline-kill-matrix.json"));
  assert.equal(matrix.totals.survived, 0);
  assert.equal(matrix.totals.notApplicable, 0);
  assert.equal(matrix.totals.mutationScore, 1);
  for (const row of matrix.cases) {
    for (const mutant of mutants) {
      if (row.applicable[mutant.id]) assert.equal(row.kills[mutant.id], true, `${row.caseId}/${mutant.id}`);
    }
  }
  for (const mutant of mutants) {
    assert(corpus.cases.some((scenario) =>
      JSON.stringify(executeMutant(mutant, scenario.input, scenario.expected)) !== JSON.stringify(scenario.expected)), mutant.id);
  }
});

test("baseline report is derived and complete", () => {
  const corpus = readJson("artifacts", "baseline-corpus.json");
  const matrix = readJson("artifacts", "baseline-kill-matrix.json");
  const report = buildReport(corpus, matrix, mappingSpec);
  assert.deepEqual(report, readJson("artifacts", "baseline-report.json"));
  assert.equal(report.semanticCoverage.rules.rate, 1);
  assert.equal(report.semanticCoverage.paths.rate, 1);
  assert.equal(report.semanticCoverage.invariants.rate, 1);
  assert.equal(report.diagnosticCoverage.rate, 1);
  assert.equal(report.redundancyAndDiversity.exactDuplicateCases, 0);
});

test("model preflight atomically gates the full factorial", () => {
  const cells = [
    { armId: 1, requestedModel: "gpt-5.6-sol", observedModel: "gpt-5.6-sol", atomicBinding: true, sessionId: "s1", evidence: "event:1" },
    { armId: 2, requestedModel: "gpt-5.6-sol", observedModel: "gpt-5.6-sol", atomicBinding: true, sessionId: "s2", workerSessionId: "w2", workerObservedModel: "gpt-5.6-sol", evidence: "event:2" },
    { armId: 3, requestedModel: "claude-haiku-4.5", observedModel: "claude-haiku-4.5", atomicBinding: true, sessionId: "s3", evidence: "event:3" },
    { armId: 4, requestedModel: "claude-haiku-4.5", observedModel: "claude-haiku-4.5", atomicBinding: true, sessionId: "s4", workerSessionId: "w4", workerObservedModel: "claude-haiku-4.5", evidence: "event:4" }
  ];
  const available = evaluateModelBindings({ capturedAt: "2026-07-29T00:00:00Z", beforeOutcomeInspection: true, cells });
  assert.equal(available.factorialAvailable, true);
  cells[3].workerObservedModel = "gpt-5.6-sol";
  const unavailable = evaluateModelBindings({ capturedAt: "2026-07-29T00:00:00Z", beforeOutcomeInspection: true, cells });
  assert.equal(unavailable.factorialAvailable, false);
  assert.equal(unavailable.cells[3].status, "unavailable");
});

test("migration CLI emits the instrumented candidate result", () => {
  const input = readJson("tests", "golden-cases.json").cases[0].input;
  const run = spawnSync(process.execPath, [resolve(root, "fixture", "cli.mjs")], {
    input: JSON.stringify(input),
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), migrateV1ToV2(input));
});

let passed = 0;
for (const { name, action } of tests) {
  try {
    await action();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok ${passed + 1} - ${name}\n${error.stack}\n`);
    process.exit(1);
  }
}
process.stdout.write(`1..${passed}\n`);
