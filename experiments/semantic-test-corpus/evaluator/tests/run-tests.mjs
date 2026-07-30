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
import { analyzeBaselineComparisons, analyzeStatisticsInput } from "../statistics.mjs";
import { validateJsonSchema } from "../../validators/json-schema.mjs";
import { validateStaging } from "../../validators/staging.mjs";

const evaluatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(evaluatorRoot, "..");
const readRootJson = (...parts) => JSON.parse(readFileSync(resolve(root, ...parts), "utf8"));
const readEvaluatorJson = (...parts) => JSON.parse(readFileSync(resolve(evaluatorRoot, ...parts), "utf8"));
const frozenSchedule = readRootJson("design", "schedule.json");
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
  const addSession = (run, role, sessionId, modelId, parentSessionId) => {
    events.push({
      eventId: `${sessionId}-created`,
      type: "session.created",
      timestamp: "2026-07-29T00:01:00Z",
      sessionId,
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      role,
      ...(parentSessionId ? { parentSessionId } : {})
    });
    events.push({
      eventId: `${sessionId}-bound`,
      type: "model.bound",
      timestamp: "2026-07-29T00:02:00Z",
      sessionId,
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      role,
      modelId,
      atomic: true
    });
  };
  for (const run of frozenSchedule.runs.filter((item) => item.armId !== 0)) {
    const modelId = [1, 2].includes(run.armId) ? "gpt-5.6-sol" : "claude-haiku-4.5";
    const parentSessionId = `${run.runId}-parent`;
    events.push({
      eventId: `${run.runId}-started`,
      type: "run.started",
      timestamp: "2026-07-29T00:03:00Z",
      sessionId: parentSessionId,
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      role: "parent"
    });
    addSession(run, "parent", parentSessionId, modelId);
    if ([2, 4].includes(run.armId)) {
      addSession(run, "worker", `${run.runId}-worker`, modelId, parentSessionId);
    }
  }
  return {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-model-preflight",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events
  };
}

function modelRunRecords(authenticated) {
  return frozenSchedule.runs.filter((run) => run.armId !== 0).map((run) => {
    const roles = (run.armId === 2 || run.armId === 4 ? ["parent", "worker"] : ["parent"])
      .map((role) => {
        const created = authenticated.payload.events.find((event) =>
          event.runId === run.runId && event.role === role && event.type === "session.created");
        const bound = authenticated.payload.events.find((event) =>
          event.runId === run.runId && event.role === role && event.type === "model.bound");
        return {
          role,
          sessionId: created?.sessionId ?? "missing",
          sessionCreatedEventId: created?.eventId ?? "missing",
          modelBoundEventId: bound?.eventId ?? "missing"
        };
      });
    return {
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      availability: "available",
      modelEvidence: {
        exportId: authenticated.payload.exportId,
        payloadSha256: authenticated.authentication.payloadSha256,
        signatureSha256: authenticated.authentication.signatureSha256,
        publicKeySha256: authenticated.authentication.publicKeySha256,
        roles
      }
    };
  });
}

function bindingAvailabilityFor(observations, unavailableRunIds = []) {
  const unavailable = new Set(unavailableRunIds);
  return {
    evidence: {
      algorithm: "Ed25519",
      payloadSha256: "a".repeat(64),
      signatureSha256: "b".repeat(64),
      publicKeySha256: "c".repeat(64)
    },
    runs: observations.filter((observation) => observation.armId !== 0).map((observation) => ({
      runId: observation.runId,
      blockId: observation.blockId,
      armId: observation.armId,
      requestedModel: [1, 2].includes(observation.armId) ? "gpt-5.6-sol" : "claude-haiku-4.5",
      requestedWorkerModel: [2, 4].includes(observation.armId)
        ? ([1, 2].includes(observation.armId) ? "gpt-5.6-sol" : "claude-haiku-4.5")
        : null,
      status: unavailable.has(observation.runId) ? "unavailable" : "available",
      roles: (observation.armId === 2 || observation.armId === 4 ? ["parent", "worker"] : ["parent"])
        .map((role) => ({
          role,
          sessionId: `${observation.runId}-${role}`,
          observedModel: [1, 2].includes(observation.armId) ? "gpt-5.6-sol" : "claude-haiku-4.5"
        }))
    }))
  };
}

function authenticatedRoleEvents({ runId, blockId, armId, candidateRoot, delegated }) {
  const modelId = [1, 2].includes(armId) ? "gpt-5.6-sol" : "claude-haiku-4.5";
  const parentSessionId = `${runId}-parent`;
  const roles = delegated ? ["parent", "worker"] : ["parent"];
  const events = roles.flatMap((role) => {
    const sessionId = role === "parent" ? parentSessionId : `${runId}-worker`;
    return [
      {
        eventId: `${sessionId}-created`,
        type: "session.created",
        timestamp: "2026-07-29T00:00:30Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        ...(role === "worker" ? { parentSessionId } : {})
      },
      {
        eventId: `${sessionId}-bound`,
        type: "model.bound",
        timestamp: "2026-07-29T00:00:45Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        modelId,
        atomic: true
      },
      {
        eventId: `${sessionId}-policy`,
        type: "sandbox.policy.applied",
        timestamp: "2026-07-29T00:01:00Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        candidateRoot,
        deniedRoots: [evaluatorRoot],
        filesystemMode: "candidate-root-only",
        networkMode: "deny"
      },
      {
        eventId: `${sessionId}-audit`,
        type: "audit.completed",
        timestamp: "2026-07-29T00:04:00Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        filesystemComplete: true,
        networkComplete: true
      }
    ];
  });
  events.push(
    {
      eventId: `${runId}-completed`,
      type: "run.completed",
      timestamp: "2026-07-29T00:04:10Z",
      sessionId: parentSessionId,
      runId,
      blockId,
      armId,
      role: "parent"
    },
    {
      eventId: `${runId}-unblinded`,
      type: "outcomes.unblinded",
      timestamp: "2026-07-29T00:04:20Z",
      sessionId: parentSessionId,
      runId,
      blockId,
      armId,
      role: "parent"
    },
    {
      eventId: `${runId}-outcome-access`,
      type: "outcome.accessed",
      timestamp: "2026-07-29T00:04:30Z",
      sessionId: parentSessionId,
      runId,
      blockId,
      armId,
      role: "parent"
    }
  );
  return events;
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
  const stagingPath = resolve(candidateRoot, "staging", "B01-A2.json");
  const runId = "B01-A2";
  const blockId = "B01";
  const armId = 2;
  const skillSha256 = createHash("sha256")
    .update(readFileSync(resolve(root, "design", "delegated-worker-skill.md")))
    .digest("hex");
  const events = authenticatedRoleEvents({ runId, blockId, armId, candidateRoot, delegated: true });
  events.push({
    eventId: "delegation-invoked",
    type: "delegation.invoked",
    timestamp: "2026-07-29T00:02:00Z",
    sessionId: `${runId}-parent`,
    runId,
    blockId,
    armId,
    role: "parent",
    workerSessionId: `${runId}-worker`,
    skillName: "semantic-scenario-stager",
    skillSha256
  });
  events.push({
    eventId: "delegation-completed",
    type: "delegation.completed",
    timestamp: "2026-07-29T00:03:00Z",
    sessionId: `${runId}-parent`,
    runId,
    blockId,
    armId,
    role: "parent",
    returnFields: ["stagingPath", "payloadSha256", "submittedCases", "promotableCases", "errorCount"]
  });
  events.push({
    eventId: "worker-write",
    type: "tool.called",
    timestamp: "2026-07-29T00:02:30Z",
    sessionId: `${runId}-worker`,
    runId,
    blockId,
    armId,
    role: "worker",
    actor: "worker",
    callId: "write-staging",
    toolName: "file.write",
    path: stagingPath
  });
  events.push({
    eventId: "worker-write-access",
    type: "fs.access",
    timestamp: "2026-07-29T00:02:30Z",
    sessionId: `${runId}-worker`,
    runId,
    blockId,
    armId,
    role: "worker",
    actor: "worker",
    callId: "write-staging",
    path: stagingPath,
    operation: "write",
    decision: "allow"
  });
  const payload = {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-delegation",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events
  };
  const compliantPayload = structuredClone(payload);
  const signed = signedExport(payload);
  const compliant = evaluateIsolationEvidence(
    authenticateExport(signed.bytes, signed.signature, signed.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(compliant.status, "compliant");
  assert.equal(compliant.checks.correlatedFileCalls, 1);
  assert.equal(compliant.checks.outcomeAccessEvents, 1);

  events.find((event) => event.eventId === "delegation-invoked").skillSha256 = "0".repeat(64);
  const wrongSkillSigned = signedExport(payload);
  const wrongSkill = evaluateIsolationEvidence(
    authenticateExport(wrongSkillSigned.bytes, wrongSkillSigned.signature, wrongSkillSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(wrongSkill.status, "noncompliant");
  assert(wrongSkill.violations.some((violation) => violation.includes("noncanonical Skill")));

  events.find((event) => event.eventId === "delegation-invoked").skillSha256 = skillSha256;
  const missingAccessPayload = { ...payload, events: events.filter((event) => event.type !== "fs.access") };
  const missingAccessSigned = signedExport(missingAccessPayload);
  const missingAccess = evaluateIsolationEvidence(
    authenticateExport(missingAccessSigned.bytes, missingAccessSigned.signature, missingAccessSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(missingAccess.status, "noncompliant");
  assert(missingAccess.violations.some((violation) => violation.includes("requires exactly one fs.access")));

  for (const event of events.filter((item) => ["worker-write", "worker-write-access"].includes(item.eventId))) {
    event.sessionId = `${runId}-parent`;
    event.role = "parent";
    event.actor = "parent";
  }
  const parentDoesAllSigned = signedExport(payload);
  const parentDoesAll = evaluateIsolationEvidence(
    authenticateExport(parentDoesAllSigned.bytes, parentDoesAllSigned.signature, parentDoesAllSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(parentDoesAll.status, "noncompliant");
  assert(parentDoesAll.violations.some((violation) => violation.includes("worker-only")));
  assert(parentDoesAll.violations.some((violation) => violation.includes("worker did not write")));

  for (const event of events.filter((item) => ["worker-write", "worker-write-access"].includes(item.eventId))) {
    event.sessionId = `${runId}-worker`;
    event.role = "worker";
    event.actor = "worker";
    event.path = resolve(candidateRoot, "notes.json");
  }
  const workerOutsideSigned = signedExport(payload);
  const workerOutside = evaluateIsolationEvidence(
    authenticateExport(workerOutsideSigned.bytes, workerOutsideSigned.signature, workerOutsideSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(workerOutside.status, "noncompliant");
  assert(workerOutside.violations.some((violation) => violation.includes("worker wrote outside")));

  const parentReadPayload = structuredClone(compliantPayload);
  parentReadPayload.events.push(
    {
      eventId: "parent-read",
      type: "tool.called",
      timestamp: "2026-07-29T00:02:40Z",
      sessionId: `${runId}-parent`,
      runId,
      blockId,
      armId,
      role: "parent",
      actor: "parent",
      callId: "parent-read-staging",
      toolName: "file.read",
      path: stagingPath
    },
    {
      eventId: "parent-read-access",
      type: "fs.access",
      timestamp: "2026-07-29T00:02:40Z",
      sessionId: `${runId}-parent`,
      runId,
      blockId,
      armId,
      role: "parent",
      actor: "parent",
      callId: "parent-read-staging",
      path: stagingPath,
      operation: "read",
      decision: "allow"
    }
  );
  const parentReadSigned = signedExport(parentReadPayload);
  const parentRead = evaluateIsolationEvidence(
    authenticateExport(parentReadSigned.bytes, parentReadSigned.signature, parentReadSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(parentRead.status, "noncompliant");
  assert(parentRead.violations.some((violation) => violation.includes("parent accessed staging")));

  const spoofedActorPayload = structuredClone(compliantPayload);
  spoofedActorPayload.events.find((event) => event.eventId === "worker-write").actor = "parent";
  const spoofedActorSigned = signedExport(spoofedActorPayload);
  const spoofedActor = evaluateIsolationEvidence(
    authenticateExport(spoofedActorSigned.bytes, spoofedActorSigned.signature, spoofedActorSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(spoofedActor.status, "noncompliant");
  assert(spoofedActor.violations.some((violation) => violation.includes("authenticated actor")));

  const prematurePayload = structuredClone(compliantPayload);
  prematurePayload.events.find((event) => event.type === "outcome.accessed").timestamp = "2026-07-29T00:04:15Z";
  const prematureSigned = signedExport(prematurePayload);
  const premature = evaluateIsolationEvidence(
    authenticateExport(prematureSigned.bytes, prematureSigned.signature, prematureSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(premature.status, "noncompliant");
  assert(premature.violations.some((violation) => violation.includes("before completion/unblinding")));

  const boundaryEqualPayload = structuredClone(compliantPayload);
  boundaryEqualPayload.events.find((event) => event.type === "outcome.accessed").timestamp = "2026-07-29T00:04:20Z";
  const boundaryEqualSigned = signedExport(boundaryEqualPayload);
  const boundaryEqual = evaluateIsolationEvidence(
    authenticateExport(
      boundaryEqualSigned.bytes,
      boundaryEqualSigned.signature,
      boundaryEqualSigned.publicKey
    ),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(boundaryEqual.status, "noncompliant");
  assert(boundaryEqual.violations.some((violation) => violation.includes("before completion/unblinding")));

  const uncorrelatedOutcomePayload = structuredClone(compliantPayload);
  uncorrelatedOutcomePayload.events.find((event) => event.type === "outcome.accessed").role = "worker";
  const uncorrelatedOutcomeSigned = signedExport(uncorrelatedOutcomePayload);
  const uncorrelatedOutcome = evaluateIsolationEvidence(
    authenticateExport(
      uncorrelatedOutcomeSigned.bytes,
      uncorrelatedOutcomeSigned.signature,
      uncorrelatedOutcomeSigned.publicKey
    ),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(uncorrelatedOutcome.status, "noncompliant");
  assert(uncorrelatedOutcome.violations.some((violation) =>
    violation.includes("lacks an authenticated session/role")));
});

test("model preflight accepts only authenticated fresh atomic platform evidence", () => {
  const signed = signedExport(modelEvidencePayload());
  const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
  const runRecords = modelRunRecords(authenticated);
  const available = evaluateModelBindings(authenticated, runRecords);
  assert.equal(available.allRunsAvailable, true);
  assert.equal(available.plannedRuns, 48);
  assert.equal(available.availableRuns, 48);
  assert.deepEqual(validateJsonSchema(
    available,
    readRootJson("schemas", "model-preflight.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ), []);
  assert.match(available.evidence.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(available.evidence.publicKeySha256, /^[a-f0-9]{64}$/);
  const schemaRecord = {
    ...runRecords[0],
    phase: "complete",
    timing: {
      startedAt: "2026-07-29T00:03:00Z",
      endedAt: "2026-07-29T00:04:00Z",
      latencyMs: 60000
    },
    usage: Object.fromEntries(["parent", "worker", "total"].map((actor) => [actor, {
      available: false,
      nanoAiu: null,
      credits: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null
    }])),
    tools: { surface: [], calls: [] },
    compliance: {
      isolationAuditPath: "audit.json",
      evidenceSha256: authenticated.authentication.payloadSha256,
      status: "compliant",
      checks: {},
      violations: []
    }
  };
  assert.deepEqual(validateJsonSchema(
    schemaRecord,
    readRootJson("schemas", "run-record.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ), []);
  assert(validateJsonSchema(
    { ...schemaRecord, modelEvidence: null },
    readRootJson("schemas", "run-record.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ).some((error) => error.path === "$.modelEvidence" && error.keyword === "type"));

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
  for (const event of reusedPayload.events.filter((item) =>
    item.runId === "B02-A4" && item.role === "worker")) {
    event.sessionId = "B01-A2-worker";
  }
  const reusedSigned = signedExport(reusedPayload);
  const reusedAuthenticated = authenticateExport(reusedSigned.bytes, reusedSigned.signature, reusedSigned.publicKey);
  const reused = evaluateModelBindings(reusedAuthenticated, modelRunRecords(reusedAuthenticated));
  assert.equal(reused.allRunsAvailable, false);
  assert(reused.runs.some((run) => run.reasons.some((reason) => reason.includes("reused"))));

  const missingPayload = modelEvidencePayload();
  missingPayload.events = missingPayload.events.filter((event) => event.runId !== "B12-A4");
  const missingSigned = signedExport(missingPayload);
  const missingAuthenticated = authenticateExport(missingSigned.bytes, missingSigned.signature, missingSigned.publicKey);
  const missing = evaluateModelBindings(missingAuthenticated, modelRunRecords(missingAuthenticated));
  assert.equal(missing.allRunsAvailable, false);
  assert.equal(missing.runs.find((run) => run.runId === "B12-A4").status, "unavailable");

  const stalePayload = modelEvidencePayload();
  stalePayload.events.find((event) => event.eventId === "B01-A1-parent-created").timestamp = "2026-07-28T00:01:00Z";
  const staleSigned = signedExport(stalePayload);
  const staleAuthenticated = authenticateExport(staleSigned.bytes, staleSigned.signature, staleSigned.publicKey);
  const stale = evaluateModelBindings(staleAuthenticated, modelRunRecords(staleAuthenticated));
  assert.equal(stale.allRunsAvailable, false);
  assert(stale.runs.find((run) => run.runId === "B01-A1").reasons.some((reason) => reason.includes("too old")));

  const mismatchPayload = modelEvidencePayload();
  mismatchPayload.events.find((event) =>
    event.runId === "B03-A3" && event.type === "model.bound").modelId = "gpt-5.6-sol";
  const mismatchSigned = signedExport(mismatchPayload);
  const mismatchAuthenticated = authenticateExport(
    mismatchSigned.bytes, mismatchSigned.signature, mismatchSigned.publicKey);
  const mismatch = evaluateModelBindings(mismatchAuthenticated, modelRunRecords(mismatchAuthenticated));
  assert.equal(mismatch.runs.find((run) => run.runId === "B03-A3").status, "unavailable");

  const wrongHashRecords = structuredClone(runRecords);
  wrongHashRecords.find((record) => record.runId === "B04-A1").modelEvidence.payloadSha256 = "0".repeat(64);
  const wrongHash = evaluateModelBindings(authenticated, wrongHashRecords);
  assert.equal(wrongHash.runs.find((run) => run.runId === "B04-A1").status, "unavailable");
  assert(wrongHash.runs.find((run) => run.runId === "B04-A1").reasons
    .some((reason) => reason.includes("exact authenticated raw export")));

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
  const stagingPath = resolve(candidateRoot, "staging", "B01-A1.json");
  const runId = "B01-A1";
  const blockId = "B01";
  const armId = 1;
  const events = authenticatedRoleEvents({ runId, blockId, armId, candidateRoot, delegated: false });
  events.push(
    {
      eventId: "file-tool",
      type: "tool.called",
      timestamp: "2026-07-29T00:02:00Z",
      sessionId: `${runId}-parent`,
      runId,
      blockId,
      armId,
      role: "parent",
      actor: "parent",
      callId: "inline-write",
      toolName: "file.write",
      path: stagingPath
    },
    {
      eventId: "file",
      type: "fs.access",
      timestamp: "2026-07-29T00:02:00Z",
      sessionId: `${runId}-parent`,
      runId,
      blockId,
      armId,
      role: "parent",
      actor: "parent",
      callId: "inline-write",
      path: stagingPath,
      operation: "write",
      decision: "allow"
    },
    {
      eventId: "network",
      type: "network.access",
      timestamp: "2026-07-29T00:03:00Z",
      sessionId: `${runId}-parent`,
      runId,
      blockId,
      armId,
      role: "parent",
      actor: "parent",
      actorSessionId: `${runId}-parent`,
      callId: "network-attempt",
      endpoint: "https://example.test",
      decision: "deny"
    }
  );
  const payload = {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "export-isolation",
    exportedAt: "2026-07-29T00:10:00Z",
    capturedAt: "2026-07-29T00:05:00Z",
    events
  };
  const compliantPayload = structuredClone(payload);
  const signed = signedExport(payload);
  const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
  const compliant = evaluateIsolationEvidence(authenticated, {
    armId, runId, candidateRoot, evaluatorRoot, stagingPath
  });
  assert.equal(compliant.status, "compliant");
  assert.equal(compliant.violations.length, 0);
  assert.deepEqual(validateJsonSchema(
    compliant,
    readRootJson("schemas", "isolation-audit.schema.json"),
    { schemaDir: resolve(root, "schemas") }
  ), []);

  const allowedTargetPayload = structuredClone(compliantPayload);
  const allowedTargetNetwork = allowedTargetPayload.events.find((event) => event.type === "network.access");
  delete allowedTargetNetwork.decision;
  delete allowedTargetNetwork.endpoint;
  allowedTargetNetwork.allowed = false;
  allowedTargetNetwork.target = "https://example.test";
  const allowedTargetSigned = signedExport(allowedTargetPayload);
  const allowedTarget = evaluateIsolationEvidence(
    authenticateExport(
      allowedTargetSigned.bytes,
      allowedTargetSigned.signature,
      allowedTargetSigned.publicKey
    ),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(allowedTarget.status, "compliant");

  payload.events.find((event) => event.eventId === "file").path = resolve(evaluatorRoot, "oracle", "index.mjs");
  payload.events.find((event) => event.eventId === "network").decision = "allow";
  const violatingSigned = signedExport(payload);
  const noncompliant = evaluateIsolationEvidence(
    authenticateExport(violatingSigned.bytes, violatingSigned.signature, violatingSigned.publicKey),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(noncompliant.status, "noncompliant");
  assert(noncompliant.violations.some((violation) => violation.includes("evaluator access")));
  assert(noncompliant.violations.some((violation) => violation.includes("network access was not denied")));

  const unscopedNetworkPayload = structuredClone(compliantPayload);
  const unscopedNetwork = unscopedNetworkPayload.events.find((event) => event.type === "network.access");
  delete unscopedNetwork.runId;
  delete unscopedNetwork.actorSessionId;
  const unscopedNetworkSigned = signedExport(unscopedNetworkPayload);
  assert.throws(() => authenticateExport(
    unscopedNetworkSigned.bytes,
    unscopedNetworkSigned.signature,
    unscopedNetworkSigned.publicKey
  ), /schema validation/);

  const mismappedNetworkPayload = structuredClone(compliantPayload);
  const mismappedNetwork = mismappedNetworkPayload.events.find((event) => event.type === "network.access");
  mismappedNetwork.runId = "B02-A1";
  mismappedNetwork.blockId = "B02";
  const mismappedNetworkSigned = signedExport(mismappedNetworkPayload);
  const mismappedNetworkResult = evaluateIsolationEvidence(
    authenticateExport(
      mismappedNetworkSigned.bytes,
      mismappedNetworkSigned.signature,
      mismappedNetworkSigned.publicKey
    ),
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath }
  );
  assert.equal(mismappedNetworkResult.status, "noncompliant");
  assert(mismappedNetworkResult.violations.some((violation) =>
    violation.includes("run mapping differs from the frozen schedule")));
});

test("noninferiority and equality use separate multiplicity-adjusted families", () => {
  const observations = [];
  for (let block = 1; block <= 12; block += 1) {
    const blockId = `B${String(block).padStart(2, "0")}`;
    observations.push({
      runId: `${blockId}-A0`,
      blockId,
      armId: 0,
      promotionRate: 0.8,
      semanticPathCoverage: 0.8,
      mutantKillRate: 0.8
    });
    for (const armId of [1, 2, 3, 4]) {
      observations.push({
        runId: `${blockId}-A${armId}`,
        blockId,
        armId,
        promotionRate: 0.82,
        semanticPathCoverage: 0.82,
        mutantKillRate: 0.82
      });
    }
  }
  const result = analyzeBaselineComparisons(observations, {
    bindingAvailability: bindingAvailabilityFor(observations)
  });
  assert.equal(result.analysisEligibility.completeBlocks.length, 12);
  assert.equal(result.analysisEligibility.confirmatoryAvailable, true);
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
    const blockId = `B${String(block).padStart(2, "0")}`;
    highVarianceNoninferior.push({
      runId: `${blockId}-A0`,
      blockId,
      armId: 0,
      promotionRate: 0.5,
      semanticPathCoverage: 0.5,
      mutantKillRate: 0.5
    });
    for (const armId of [1, 2, 3, 4]) {
      highVarianceNoninferior.push({
        runId: `${blockId}-A${armId}`,
        blockId,
        armId,
        promotionRate: 0.5 + differences[block - 1],
        semanticPathCoverage: 0.5 + differences[block - 1],
        mutantKillRate: 0.5 + differences[block - 1]
      });
    }
  }
  const highVariance = analyzeBaselineComparisons(highVarianceNoninferior, {
    bindingAvailability: bindingAvailabilityFor(highVarianceNoninferior)
  });
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
  const failed = analyzeBaselineComparisons(belowMargin, {
    bindingAvailability: bindingAvailabilityFor(belowMargin)
  });
  assert(failed.comparisons
    .filter((comparison) => comparison.armId === 4)
    .every((comparison) => comparison.noninferiority.noninferior === false));

  const nineBlocks = observations.filter((observation) =>
    Number(observation.blockId.slice(1)) <= 9);
  const descriptive = analyzeBaselineComparisons(nineBlocks, {
    bindingAvailability: bindingAvailabilityFor(nineBlocks)
  });
  assert.equal(descriptive.analysisEligibility.completeBlocks.length, 9);
  assert.equal(descriptive.analysisEligibility.incompleteBlocks.length, 3);
  assert.equal(descriptive.analysisEligibility.confirmatoryAvailable, false);
  assert.match(descriptive.analysisEligibility.unavailableReason, /3 of 12 blocks are incomplete/);
  assert(descriptive.comparisons.every((comparison) =>
    comparison.noninferiority.decisionAvailable === false
      && comparison.noninferiority.noninferior === null
      && comparison.noninferiority.unavailableReason
      && comparison.equality.decisionAvailable === false
      && comparison.equality.rejectEquality === null
      && comparison.equality.unavailableReason));

  const rejectedBindings = analyzeBaselineComparisons(observations, {
    bindingAvailability: bindingAvailabilityFor(observations, ["B01-A1", "B02-A2", "B03-A3"])
  });
  assert.deepEqual(rejectedBindings.analysisEligibility.completeBlocks,
    ["B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11", "B12"]);
  assert.equal(rejectedBindings.analysisEligibility.confirmatoryAvailable, false);
  assert(rejectedBindings.analysisEligibility.incompleteBlocks.every((block) =>
    block.reasons.some((reason) => reason.includes("schedule/evidence binding"))));

  const reusedAvailability = bindingAvailabilityFor(observations);
  reusedAvailability.runs[1].roles[0].sessionId = reusedAvailability.runs[0].roles[0].sessionId;
  assert.throws(() => analyzeBaselineComparisons(observations, {
    bindingAvailability: reusedAvailability
  }), /reused binding sessionId/);

  const mismatchAvailability = bindingAvailabilityFor(observations);
  mismatchAvailability.runs[0].roles[0].observedModel = "wrong-model";
  assert.throws(() => analyzeBaselineComparisons(observations, {
    bindingAvailability: mismatchAvailability
  }), /model mismatch/);

  const bindings = bindingAvailabilityFor(observations);
  assert.throws(() => analyzeBaselineComparisons(observations, {
    bindingAvailability: bindings,
    alpha: 1
  }), /options are frozen/);
  assert.throws(() => analyzeBaselineComparisons(observations, {
    bindingAvailability: bindings,
    endpoints: { promotionRate: 0, semanticPathCoverage: 0, mutantKillRate: 0 }
  }), /options are frozen/);
  assert.throws(() => analyzeBaselineComparisons(observations, {
    bindingAvailability: bindings,
    bootstrapSeed: 1
  }), /options are frozen/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    options: { alpha: 1, margin: 0, bootstrapSeed: 1 }
  }), /overrides are forbidden/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    alpha: 1
  }), /overrides are forbidden/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    margins: { promotionRate: 0 }
  }), /overrides are forbidden/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    bootstrapSeed: 1,
    bootstrapResamples: 1
  }), /overrides are forbidden/);
});

test("factorial summaries and missingness sensitivity match known synthetic values", () => {
  const armValues = new Map([[0, 0.5], [1, 0.6], [2, 0.7], [3, 0.4], [4, 0.45]]);
  const observations = frozenSchedule.runs.map((run) => ({
    runId: run.runId,
    blockId: run.blockId,
    armId: run.armId,
    promotionRate: armValues.get(run.armId),
    semanticPathCoverage: armValues.get(run.armId),
    mutantKillRate: armValues.get(run.armId)
  }));
  const result = analyzeBaselineComparisons(observations, {
    bindingAvailability: bindingAvailabilityFor(observations)
  });
  const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12,
    `${actual} != ${expected}`);
  const promotion = result.factorial.find((endpoint) => endpoint.endpoint === "promotionRate");
  assert.match(promotion.multiplicityWarning, /unadjusted and descriptive/);
  close(promotion.contrasts.modelTier.estimate, 0.225);
  close(promotion.contrasts.delegation.estimate, 0.075);
  close(promotion.contrasts.interaction.estimate, 0.05);
  close(promotion.contrasts.delegationAtFrontier.estimate, 0.1);
  close(promotion.contrasts.delegationAtCheap.estimate, 0.05);
  close(promotion.contrasts.tierInline.estimate, 0.2);
  close(promotion.contrasts.tierDelegated.estimate, 0.25);
  promotion.contrasts.modelTier.confidenceInterval.forEach((bound) => close(bound, 0.225));
  const frontierSummary = result.descriptive.armSummaries.find((arm) => arm.armId === 1);
  assert.equal(frontierSummary.endpoints.promotionRate.n, 12);
  close(frontierSummary.endpoints.promotionRate.mean, 0.6);
  close(frontierSummary.endpoints.promotionRate.median, 0.6);
  close(frontierSummary.endpoints.promotionRate.standardDeviation, 0);

  const missing = observations.filter((observation) =>
    !(observation.blockId === "B12" && observation.armId === 4));
  const missingResult = analyzeBaselineComparisons(missing, {
    bindingAvailability: bindingAvailabilityFor(missing)
  });
  assert.equal(missingResult.analysisEligibility.completeBlocks.length, 11);
  assert.equal(missingResult.analysisEligibility.confirmatoryAvailable, true);
  const armFourSensitivity = missingResult.descriptive.sensitivity.arms
    .find((arm) => arm.armId === 4).endpoints.promotionRate;
  assert.equal(armFourSensitivity.missing, 1);
  close(armFourSensitivity.missingAssignedZero, (11 * 0.45) / 12);
  close(armFourSensitivity.missingAssignedOne, ((11 * 0.45) + 1) / 12);
  const comparisonBounds = missingResult.descriptive.sensitivity.baselineComparisons
    .find((comparison) => comparison.armId === 4 && comparison.endpoint === "promotionRate");
  close(comparisonBounds.worstMeanDifference, ((11 * -0.05) - 0.5) / 12);
  close(comparisonBounds.bestMeanDifference, ((11 * -0.05) + 0.5) / 12);

  const baselineOnly = observations.filter((observation) => observation.armId === 0);
  const zeroComplete = analyzeBaselineComparisons(baselineOnly, {
    bindingAvailability: bindingAvailabilityFor(baselineOnly)
  });
  assert.equal(zeroComplete.analysisEligibility.completeBlocks.length, 0);
  assert.equal(zeroComplete.analysisEligibility.confirmatoryAvailable, false);
  assert.match(zeroComplete.analysisEligibility.unavailableReason, /no complete blocks/);
  assert.equal(zeroComplete.comparisons, null);
  assert.equal(zeroComplete.factorial, null);
  assert.equal(zeroComplete.families.noninferiority.evaluated, 0);
  assert.equal(zeroComplete.descriptive.armSummaries.find((arm) => arm.armId === 0)
    .endpoints.promotionRate.n, 12);
  assert.equal(zeroComplete.descriptive.armSummaries.find((arm) => arm.armId === 1)
    .endpoints.promotionRate.n, 0);
  assert.equal(zeroComplete.descriptive.armSummaries.find((arm) => arm.armId === 1)
    .endpoints.promotionRate.blockValues.length, 12);
  assert(zeroComplete.descriptive.armSummaries.find((arm) => arm.armId === 1)
    .endpoints.promotionRate.blockValues.every((block) => block.value === null));
  assert.equal(zeroComplete.descriptive.armAvailability.find((arm) => arm.armId === 0)
    .eligibleOutcomes, 12);
  assert.equal(zeroComplete.descriptive.armAvailability.find((arm) => arm.armId === 1)
    .eligibleOutcomes, 0);
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
