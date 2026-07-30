#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateBaseline, PAIRWISE_FACTORS } from "../../baseline/generate.mjs";
import { FiniteDomainSolver } from "../../baseline/finite-domain-solver.mjs";
import { findUncoveredPairs, generatePairwiseCoveringArray } from "../../baseline/pairwise.mjs";
import { mappingSpec, migrateV1ToV2 } from "../../fixture/migration/index.mjs";
import { referenceOracle } from "../oracle/index.mjs";
import { mutants, executeMutant } from "../mutants/definitions.mjs";
import { buildKillMatrix } from "../mutants/run.mjs";
import { validateMutantCatalog } from "../mutants/validate.mjs";
import { authenticateExport, readAuthenticatedExport } from "../../scripts/authenticated-export.mjs";
import { materializeCandidate } from "../../scripts/materialize-candidate.mjs";
import { evaluateModelBindings } from "../../scripts/preflight-models.mjs";
import { createSchedule } from "../../scripts/randomize.mjs";
import { evaluateIsolationEvidence } from "../../scripts/verify-isolation-evidence.mjs";
import { promoteStaging, promoteSubmission } from "../promote.mjs";
import { buildReport } from "../report.mjs";
import { analyzeBaselineComparisons } from "../statistics.mjs";
import { validateJsonSchema } from "../../validators/json-schema.mjs";
import { validateStaging } from "../../validators/staging.mjs";

const evaluatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(evaluatorRoot, "..");
const readRootJson = (...parts) => JSON.parse(readFileSync(resolve(root, ...parts), "utf8"));
const readEvaluatorJson = (...parts) => JSON.parse(readFileSync(resolve(evaluatorRoot, ...parts), "utf8"));
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

function signedExport(payload) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    bytes,
    signature: sign(null, bytes, privateKey),
    publicKey: publicKey.export({ type: "spki", format: "pem" })
  };
}

function modelEvidencePayload() {
  const events = [];
  const addSession = (armId, role, sessionId, modelId, parentSessionId) => {
    events.push({
      eventId: `${sessionId}-created`,
      type: "session.created",
      timestamp: "2026-07-29T00:01:00Z",
      sessionId,
      armId,
      role,
      ...(parentSessionId ? { parentSessionId } : {})
    });
    events.push({
      eventId: `${sessionId}-bound`,
      type: "model.bound",
      timestamp: "2026-07-29T00:02:00Z",
      sessionId,
      armId,
      role,
      modelId,
      atomic: true
    });
  };
  addSession(1, "parent", "a1-parent", "gpt-5.6-sol");
  addSession(2, "parent", "a2-parent", "gpt-5.6-sol");
  addSession(2, "worker", "a2-worker", "gpt-5.6-sol", "a2-parent");
  addSession(3, "parent", "a3-parent", "claude-haiku-4.5");
  addSession(4, "parent", "a4-parent", "claude-haiku-4.5");
  addSession(4, "worker", "a4-worker", "claude-haiku-4.5", "a4-parent");
  return {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-model-preflight",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events
  };
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
  const checked = readRootJson("staging", "baseline.json");
  assert.deepEqual(generateBaseline(), checked);
  assert.equal(checked.cases.length, 60);
  assert.deepEqual(validateStaging(checked), []);
  for (const tag of ["decision-table", "boundary-partition", "pairwise-covering", "grammar-property", "constraint-solver"]) {
    assert(checked.cases.some((scenario) => scenario.sourceTags.includes(tag)), `missing strategy ${tag}`);
  }
});

test("randomized complete-block schedule is frozen", () => {
  const schedule = createSchedule();
  assert.deepEqual(schedule, readRootJson("design", "schedule.json"));
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
  const checked = readEvaluatorJson("artifacts", "baseline-corpus.json");
  assert.deepEqual(promoted, checked);
  for (const scenario of promoted.cases) {
    assert.deepEqual(scenario.expected, referenceOracle(scenario.input), scenario.id);
  }
});

test("promotion measures zero, malformed, and partial submissions per case", () => {
  const baseline = generateBaseline();
  const partial = {
    ...baseline,
    cases: [
      baseline.cases[0],
      { id: "BROKEN", description: "", input: { version: 1 }, sourceTags: ["decision-table"] },
      baseline.cases[1]
    ]
  };
  const partialBytes = Buffer.from(JSON.stringify(partial));
  const promoted = promoteSubmission(partialBytes, "2026-07-29T00:00:00.000Z");
  const schemaDir = resolve(root, "schemas");
  const promotedSchema = readRootJson("schemas", "promoted-corpus.schema.json");
  assert.deepEqual(validateJsonSchema(promoted, promotedSchema, { schemaDir }), []);
  assert.equal(promoted.promotion.targetCases, 60);
  assert.equal(promoted.promotion.submittedCases, 3);
  assert.equal(promoted.promotion.promotedCases, 2);
  assert.equal(promoted.promotion.invalidCases, 1);
  assert.equal(promoted.promotion.missingSlots, 57);
  assert.equal(promoted.promotion.promotionRate, 2 / 60);
  assert.equal(promoted.invalidCases[0].index, 1);
  assert(promoted.invalidCases[0].errors.length > 0);

  const empty = promoteSubmission(Buffer.from(JSON.stringify({ ...baseline, cases: [] })),
    "2026-07-29T00:00:00.000Z");
  assert.equal(empty.promotion.submittedCases, 0);
  assert.equal(empty.promotion.promotedCases, 0);
  assert.equal(empty.promotion.missingSlots, 60);
  assert.equal(empty.promotion.promotionRate, 0);

  const malformedJson = promoteSubmission(Buffer.from("{"), "2026-07-29T00:00:00.000Z");
  assert.equal(malformedJson.promotion.submittedCases, 0);
  assert.equal(malformedJson.promotion.promotedCases, 0);
  assert.equal(malformedJson.promotion.promotionRate, 0);
  assert.equal(malformedJson.submissionErrors[0].keyword, "json");

  const partialMatrix = buildKillMatrix(promoted);
  const partialReport = buildReport(promoted, partialMatrix, mappingSpec);
  assert.equal(partialReport.corpus.submittedCases, 3);
  assert.equal(partialReport.corpus.promoted, 2);
  assert.equal(partialReport.corpus.structuralValidityRate, 2 / 3);
  assert.equal(partialReport.corpus.promotionRate, 2 / 60);
});

test("candidate and independent oracle agree across the baseline", () => {
  const corpus = readEvaluatorJson("artifacts", "baseline-corpus.json");
  for (const scenario of corpus.cases) {
    assert.deepEqual(migrateV1ToV2(scenario.input), scenario.expected, scenario.id);
  }
});

test("every promoted case carries known instrumentation IDs", () => {
  const corpus = readEvaluatorJson("artifacts", "baseline-corpus.json");
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
  const golden = readEvaluatorJson("tests", "golden-cases.json");
  assert.equal(golden.review.status, "reviewed");
  for (const scenario of golden.cases) {
    assertCase(scenario, referenceOracle);
    assertCase(scenario, migrateV1ToV2);
  }
});

test("held-out rules and examples remain acceptance-only", () => {
  const heldOut = readEvaluatorJson("acceptance", "held-out-examples.json");
  const provenance = readEvaluatorJson("acceptance", "held-out-rules.json");
  assert.equal(provenance.generatorAccess.suppliedToArms, false);
  assert.match(provenance.provenance.authoredAgainstCommit, /^[a-f0-9]{40}$/);
  assert.match(provenance.provenance.trainingLeakageClaim, /^No claim/);
  for (const scenario of heldOut.cases) {
    assertCase(scenario, referenceOracle);
    assertCase(scenario, migrateV1ToV2);
  }
});

test("metamorphic properties independently constrain the oracle", () => {
  const base = readEvaluatorJson("tests", "golden-cases.json").cases[0].input;
  const reordered = structuredClone(base);
  reordered.features.flags = { "Beta Flag": false, "Alpha Flag": true };
  const reorderedAgain = structuredClone(base);
  reorderedAgain.features.flags = { "Alpha Flag": true, "Beta Flag": false };
  assert.deepEqual(referenceOracle(reordered), referenceOracle(reorderedAgain));

  const staleOne = structuredClone(base);
  staleOne.cache = { enabled: false, provider: "memory", ttlSeconds: 1 };
  const staleTwo = structuredClone(base);
  staleTwo.cache = { enabled: false, provider: "redis", ttlSeconds: 999, endpoint: "redis://ignored:6379" };
  assert.deepEqual(referenceOracle(staleOne), referenceOracle(staleTwo));
  assert.deepEqual(migrateV1ToV2(staleOne), migrateV1ToV2(staleTwo));

  const canonical = structuredClone(base);
  canonical.service.region = "eastus";
  const legacy = structuredClone(base);
  legacy.service.region = "us";
  const canonicalOutcome = referenceOracle(canonical);
  const legacyOutcome = referenceOracle(legacy);
  assert.equal(canonicalOutcome.status, legacyOutcome.status);
  assert.deepEqual(canonicalOutcome.config, legacyOutcome.config);
  assert.deepEqual(diagnosticIds(legacyOutcome), [...diagnosticIds(canonicalOutcome), "W-REGION-LEGACY"].sort());

  const timeoutSeven = structuredClone(base);
  timeoutSeven.service.timeoutSeconds = 7;
  const timeoutEight = structuredClone(base);
  timeoutEight.service.timeoutSeconds = 8;
  const sevenOutcome = referenceOracle(timeoutSeven);
  const eightOutcome = referenceOracle(timeoutEight);
  assert.equal(sevenOutcome.status, eightOutcome.status);
  assert.deepEqual(sevenOutcome.diagnostics, eightOutcome.diagnostics);
  assert.equal(eightOutcome.config.runtime.timeoutMs - sevenOutcome.config.runtime.timeoutMs, 1000);
  eightOutcome.config.runtime.timeoutMs = sevenOutcome.config.runtime.timeoutMs;
  assert.deepEqual(eightOutcome, sevenOutcome);

  const duplicateOrigin = structuredClone(base);
  duplicateOrigin.security.allowedOrigins = ["https://EXAMPLE.test", "https://example.test/"];
  const duplicateOutcome = referenceOracle(duplicateOrigin);
  const baseOutcome = referenceOracle(base);
  assert.equal(duplicateOutcome.status, baseOutcome.status);
  assert.deepEqual(duplicateOutcome.config, baseOutcome.config);
  assert.deepEqual(diagnosticIds(duplicateOutcome), ["W-ORIGIN-DEDUP"]);
});

test("all meaningful deterministic mutants are killed", () => {
  assert(mutants.length >= 20);
  const corpus = readEvaluatorJson("artifacts", "baseline-corpus.json");
  const declaredRuleIds = new Set([
    ...mappingSpec.rules.map((rule) => rule.id),
    ...mappingSpec.invariants.map((invariant) => invariant.id)
  ]);
  const goldenCases = readEvaluatorJson("tests", "golden-cases.json").cases.map((scenario) => ({
    id: scenario.id,
    input: scenario.input,
    expected: referenceOracle(scenario.input)
  }));
  const validation = validateMutantCatalog([...corpus.cases, ...goldenCases], declaredRuleIds);
  assert.equal(validation.frozenCount, 33);
  assert.equal(validation.validated, 33);
  const matrix = buildKillMatrix(corpus);
  assert.deepEqual(matrix, readEvaluatorJson("artifacts", "baseline-kill-matrix.json"));
  assert.equal(matrix.totals.total, 33);
  assert.equal(matrix.totals.triggered, 33);
  assert.equal(matrix.totals.untriggered, 0);
  assert.equal(matrix.totals.survived, 0);
  assert.equal(matrix.totals.mutationScore, 1);
  for (const row of matrix.cases) {
    for (const mutant of mutants) {
      if (row.triggered[mutant.id]) assert.equal(row.kills[mutant.id], true, `${row.caseId}/${mutant.id}`);
    }
  }
  for (const mutant of mutants) {
    assert(corpus.cases.some((scenario) =>
      JSON.stringify(executeMutant(mutant, scenario.input, scenario.expected)) !== JSON.stringify(scenario.expected)), mutant.id);
  }
});

test("untriggered mutants survive under the frozen full-catalog denominator", () => {
  const corpus = readEvaluatorJson("artifacts", "baseline-corpus.json");
  const sparse = {
    ...corpus,
    cases: [corpus.cases[0]],
    promotion: {
      ...corpus.promotion,
      submittedCases: 1,
      promotedCases: 1,
      missingSlots: 59,
      promotionRate: 1 / 60
    }
  };
  const matrix = buildKillMatrix(sparse);
  assert.equal(matrix.totals.total, 33);
  assert(matrix.totals.untriggered > 0);
  assert.equal(matrix.totals.survived, 33 - matrix.totals.killed);
  assert(matrix.totals.mutationScore < 0.5, "one case must not receive a near-perfect mutation score");
});

test("baseline report is derived and complete", () => {
  const corpus = readEvaluatorJson("artifacts", "baseline-corpus.json");
  const matrix = readEvaluatorJson("artifacts", "baseline-kill-matrix.json");
  const report = buildReport(corpus, matrix, mappingSpec);
  assert.deepEqual(report, readEvaluatorJson("artifacts", "baseline-report.json"));
  assert.equal(report.semanticCoverage.rules.rate, 1);
  assert.equal(report.semanticCoverage.paths.rate, 1);
  assert.equal(report.semanticCoverage.invariants.rate, 1);
  assert.equal(report.diagnosticCoverage.rate, 1);
  assert.equal(report.mutation.catalogValidation.validated, 33);
  assert.equal(report.mutation.total, 33);
  assert.equal(report.redundancyAndDiversity.exactDuplicateCases, 0);
});

test("delegated arms use one byte-identical mechanism and tool contract", () => {
  const contract = readRootJson("design", "arm-contract.json");
  const frontier = contract.arms.find((arm) => arm.id === 2);
  const cheap = contract.arms.find((arm) => arm.id === 4);
  assert.equal(frontier.delegationContract, cheap.delegationContract);
  assert.deepEqual(contract.delegationContract.toolSurface, contract.commonContract.toolSurface);
  assert.equal(contract.delegationContract.artifact, "task/delegated-worker-skill.md");
});

test("signed run evidence enforces the common delegated mechanism", () => {
  const candidateRoot = resolve(root, ".test-work", "semantic-delegated-audit");
  const skillSha256 = createHash("sha256")
    .update(readFileSync(resolve(root, "design", "delegated-worker-skill.md")))
    .digest("hex");
  const events = [];
  for (const sessionId of ["a2-parent", "a2-worker"]) {
    events.push({
      eventId: `${sessionId}-policy`,
      type: "sandbox.policy.applied",
      timestamp: "2026-07-29T00:01:00Z",
      sessionId,
      candidateRoot,
      deniedRoots: [evaluatorRoot],
      filesystemMode: "candidate-root-only",
      networkMode: "deny"
    });
    events.push({
      eventId: `${sessionId}-audit`,
      type: "audit.completed",
      timestamp: "2026-07-29T00:04:00Z",
      sessionId,
      filesystemComplete: true,
      networkComplete: true
    });
  }
  events.push({
    eventId: "delegation-invoked",
    type: "delegation.invoked",
    timestamp: "2026-07-29T00:02:00Z",
    sessionId: "a2-parent",
    workerSessionId: "a2-worker",
    skillName: "semantic-scenario-stager",
    skillSha256
  });
  events.push({
    eventId: "delegation-completed",
    type: "delegation.completed",
    timestamp: "2026-07-29T00:03:00Z",
    sessionId: "a2-parent",
    returnFields: ["stagingPath", "payloadSha256", "submittedCases", "promotableCases", "errorCount"]
  });
  events.push({
    eventId: "worker-write",
    type: "tool.called",
    timestamp: "2026-07-29T00:02:30Z",
    sessionId: "a2-worker",
    toolName: "file.write"
  });
  const payload = {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-delegation",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events
  };
  const signed = signedExport(payload);
  const compliant = evaluateIsolationEvidence(
    authenticateExport(signed.bytes, signed.signature, signed.publicKey),
    { armId: 2, candidateRoot, evaluatorRoot, sessionIds: ["a2-parent", "a2-worker"] }
  );
  assert.equal(compliant.status, "compliant");

  events.find((event) => event.eventId === "delegation-invoked").skillSha256 = "0".repeat(64);
  const wrongSkillSigned = signedExport(payload);
  const wrongSkill = evaluateIsolationEvidence(
    authenticateExport(wrongSkillSigned.bytes, wrongSkillSigned.signature, wrongSkillSigned.publicKey),
    { armId: 2, candidateRoot, evaluatorRoot, sessionIds: ["a2-parent", "a2-worker"] }
  );
  assert.equal(wrongSkill.status, "noncompliant");
  assert(wrongSkill.violations.some((violation) => violation.includes("noncanonical Skill")));
});

test("model preflight accepts only authenticated fresh atomic platform evidence", () => {
  const signed = signedExport(modelEvidencePayload());
  const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
  const available = evaluateModelBindings(authenticated);
  assert.equal(available.factorialAvailable, true);
  assert.deepEqual(validateJsonSchema(
    available,
    readRootJson("schemas", "model-preflight.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ), []);
  assert.match(available.evidence.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(available.evidence.publicKeySha256, /^[a-f0-9]{64}$/);

  const fabricated = Buffer.from(signed.bytes);
  fabricated[fabricated.length - 2] ^= 1;
  assert.throws(() => authenticateExport(fabricated, signed.signature, signed.publicKey), /signature is invalid/);

  const attestedPayload = { ...modelEvidencePayload(), callerVerified: true };
  const attestedSigned = signedExport(attestedPayload);
  assert.throws(() => authenticateExport(
    attestedSigned.bytes,
    attestedSigned.signature,
    attestedSigned.publicKey
  ), /schema validation/);

  const reusedPayload = modelEvidencePayload();
  for (const event of reusedPayload.events.filter((item) => item.sessionId === "a4-worker")) {
    event.sessionId = "a2-worker";
  }
  const reusedSigned = signedExport(reusedPayload);
  const reused = evaluateModelBindings(authenticateExport(reusedSigned.bytes, reusedSigned.signature, reusedSigned.publicKey));
  assert.equal(reused.factorialAvailable, false);
  assert(reused.cells.some((cell) => cell.reasons.some((reason) => reason.includes("reused"))));

  const missingPayload = modelEvidencePayload();
  missingPayload.events = missingPayload.events.filter((event) => event.armId !== 4);
  const missingSigned = signedExport(missingPayload);
  const missing = evaluateModelBindings(authenticateExport(missingSigned.bytes, missingSigned.signature, missingSigned.publicKey));
  assert.equal(missing.factorialAvailable, false);
  assert.equal(missing.cells.find((cell) => cell.armId === 4).status, "unavailable");

  const stalePayload = modelEvidencePayload();
  stalePayload.events.find((event) => event.eventId === "a1-parent-created").timestamp = "2026-07-28T00:01:00Z";
  const staleSigned = signedExport(stalePayload);
  const stale = evaluateModelBindings(authenticateExport(staleSigned.bytes, staleSigned.signature, staleSigned.publicKey));
  assert.equal(stale.factorialAvailable, false);
  assert(stale.cells[0].reasons.some((reason) => reason.includes("too old")));

  const invalidTimestampPayload = modelEvidencePayload();
  invalidTimestampPayload.capturedAt = "not-a-timestamp";
  const invalidTimestampSigned = signedExport(invalidTimestampPayload);
  assert.throws(() => authenticateExport(
    invalidTimestampSigned.bytes,
    invalidTimestampSigned.signature,
    invalidTimestampSigned.publicKey
  ), /capturedAt/);
  assert.throws(() => readAuthenticatedExport({
    payloadPath: resolve(root, "does-not-exist.json"),
    signaturePath: resolve(root, "does-not-exist.sig"),
    publicKeyPath: resolve(root, "does-not-exist.pem")
  }), /ENOENT/);
});

test("candidate materialization excludes evaluator assets in an external repository", () => {
  const temporary = resolve(root, ".test-work", "semantic-candidate");
  rmSync(temporary, { recursive: true, force: true });
  try {
    const boundary = materializeCandidate(temporary);
    assert.equal(boundary.files.length, readRootJson("design", "candidate-manifest.json").files.length);
    assert(boundary.files.every((file) => !file.path.startsWith("evaluator/")));
    assert.equal(existsSync(resolve(temporary, "evaluator")), false);
    assert.equal(spawnSync("git", ["status", "--short"], { cwd: temporary, encoding: "utf8" }).stdout, "");
    mkdirSync(resolve(temporary, "staging"));
    writeFileSync(resolve(temporary, "staging", "sample.json"), JSON.stringify(generateBaseline()));
    const validation = spawnSync(process.execPath, ["scripts/validate-staging.mjs", "staging/sample.json"], {
      cwd: temporary,
      encoding: "utf8"
    });
    assert.equal(validation.status, 0, validation.stderr);
    assert.throws(() => materializeCandidate(resolve(root, "candidate-output")), /outside the benchmark repository/);
  } finally {
    rmSync(resolve(root, ".test-work"), { recursive: true, force: true });
  }
});

test("isolation compliance is derived from signed policy and access logs", () => {
  const candidateRoot = resolve(root, ".test-work", "semantic-candidate-audit");
  const sessions = ["a1-parent"];
  const payload = {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-isolation",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events: [
      {
        eventId: "policy",
        type: "sandbox.policy.applied",
        timestamp: "2026-07-29T00:01:00Z",
        sessionId: "a1-parent",
        candidateRoot,
        deniedRoots: [evaluatorRoot],
        filesystemMode: "candidate-root-only",
        networkMode: "deny"
      },
      {
        eventId: "file",
        type: "fs.access",
        timestamp: "2026-07-29T00:02:00Z",
        sessionId: "a1-parent",
        path: resolve(candidateRoot, "staging", "run.json"),
        operation: "write",
        decision: "allow"
      },
      {
        eventId: "network",
        type: "network.access",
        timestamp: "2026-07-29T00:03:00Z",
        sessionId: "a1-parent",
        endpoint: "https://example.test",
        decision: "deny"
      },
      {
        eventId: "audit",
        type: "audit.completed",
        timestamp: "2026-07-29T00:04:00Z",
        sessionId: "a1-parent",
        filesystemComplete: true,
        networkComplete: true
      }
    ]
  };
  const signed = signedExport(payload);
  const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
  const compliant = evaluateIsolationEvidence(authenticated, { armId: 1, candidateRoot, evaluatorRoot, sessionIds: sessions });
  assert.equal(compliant.status, "compliant");
  assert.equal(compliant.violations.length, 0);
  assert.deepEqual(validateJsonSchema(
    compliant,
    readRootJson("schemas", "isolation-audit.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ), []);

  payload.events.find((event) => event.eventId === "file").path = resolve(evaluatorRoot, "oracle", "index.mjs");
  payload.events.find((event) => event.eventId === "network").decision = "allow";
  const violatingSigned = signedExport(payload);
  const noncompliant = evaluateIsolationEvidence(
    authenticateExport(violatingSigned.bytes, violatingSigned.signature, violatingSigned.publicKey),
    { armId: 1, candidateRoot, evaluatorRoot, sessionIds: sessions }
  );
  assert.equal(noncompliant.status, "noncompliant");
  assert(noncompliant.violations.some((violation) => violation.includes("evaluator access")));
  assert(noncompliant.violations.some((violation) => violation.includes("network access was not denied")));
});

test("noninferiority and equality use separate multiplicity-adjusted families", () => {
  const observations = [];
  for (let block = 1; block <= 12; block += 1) {
    const blockId = `B${String(block).padStart(2, "0")}`;
    observations.push({
      blockId,
      armId: 0,
      promotionRate: 0.8,
      semanticPathCoverage: 0.8,
      mutantKillRate: 0.8
    });
    for (const armId of [1, 2, 3, 4]) {
      observations.push({
        blockId,
        armId,
        promotionRate: 0.82,
        semanticPathCoverage: 0.82,
        mutantKillRate: 0.82
      });
    }
  }
  const result = analyzeBaselineComparisons(observations);
  assert.equal(result.families.noninferiority.hypotheses, 12);
  assert.equal(result.families.noninferiority.sidedness, "one-sided");
  assert.equal(result.families.equality.hypotheses, 12);
  assert.equal(result.families.equality.sidedness, "two-sided");
  assert.equal(result.families.equality.separateFromNoninferiority, true);
  assert(result.comparisons.every((comparison) => comparison.noninferiority.noninferior));
  assert(result.comparisons.every((comparison) =>
    comparison.noninferiority.holmAdjustedPValue >= comparison.noninferiority.rawPValue));
  assert(result.comparisons.every((comparison) =>
    comparison.equality.holmAdjustedPValue >= comparison.equality.rawPValue));
  assert(result.comparisons.every((comparison) => comparison.equality.confidenceInterval.length === 2));

  const highVarianceNoninferior = [];
  const differences = [0.11, 0.11, 0.11, 0.11, 0.11, 0.11, -0.049, -0.049, -0.049, -0.049, -0.049, -0.049];
  for (let block = 1; block <= 12; block += 1) {
    const blockId = `V${String(block).padStart(2, "0")}`;
    highVarianceNoninferior.push({
      blockId,
      armId: 0,
      promotionRate: 0.5,
      semanticPathCoverage: 0.5,
      mutantKillRate: 0.5
    });
    for (const armId of [1, 2, 3, 4]) {
      highVarianceNoninferior.push({
        blockId,
        armId,
        promotionRate: 0.5 + differences[block - 1],
        semanticPathCoverage: 0.5 + differences[block - 1],
        mutantKillRate: 0.5 + differences[block - 1]
      });
    }
  }
  const highVariance = analyzeBaselineComparisons(highVarianceNoninferior);
  assert(highVariance.comparisons.every((comparison) =>
    comparison.noninferiority.noninferior
      === (comparison.noninferiority.holmAdjustedPValue <= highVariance.alpha)),
  "only the Holm-adjusted one-sided p-value may gate noninferiority");

  const belowMargin = observations.map((observation) => observation.armId === 4
    ? {
        ...observation,
        promotionRate: 0.7,
        semanticPathCoverage: 0.7,
        mutantKillRate: 0.7
      }
    : observation);
  const failed = analyzeBaselineComparisons(belowMargin);
  assert(failed.comparisons
    .filter((comparison) => comparison.armId === 4)
    .every((comparison) => comparison.noninferiority.noninferior === false));
});

test("migration CLI emits the instrumented candidate result", () => {
  const input = readEvaluatorJson("tests", "golden-cases.json").cases[0].input;
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
