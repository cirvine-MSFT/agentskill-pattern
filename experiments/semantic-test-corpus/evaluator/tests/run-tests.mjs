#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GENERAL_GENERATOR_DEPENDENCIES,
  generateBaseline,
  PAIRWISE_FACTORS
} from "../../baseline/generate.mjs";
import { FiniteDomainSolver } from "../../baseline/finite-domain-solver.mjs";
import { findUncoveredPairs, generatePairwiseCoveringArray } from "../../baseline/pairwise.mjs";
import { compareCodePointStrings, mappingSpec, migrateV1ToV2 } from "../../fixture/migration/index.mjs";
import { compareCodePoints, referenceOracle } from "../oracle/index.mjs";
import { mutants, executeMutant } from "../mutants/definitions.mjs";
import { buildKillMatrix } from "../mutants/run.mjs";
import { validateMutantCatalog } from "../mutants/validate.mjs";
import { authenticateExport, readAuthenticatedExport } from "../../scripts/authenticated-export.mjs";
import { materializeCandidate } from "../../scripts/materialize-candidate.mjs";
import { adaptPlatformAudit } from "../../scripts/platform-audit-adapter.mjs";
import { evaluateModelBindings } from "../../scripts/preflight-models.mjs";
import { collectLocalEvidence } from "../../scripts/collect-local-evidence.mjs";
import { createUsageExport } from "../../scripts/export-local-usage.mjs";
import { preflightLocalModel } from "../../scripts/preflight-local-model.mjs";
import {
  kickoffBytesForRun,
  kickoffSha256ForRun
} from "../../scripts/execution-contract.mjs";
import { preflightExecution } from "../../scripts/preflight-execution.mjs";
import { createSchedule } from "../../scripts/randomize.mjs";
import { runControlledHarness } from "../../scripts/run-controlled-harness.mjs";
import { runDeterministicBlock } from "../../scripts/run-deterministic-block.mjs";
import { validateStartOrder } from "../../scripts/validate-start-order.mjs";
import { validateExecutionRecords } from "../../scripts/validate-execution-records.mjs";
import { validateLocalEvidence } from "../../scripts/validate-local-evidence.mjs";
import {
  evaluateGlobalAttribution,
  evaluateIsolationEvidence
} from "../../scripts/verify-isolation-evidence.mjs";
import {
  canonicalStagingBytes,
  snapshotCorpusStaging,
  snapshotLocalCorpusStaging
} from "../adapter.mjs";
import { buildDescriptiveRuns, summarizeDescriptive } from "../descriptive-v2.mjs";
import { promoteStaging, promoteSubmission } from "../promote.mjs";
import { buildReport } from "../report.mjs";
import { assertExactArtifact, canonicalArtifactBytes } from "../reproduce.mjs";
import {
  analyzeAuthenticatedStatisticsInput,
  analyzeBaselineComparisons,
  analyzeStatisticsInput,
  assertAuthenticatedRunCoverage,
  verifyMetricsArtifact
} from "../statistics.mjs";
import { canonicalMetricsBytes, deriveMetricsArtifact } from "../metrics.mjs";
import { validateJsonSchema } from "../../validators/json-schema.mjs";
import { validateStaging } from "../../validators/staging.mjs";
import { createDispatcher } from "../../../../tools/semantic-corpus-mcp/protocol.mjs";
import { createRun as createCorpusRun } from "../../../../tests/semantic-corpus-mcp/fixtures.mjs";

const evaluatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(evaluatorRoot, "..");
const readRootJson = (...parts) => JSON.parse(readFileSync(resolve(root, ...parts), "utf8"));
const readEvaluatorJson = (...parts) => JSON.parse(readFileSync(resolve(evaluatorRoot, ...parts), "utf8"));
const frozenSchedule = readRootJson("design", "schedule.json");
const frozenContract = readRootJson("design", "arm-contract.json");
const tests = [];
const evidenceCandidateRoot = resolve(
  process.env.TEMP ?? resolve(root, ".."),
  `semantic-evidence-candidate-${process.pid}`
);

function ensureEvidenceCandidate() {
  if (!existsSync(resolve(evidenceCandidateRoot, ".git"))
    || !existsSync(resolve(evidenceCandidateRoot, ".benchmark-boundary.json"))) {
    rmSync(evidenceCandidateRoot, { recursive: true, force: true });
    materializeCandidate(evidenceCandidateRoot, {
      blockId: "B01"
    });
  }
  return evidenceCandidateRoot;
}

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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
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
    const arm = frozenContract.arms.find((item) => item.id === run.armId);
    const parentSessionId = `${run.runId}-parent`;
    events.push({
      eventId: `${run.runId}-started`,
      type: "run.started",
      timestamp: `2026-07-29T00:03:0${run.order}Z`,
      sessionId: parentSessionId,
      processId: `${run.runId}-process`,
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      role: "parent",
      sequence: run.order
    });
    addSession(run, "parent", parentSessionId, arm.model);
    if (arm.delegated) {
      addSession(run, "worker", `${run.runId}-worker`, arm.workerModel, parentSessionId);
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
    const arm = frozenContract.arms.find((item) => item.id === run.armId);
    const roles = (arm.delegated ? ["parent", "worker"] : ["parent"])
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
  for (const observation of observations) {
    if (observation.armId !== 0 && observation.isolationVerified === undefined) {
      observation.isolationVerified = true;
    }
  }
  return {
    evidence: {
      algorithm: "Ed25519",
      payloadSha256: "a".repeat(64),
      signatureSha256: "b".repeat(64),
      publicKeySha256: "c".repeat(64)
    },
    runs: observations.filter((observation) => observation.armId !== 0).map((observation) => ({
      ...(() => {
        const arm = frozenContract.arms.find((item) => item.id === observation.armId);
        return {
          requestedModel: arm.model,
          requestedWorkerModel: arm.workerModel ?? null,
          roles: (arm.delegated ? ["parent", "worker"] : ["parent"])
            .map((role) => ({
              role,
              sessionId: `${observation.runId}-${role}`,
              observedModel: role === "worker" ? arm.workerModel : arm.model
            }))
        };
      })(),
      runId: observation.runId,
      blockId: observation.blockId,
      armId: observation.armId,
      status: unavailable.has(observation.runId) ? "unavailable" : "available",
    }))
  };
}

function authenticatedRoleEvents({ runId, blockId, armId, contractRoot, stagingRoot, delegated }) {
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
        eventId: `${sessionId}-audit-started`,
        type: "audit.started",
        timestamp: "2026-07-29T00:00:20Z",
        sessionId,
        runId,
        blockId,
        armId,
        role
      },
      {
        eventId: `${sessionId}-policy`,
        type: "sandbox.policy.applied",
        timestamp: "2026-07-29T00:00:25Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        contractRoot,
        stagingRoot,
        sandboxConfigPath: resolve(dirname(contractRoot), "corpus-sandbox.json"),
        deniedRoots: [evaluatorRoot],
        filesystemMode: "semantic-corpus-contract-ro-staging-rw",
        networkMode: "deny"
      },
      {
        eventId: `${sessionId}-audit`,
        type: "audit.completed",
        timestamp: "2026-07-29T00:04:15Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        filesystemComplete: true,
        networkComplete: true
      },
      {
        eventId: `${sessionId}-usage`,
        type: "usage.reported",
        timestamp: "2026-07-29T00:04:16Z",
        sessionId,
        runId,
        blockId,
        armId,
        role,
        totalTokens: 100,
        intervalStart: "2026-07-29T00:00:50Z",
        intervalEnd: "2026-07-29T00:04:10Z"
      }
    ];
  });
  const blockStarts = frozenSchedule.runs.filter((run) => run.blockId === blockId).map((run) => ({
    eventId: `${run.runId}-started`,
    type: "run.started",
    timestamp: `2026-07-29T00:00:5${run.order}Z`,
    sessionId: run.runId === runId ? parentSessionId : `${run.runId}-process`,
    processId: `${run.runId}-process`,
    runId: run.runId,
    blockId,
    armId: run.armId,
    role: run.armId === 0 ? "baseline" : "parent",
    sequence: run.order
  }));
  const baselineRun = frozenSchedule.runs.find((run) => run.blockId === blockId && run.armId === 0);
  const baselineSessionId = `${baselineRun.runId}-process`;
  events.push(
    ...blockStarts,
    {
      eventId: `${baselineRun.runId}-completed`,
      type: "run.completed",
      timestamp: "2026-07-29T00:03:40Z",
      sessionId: baselineSessionId,
      runId: baselineRun.runId,
      blockId,
      armId: 0,
      role: "baseline"
    },
    {
      eventId: `${baselineRun.runId}-unblinded`,
      type: "outcomes.unblinded",
      timestamp: "2026-07-29T00:03:45Z",
      sessionId: baselineSessionId,
      runId: baselineRun.runId,
      blockId,
      armId: 0,
      role: "baseline"
    },
    {
      eventId: `${baselineRun.runId}-usage`,
      type: "usage.reported",
      timestamp: "2026-07-29T00:03:46Z",
      sessionId: baselineSessionId,
      runId: baselineRun.runId,
      blockId,
      armId: 0,
      role: "baseline",
      totalTokens: 0,
      intervalStart: "2026-07-29T00:00:50Z",
      intervalEnd: "2026-07-29T00:03:45Z"
    },
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

test("sorting uses deterministic Unicode code-point order", () => {
  for (const compare of [compareCodePoints, compareCodePointStrings]) {
    assert(compare("z", "ä") < 0);
    assert(compare("😀", "�") > 0);
    assert.equal(compare("same", "same"), 0);
  }
});

test("baseline is deterministic and staging-valid", () => {
  const checked = readRootJson("staging", "baseline.json");
  assert.deepEqual(generateBaseline(), checked);
  assert.equal(checked.cases.length, 60);
  assert.deepEqual(validateStaging(checked), []);
  for (const tag of [
    "schema-pairwise", "schema-enumeration", "schema-optional",
    "public-contract-value", "generic-boundary", "generic-string-partition",
    "seeded-schema-property"
  ]) {
    assert(checked.cases.some((scenario) => scenario.sourceTags.includes(tag)), `missing strategy ${tag}`);
  }
  assert(GENERAL_GENERATOR_DEPENDENCIES.every((path) =>
    !/evaluator|held-out|mutant|oracle/iu.test(path)));
});

test("randomized complete-block schedule is frozen", () => {
  const schedule = createSchedule();
  assert.deepEqual(schedule, readRootJson("design", "schedule.json"));
  assert.equal(schedule.protocolId, "semantic-test-corpus-execution-v2");
  assert.equal(schedule.runs.length, 72);
  assert.equal(schedule.runs.filter((run) => run.armId === 0).length, 12);
  assert.equal(schedule.runs.filter((run) => run.armId !== 0).length, 60);
  for (let block = 1; block <= 12; block += 1) {
    const id = `B${String(block).padStart(2, "0")}`;
    const rows = schedule.runs.filter((run) => run.blockId === id);
    assert.deepEqual(rows.map((run) => run.armId).toSorted(), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(rows.map((run) => run.order).toSorted(), [1, 2, 3, 4, 5, 6]);
  }
  assert.deepEqual(schedule.runs.map((run) => run.globalOrder),
    Array.from({ length: 72 }, (_, index) => index + 1));
});

test("captured timestamps enforce the strict 72-run global start order", () => {
  const temporary = resolve(root, ".order-test-work");
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    const captures = frozenSchedule.runs.map((run, index) => {
      const startedAt = new Date(Date.parse("2026-07-31T20:00:00.000Z") + index * 1000)
        .toISOString();
      const sourcePath = `${run.runId}.start`;
      const bytes = run.armId === 0
        ? Buffer.from(`${JSON.stringify({ startedAt })}\n`)
        : Buffer.from(`${JSON.stringify({
            type: "session.start",
            timestamp: startedAt,
            data: { sessionId: `${run.runId}-session` }
          })}\n`);
      writeFileSync(resolve(temporary, sourcePath), bytes);
      return {
        runId: run.runId,
        blockId: run.blockId,
        armId: run.armId,
        sequence: run.globalOrder,
        startedAt,
        sourcePath,
        sourceSha256: createHash("sha256").update(bytes).digest("hex")
      };
    });
    const index = {
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      captures
    };
    assert.deepEqual(validateStartOrder(index, { baseDir: temporary }), []);
    const reordered = structuredClone(index);
    [reordered.captures[0], reordered.captures[1]] =
      [reordered.captures[1], reordered.captures[0]];
    assert(validateStartOrder(reordered, { baseDir: temporary })
      .some((error) => error.includes("global start sequence")));
    const forged = structuredClone(index);
    forged.captures[1].startedAt = forged.captures[0].startedAt;
    assert(validateStartOrder(forged, { baseDir: temporary })
      .some((error) => error.includes("strictly increasing")
        || error.includes("not derived")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("fake CLI preflight and harness capture a complete immutable run", () => {
  const fakeCli = resolve(root, "fixtures", "fake-copilot-cli.mjs");
  const available = preflightExecution(fakeCli, "2026-07-31T20:00:00.000Z");
  assert(available.arms.every((arm) => arm.status === "available"));
  const unsupported = preflightExecution(process.execPath, "2026-07-31T20:00:00.000Z");
  assert.equal(unsupported.arms[5].status, "unavailable");
  assert(unsupported.arms[5].reasons.some((reason) =>
    reason.includes("worker model override")));

  const repositoryRoot = resolve(root, "..", "..");
  const temporary = resolve(repositoryRoot, "..", `.semantic-harness-${process.pid}`);
  const candidateRoot = resolve(temporary, "candidate");
  const artifactRoot = resolve(temporary, "artifacts");
  const startIndexPath = resolve(temporary, "start-index.json");
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    const dryRun = runControlledHarness({
      cli: fakeCli,
      projectId: "fixture-project",
      candidateRoot,
      artifactRoot,
      startIndexPath,
      blockId: "B01",
      armId: 4,
      dryRun: true,
      capturedAt: "2026-07-31T20:00:00.000Z"
    });
    assert.equal(dryRun.status, "dry-run");
    assert(dryRun.plan.atomicCommand.args.includes("--prompt-file"));
    assert(dryRun.plan.atomicCommand.args.includes("--model"));
    assert.equal(dryRun.plan.atomicCommand.args.includes("--worker-model"), false);
    const targetDryRun = runControlledHarness({
      cli: fakeCli,
      projectId: "fixture-project",
      candidateRoot: resolve(temporary, "target-candidate"),
      artifactRoot: resolve(temporary, "target-artifacts"),
      startIndexPath,
      blockId: "B01",
      armId: 5,
      dryRun: true,
      capturedAt: "2026-07-31T20:00:00.000Z"
    });
    const workerModelIndex = targetDryRun.plan.atomicCommand.args.indexOf("--worker-model");
    assert.equal(
      targetDryRun.plan.atomicCommand.args[workerModelIndex + 1],
      "claude-haiku-4.5"
    );

    const result = runControlledHarness({
      cli: fakeCli,
      projectId: "fixture-project",
      candidateRoot,
      artifactRoot,
      startIndexPath,
      blockId: "B01",
      armId: 4,
      capturedAt: "2026-07-31T20:00:00.000Z"
    });
    assert.equal(result.status, "complete", result.modelPreflight?.reasons.join("\n"));
    assert.equal(result.modelPreflight.status, "pass");
    assert.equal(result.evidence.trust.signed, false);
    assert.equal(result.evidence.trust.complianceProof, false);
    assert.equal(result.evidence.delegation.agentName, "semantic-test-corpus");
    assert.equal(result.evidence.models.observed.worker[0], "claude-haiku-4.5");
    assert.equal(result.provenance.evidence, "unsigned-descriptive-only");
    const startIndex = JSON.parse(readFileSync(startIndexPath, "utf8"));
    assert.deepEqual(validateStartOrder(startIndex, {
      requireComplete: false,
      baseDir: temporary
    }), []);
    assert(existsSync(resolve(artifactRoot, "staging.json")));
    assert(existsSync(resolve(artifactRoot, "metrics.json")));
    assert(existsSync(resolve(artifactRoot, "capture-provenance.json")));

    process.env.FAKE_COPILOT_CREATE_FAILURE = "1";
    const failureRoot = resolve(temporary, "failure");
    const failure = runControlledHarness({
      cli: fakeCli,
      projectId: "fixture-project",
      candidateRoot: resolve(failureRoot, "candidate"),
      artifactRoot: resolve(failureRoot, "artifacts"),
      startIndexPath: resolve(failureRoot, "start-index.json"),
      blockId: "B01",
      armId: 4,
      capturedAt: "2026-07-31T20:00:00.000Z"
    });
    delete process.env.FAKE_COPILOT_CREATE_FAILURE;
    assert.equal(failure.status, "pre-session-failure");
    assert.equal(failure.failure.kickoffStarted, false);
    assert.equal(failure.failure.usage.modelTokens, 0);
  } finally {
    delete process.env.FAKE_COPILOT_CREATE_FAILURE;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("condition instructions freeze all six mechanisms and same-agent override", () => {
  const conditions = readRootJson("design", "condition-instructions.json");
  assert.equal(conditions.protocolId, "semantic-test-corpus-execution-v2");
  assert.deepEqual(conditions.conditions.map((condition) => condition.armId), [0, 1, 2, 3, 4, 5]);
  assert.equal(conditions.conditions.find((condition) => condition.armId === 5).workerModel,
    "claude-haiku-4.5");
  const target = conditions.conditions.find((condition) => condition.armId === 5);
  assert.equal(target.workerModelOverride, "claude-haiku-4.5");
  assert.match(target.kickoff, /registered semantic-test-corpus agent/);
  assert.doesNotMatch(target.kickoff, /semantic-test-corpus-haiku/);
  assert.equal(existsSync(resolve(root, "..", "..", ".github", "agents",
    "semantic-test-corpus-haiku.agent.md")), false);
  const kickoff = kickoffBytesForRun(5, 1812433253);
  assert.match(kickoff.toString("utf8"), /Benchmark block seed: 1812433253/);
  assert.equal(
    createHash("sha256").update(kickoff).digest("hex"),
    kickoffSha256ForRun(5, 1812433253)
  );
});

test("v2 analyzer emits six-arm point estimates and pairs without inference", () => {
  const endpointNames = Object.keys(
    readRootJson("schemas", "descriptive-input.schema.json")
      .properties.runs.items.properties.endpoints.properties
  );
  const runs = frozenSchedule.runs.map((run) => ({
    runId: run.runId,
    blockId: run.blockId,
    armId: run.armId,
    endpoints: {
      ...Object.fromEntries(endpointNames.map((name) => [name, null])),
      promotionRate: run.armId / 10,
      mutantKillRate: run.armId / 10
    }
  }));
  const summary = summarizeDescriptive(runs);
  assert.equal(summary.analysis, "descriptive-point-estimates-and-within-block-pairs-only");
  assert.equal(summary.observedRuns, 72);
  assert.equal(summary.armPoints.length, 6);
  assert.equal(summary.pairs.find((pair) =>
    pair.armId === 5 && pair.endpoint === "promotionRate").blockPairs.length, 12);
  assert.equal(summary.pairs.find((pair) =>
    pair.armId === 5 && pair.endpoint === "promotionRate").mean, 0.5);
  assert.deepEqual(
    [...new Set(summary.registeredContrasts.map((contrast) => contrast.id))],
    [
      "script-vs-gpt-inline",
      "script-vs-gpt-gpt",
      "script-vs-haiku-inline",
      "script-vs-haiku-haiku",
      "script-vs-gpt-haiku",
      "gpt-delegation",
      "delegated-worker-tier",
      "haiku-delegation",
      "gpt-inline-vs-target",
      "factorial-model-tier",
      "factorial-delegation",
      "factorial-interaction",
      "factorial-tier-inline",
      "factorial-tier-delegated"
    ]
  );
  assert.equal(summary.unavailableRuns.length, 0);
  const incomplete = summarizeDescriptive(runs.slice(1));
  assert.equal(incomplete.observedRuns, 71);
  assert.deepEqual(incomplete.unavailableRuns.map((run) => run.runId), [runs[0].runId]);
  assert.match(incomplete.unavailableRuns[0].reason, /excluded/);
  assert.doesNotMatch(JSON.stringify(summary),
    /pValue|confidenceInterval|noninferior|bootstrap|holm/i);
});

test("v2 analyzer derives measurements only from exact evaluator artifacts", () => {
  const temporary = resolve(process.env.TEMP ?? root, `semantic-descriptive-${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    const baseline = runDeterministicBlock("B01");
    const baselineSnapshotPath = resolve(temporary, "B01-A0.json");
    const baselineExecutionPath = resolve(temporary, "B01-A0.execution.json");
    const baselineMetricsPath = resolve(temporary, "B01-A0.metrics.json");
    const baselineEvaluationPath = resolve(temporary, "B01-A0.evaluation.json");
    writeFileSync(baselineSnapshotPath, baseline.bytes);
    writeFileSync(baselineExecutionPath, `${JSON.stringify(baseline.execution, null, 2)}\n`);
    const baselineMetrics = deriveMetricsArtifact(baseline.bytes, {
      runId: "B01-A0",
      blockId: "B01",
      armId: 0
    });
    const baselineMetricsBytes = canonicalMetricsBytes(baselineMetrics);
    writeFileSync(baselineMetricsPath, baselineMetricsBytes);
    writeFileSync(baselineEvaluationPath, `${JSON.stringify({
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      runId: "B01-A0",
      blockId: "B01",
      armId: 0,
      attemptId: null,
      snapshotPath: baselineSnapshotPath,
      snapshotSha256: createHash("sha256").update(baseline.bytes).digest("hex"),
      metricsPath: baselineMetricsPath,
      metricsSha256: createHash("sha256").update(baselineMetricsBytes).digest("hex"),
      executionSha256: createHash("sha256")
        .update(readFileSync(baselineExecutionPath)).digest("hex"),
      localEvidenceSha256: null,
      modelPreflightSha256: null,
      createdAt: "2026-07-31T08:00:00.000Z"
    }, null, 2)}\n`);

    const aiSnapshot = {
      formatVersion: 1,
      generator: { armId: 2, blockId: "B01", seed: 1812433253 },
      adapter: {
        version: 1,
        requestHash: readRootJson("design", "corpus-request.json").requestHash,
        sourceRoot: "corpus-staging/",
        successfulWrites: 0,
        toolErrorCount: 0,
        manifest: null
      },
      cases: [],
      toolErrors: []
    };
    const aiSnapshotBytes = canonicalStagingBytes(aiSnapshot);
    const aiSnapshotPath = resolve(temporary, "B01-A2.json");
    const aiMetricsPath = resolve(temporary, "B01-A2.metrics.json");
    const aiEvaluationPath = resolve(temporary, "B01-A2.evaluation.json");
    writeFileSync(aiSnapshotPath, aiSnapshotBytes);
    const aiMetrics = deriveMetricsArtifact(aiSnapshotBytes, {
      runId: "B01-A2",
      blockId: "B01",
      armId: 2
    });
    const aiMetricsBytes = canonicalMetricsBytes(aiMetrics);
    writeFileSync(aiMetricsPath, aiMetricsBytes);
    const fixtureRoot = resolve(root, "fixtures", "local-evidence");
    const fixtureEvidenceBytes = readFileSync(resolve(fixtureRoot, "expected.json"));
    const fixturePreflightBytes = readFileSync(resolve(fixtureRoot, "model-preflight.json"));
    const aiEvaluation = {
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      runId: "B01-A2",
      blockId: "B01",
      armId: 2,
      attemptId: "B01-A2-attempt-1",
      snapshotPath: aiSnapshotPath,
      snapshotSha256: createHash("sha256").update(aiSnapshotBytes).digest("hex"),
      metricsPath: aiMetricsPath,
      metricsSha256: createHash("sha256").update(aiMetricsBytes).digest("hex"),
      executionSha256: null,
      localEvidenceSha256: createHash("sha256").update(fixtureEvidenceBytes).digest("hex"),
      modelPreflightSha256: createHash("sha256").update(fixturePreflightBytes).digest("hex"),
      createdAt: "2026-07-31T08:00:00.000Z"
    };
    writeFileSync(aiEvaluationPath, `${JSON.stringify(aiEvaluation, null, 2)}\n`);
    const definitions = {
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      runs: [
        {
          runId: "B01-A0",
          blockId: "B01",
          armId: 0,
          snapshotPath: baselineSnapshotPath,
          metricsPath: baselineMetricsPath,
          executionPath: baselineExecutionPath,
          localEvidencePath: null,
          modelPreflightPath: null,
          candidateRoot: null,
          evaluationPath: baselineEvaluationPath
        },
        {
          runId: "B01-A2",
          blockId: "B01",
          armId: 2,
          snapshotPath: aiSnapshotPath,
          metricsPath: aiMetricsPath,
          executionPath: null,
          localEvidencePath: resolve(fixtureRoot, "expected.json"),
          modelPreflightPath: resolve(fixtureRoot, "model-preflight.json"),
          candidateRoot: ensureEvidenceCandidate(),
          evaluationPath: aiEvaluationPath
        }
      ]
    };
    const runs = buildDescriptiveRuns(definitions, temporary);
    assert.equal(runs.length, 2);
    assert.equal(runs.find((run) => run.armId === 0).endpoints.totalModelTokens, 0);
    assert.equal(runs.find((run) => run.armId === 2).endpoints.totalModelTokens, 1850);
    assert.equal(runs.find((run) => run.armId === 2).endpoints.modelEvidenceAvailable, 1);
    assert.equal(runs.find((run) => run.armId === 2).endpoints.mechanismEvidenceAvailable, 1);

    const tampered = structuredClone(aiMetrics);
    tampered.metrics.promotion.promotionRate = -1;
    writeFileSync(aiMetricsPath, canonicalMetricsBytes(tampered));
    assert.throws(() => buildDescriptiveRuns({
      ...definitions,
      runs: [definitions.runs[1]]
    }, temporary),
      /Evaluation record|not exact deterministic output/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("deterministic runner executes every frozen baseline block", () => {
  const executions = frozenContract.arms[0].id === 0
    ? Array.from({ length: 12 }, (_, index) =>
      runDeterministicBlock(`B${String(index + 1).padStart(2, "0")}`))
    : [];
  assert.equal(executions.length, 12);
  for (const result of executions) {
    assert.equal(result.staging.cases.length, 60);
    assert.equal(result.execution.cases, 60);
    assert.equal(result.execution.armId, 0);
    assert.equal(result.staging.generator.blockId, result.execution.blockId);
    assert.equal(result.staging.generator.seed, result.execution.seed);
    assert.match(result.execution.stagingSha256, /^[a-f0-9]{64}$/);
  }
});

test("captured local evidence is reproducible, fail-closed, and model-bound", () => {
  const fixtureRoot = resolve(root, "fixtures", "local-evidence");
  const candidateRoot = ensureEvidenceCandidate();
  const eventsPath = resolve(fixtureRoot, "captured.events.jsonl");
  const usagePath = resolve(fixtureRoot, "captured.usage.json");
  const sessionCreationPath = resolve(fixtureRoot, "session-creation.json");
  const candidateBoundaryPath = resolve(fixtureRoot, "candidate-boundary.json");
  const runManifestPath = resolve(fixtureRoot, "run-manifest.json");
  const runAttemptPath = resolve(fixtureRoot, "attempt-1.json");
  const eventsBytes = readFileSync(eventsPath);
  const usageBytes = readFileSync(usagePath);
  const sessionCreationBytes = readFileSync(sessionCreationPath);
  const candidateBoundaryBytes = readFileSync(candidateBoundaryPath);
  const runManifestBytes = readFileSync(runManifestPath);
  const runAttemptBytes = readFileSync(runAttemptPath);
  const manifest = readRootJson("fixtures", "local-evidence", "run-manifest.json");
  const evidence = collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    candidateRoot,
    runManifest: manifest,
    runManifestBytes,
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  });

  assert.deepEqual(evidence, readRootJson("fixtures", "local-evidence", "expected.json"));
  assert.deepEqual(validateLocalEvidence(evidence, {
    artifactRoot: fixtureRoot,
    candidateRoot: ensureEvidenceCandidate()
  }), []);
  assert.equal(evidence.trust.signed, false);
  assert.equal(evidence.trust.complianceProof, false);
  assert.equal(evidence.availability.fields.premiumRequests.status, "unavailable");
  assert.equal(evidence.usage.total.aiCredits, 6);
  assert.equal(evidence.usage.total.cachedTokens, 1450);
  assert.equal(evidence.delegation.compactReturn,
    "corpus-staging - 0 scenarios - FAILURE: SCHEMA_ERROR");

  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal(preflightLocalModel(evidence, evidenceBytes).status, "pass");
  const metadataOnlyMismatch = structuredClone(evidence);
  metadataOnlyMismatch.models.observed.worker = ["claude-haiku-4.5"];
  assert.equal(preflightLocalModel(
    metadataOnlyMismatch,
    Buffer.from(`${JSON.stringify(metadataOnlyMismatch, null, 2)}\n`)
  ).status, "unavailable");

  const mismatchUsage = JSON.parse(usageBytes);
  mismatchUsage.rows.find((row) => row.agent_id !== null).model = "claude-haiku-4.5";
  const mismatchBytes = Buffer.from(`${JSON.stringify(mismatchUsage, null, 2)}\n`);
  const mismatch = collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes: mismatchBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    candidateRoot: ensureEvidenceCandidate(),
    runManifest: manifest,
    runManifestBytes,
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  });
  const rejected = preflightLocalModel(mismatch,
    Buffer.from(`${JSON.stringify(mismatch, null, 2)}\n`));
  assert.equal(rejected.status, "unavailable");
  assert.equal(rejected.retryEligible, false);
  assert(rejected.reasons.some((reason) => reason.includes("post-start retry is forbidden")));
  const unboundUsage = JSON.parse(usageBytes);
  const unboundWorker = unboundUsage.rows.find((row) => row.agent_id !== null);
  unboundWorker.agent_id = "wrong-agent";
  const unboundBytes = Buffer.from(`${JSON.stringify(unboundUsage, null, 2)}\n`);
  const unbound = collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes: unboundBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    candidateRoot: ensureEvidenceCandidate(),
    runManifest: manifest,
    runManifestBytes,
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  });
  assert.equal(unbound.availability.model.status, "unavailable");
  assert(unbound.availability.model.reasons.some((reason) =>
    reason.includes("exact parent/worker lifecycle")));
  const openedEvidence = structuredClone(evidence);
  openedEvidence.attempt.outcomesOpened = true;
  const opened = preflightLocalModel(openedEvidence,
    Buffer.from(`${JSON.stringify(openedEvidence, null, 2)}\n`));
  assert.equal(opened.status, "unavailable");
  assert.equal(opened.beforeOutcomesOpened, false);

  const unexpectedEvent = {
    type: "tool.execution_start",
    data: {
      toolCallId: "fixture-prohibited",
      toolName: "powershell",
      arguments: { command: "Get-Content corpus-staging" },
      turnId: "0",
      model: "gpt-5.6-sol"
    },
    id: "fixture-prohibited-event",
    timestamp: "2026-07-31T07:00:05.000Z",
    parentId: "fixture-mcp-complete"
  };
  const prohibitedBytes = Buffer.concat([
    eventsBytes,
    Buffer.from(`${JSON.stringify(unexpectedEvent)}\n`)
  ]);
  const prohibited = collectLocalEvidence({
    eventsBytes: prohibitedBytes,
    eventsPath,
    usageBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    candidateRoot: ensureEvidenceCandidate(),
    runManifest: manifest,
    runManifestBytes,
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  });
  assert.equal(prohibited.availability.mechanism.status, "unavailable");
  assert(prohibited.availability.mechanism.reasons.some((reason) =>
    reason.includes("prohibited tool powershell")));

  const wrongBoundaryManifest = {
    ...manifest,
    candidateSnapshotSha256: "0".repeat(64)
  };
  assert.throws(() => collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes,
    candidateBoundaryPath,
    candidateRoot: ensureEvidenceCandidate(),
    runManifest: wrongBoundaryManifest,
    runManifestBytes: Buffer.from(`${JSON.stringify(wrongBoundaryManifest, null, 2)}\n`),
    runManifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath
  }), /Candidate boundary SHA-256/);
});

test("local evaluator adapter snapshots only after passing model preflight", () => {
  const fixtureRoot = resolve(root, "fixtures", "local-evidence");
  const candidateRoot = ensureEvidenceCandidate();
  const evidenceBytes = readFileSync(resolve(fixtureRoot, "expected.json"));
  const evidence = JSON.parse(evidenceBytes);
  const preflight = preflightLocalModel(evidence, evidenceBytes);
  const temporary = resolve(process.env.TEMP ?? root, `semantic-local-adapter-${process.pid}`);
  const contractRoot = resolve(temporary, "corpus-contract");
  const stagingRoot = resolve(temporary, "corpus-staging");
  const outputPath = resolve(temporary, "snapshot", "B01-A2.json");
  rmSync(temporary, { recursive: true, force: true });
  try {
    mkdirSync(resolve(stagingRoot, "scenarios"), { recursive: true });
    mkdirSync(contractRoot, { recursive: true });
    writeFileSync(resolve(contractRoot, "request.json"),
      readFileSync(resolve(root, "design", "corpus-request.json")));
    writeFileSync(resolve(stagingRoot, "scenarios", "scenario-001.json"),
      `${JSON.stringify(generateBaseline().cases[0].input, null, 2)}\n`);
    assert.throws(() => snapshotLocalCorpusStaging({
      corpusContractRoot: contractRoot,
      corpusStagingRoot: stagingRoot,
      localEvidence: evidence,
      localEvidenceBytes: evidenceBytes,
      modelPreflight: preflight,
      sourceArtifactRoot: fixtureRoot,
      sourceCandidateRoot: ensureEvidenceCandidate(),
      outputPath
    }), /local successful writes/);
    rmSync(resolve(stagingRoot, "scenarios", "scenario-001.json"));
    const snapshot = snapshotLocalCorpusStaging({
      corpusContractRoot: contractRoot,
      corpusStagingRoot: stagingRoot,
      localEvidence: evidence,
      localEvidenceBytes: evidenceBytes,
      modelPreflight: preflight,
      sourceArtifactRoot: fixtureRoot,
      sourceCandidateRoot: ensureEvidenceCandidate(),
      outputPath
    });
    assert.equal(snapshot.evidenceTier, "descriptive-local-v1");
    assert.equal(snapshot.submittedCases, 0);
    assert.equal(snapshot.staging.generator.armId, 2);
    assert.equal(snapshot.staging.adapter.successfulWrites, 0);
    assert.deepEqual(snapshot.bytes, canonicalStagingBytes(snapshot.staging));

    const unavailable = {
      ...preflight,
      status: "unavailable",
      retryEligible: false,
      reasons: ["started mechanism mismatch"]
    };
    assert.throws(() => snapshotLocalCorpusStaging({
      corpusContractRoot: contractRoot,
      corpusStagingRoot: stagingRoot,
      localEvidence: evidence,
      localEvidenceBytes: evidenceBytes,
      modelPreflight: unavailable,
      sourceArtifactRoot: fixtureRoot,
      sourceCandidateRoot: ensureEvidenceCandidate(),
      outputPath: resolve(temporary, "snapshot", "rejected.json")
    }), /passing pre-outcome model evidence/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("local usage export and execution record schemas reject cross-session ambiguity", () => {
  const usage = readRootJson("fixtures", "local-evidence", "captured.usage.json");
  assert.deepEqual(createUsageExport(usage.rows, {
    cliSessionId: usage.source.cliSessionId,
    exportedAt: usage.source.exportedAt
  }), usage);
  const crossSession = structuredClone(usage.rows);
  crossSession[0].session_id = "another-session";
  assert.throws(() => createUsageExport(crossSession, {
    cliSessionId: usage.source.cliSessionId,
    exportedAt: usage.source.exportedAt
  }), /another CLI session/);

  const schemaSamples = [
    ["run-manifest.schema.json", readRootJson("fixtures", "local-evidence", "run-manifest.json")],
    ["run-attempt.schema.json", {
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      attemptId: "B01-A2-attempt-1",
      runId: "B01-A2",
      attemptNumber: 1,
      appProjectSessionId: "fixture-app-project-session",
      cliSessionId: "fixture-cli-session",
      requestedParentModel: "gpt-5.6-sol",
      requestedWorkerModel: "gpt-5.6-sol",
      status: "completed",
      startedAt: "2026-07-31T07:00:00.000Z",
      endedAt: "2026-07-31T07:00:10.000Z",
      terminalReturn: "corpus-staging/manifest.json - 60 scenarios - SUCCESS",
      localEvidencePath: "local-evidence.json",
      modelPreflightPath: "model-preflight.json",
      treatment: {
        blockId: "B01",
        armId: 2,
        seed: 1812433253,
        sourceCommit: "a".repeat(40),
        sourceTree: "b".repeat(40),
        terminalCommit: "a".repeat(40),
        candidateSnapshotSha256: "b".repeat(64),
        sharedTaskSha256: "c".repeat(64),
        kickoffSha256: "d".repeat(64),
        wallLimitMs: 1800000,
        toolCallLimit: 120,
        modelTokenLimit: 100000
      },
      evaluatorSnapshotPath: null,
      outcomesOpenedAt: null,
      deviations: []
    }],
    ["deviation.schema.json", {
      formatVersion: 1,
      protocolId: "semantic-test-corpus-execution-v2",
      deviationId: "B01-A5-worker-override-unavailable",
      runId: "B01-A5",
      attemptId: null,
      category: "mechanism",
      observedAt: "2026-07-31T07:00:00.000Z",
      description: "Same-agent worker model override unavailable",
      impact: "exclude",
      outcomesOpened: false
    }]
  ];
  for (const [schemaName, sample] of schemaSamples) {
    assert.deepEqual(validateJsonSchema(sample, readRootJson("schemas", schemaName), {
      schemaDir: resolve(root, "schemas")
    }), []);
  }
  const manifest = readRootJson("fixtures", "local-evidence", "run-manifest.json");
  const attempt = readRootJson("fixtures", "local-evidence", "attempt-1.json");
  const fixtureEvidenceBytes = readFileSync(resolve(root, "fixtures", "local-evidence", "expected.json"));
  const fixturePreflight = readRootJson("fixtures", "local-evidence", "model-preflight.json");
  assert.deepEqual(validateExecutionRecords({
    manifest,
    attempts: [attempt],
    preflights: [fixturePreflight],
    evidenceBytes: [fixtureEvidenceBytes],
    preSessionFailures: []
  }), []);
  const invalidSecondAttempt = { ...attempt, attemptId: "B01-A2-attempt-2", attemptNumber: 2 };
  const invalidTwoAttemptManifest = {
    ...manifest,
    attemptNumber: 2,
    attempts: ["attempt-1.json", "attempt-2.json"],
    preflights: ["preflight-1.json", "preflight-2.json"]
  };
  assert(validateExecutionRecords({
    manifest: invalidTwoAttemptManifest,
    attempts: [attempt, invalidSecondAttempt],
    preflights: [fixturePreflight, fixturePreflight],
    evidenceBytes: [fixtureEvidenceBytes, fixtureEvidenceBytes],
    preSessionFailures: []
  }).length > 0);
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

test("URL invariants reject malformed ports, credentials, paths, and queries", () => {
  const base = readEvaluatorJson("tests", "golden-cases.json").cases[0].input;
  const executors = [referenceOracle, migrateV1ToV2];
  for (const origin of [
    "https://example.test:99999",
    "https://example.test:abc",
    " https://example.test",
    "https://example.test ",
    "https://exam\tple.test",
    "https://exam\nple.test",
    "https://exam\u0000ple.test",
    "https://exam\u007fple.test",
    "https://example.test?",
    "https://example.test#",
    "https://example.test/.",
    "https://example.test/a/..",
    "https://@example.test",
    "https://user:pass@example.test",
    "https://example.test/path",
    "https://example.test?query=1"
  ]) {
    const input = structuredClone(base);
    input.security.allowedOrigins = [origin];
    for (const execute of executors) {
      assert(diagnosticIds(execute(input)).includes("D-ORIGIN-SYNTAX"), origin);
    }
  }
  for (const origin of [
    "http://127.0.0.1:8080",
    "https://service.example.test",
    "https://[2001:db8::1]:8443"
  ]) {
    const input = structuredClone(base);
    input.security.allowedOrigins = [origin];
    for (const execute of executors) {
      assert(!diagnosticIds(execute(input)).includes("D-ORIGIN-SYNTAX"), origin);
    }
  }

  for (const endpoint of [
    "redis://cache.example.test:99999",
    "redis://cache.example.test:abc",
    " redis://cache.example.test:6379",
    "redis://cache.example.test:6379 ",
    "redis://cache.\texample.test:6379",
    "redis://cache.\nexample.test:6379",
    "redis://cache.\u0000example.test:6379",
    "redis://cache.\u007fexample.test:6379",
    "redis://cache.example.test:6379?",
    "redis://cache.example.test:6379#",
    "redis://cache.example.test:6379/.",
    "redis://@cache.example.test:6379",
    "redis://user:pass@cache.example.test:6379",
    "redis://cache.example.test:6379/not-a-db",
    "redis://cache.example.test:6379/1?query=1"
  ]) {
    const input = structuredClone(base);
    input.cache = { enabled: true, provider: "redis", ttlSeconds: 60, endpoint };
    for (const execute of executors) {
      assert(diagnosticIds(execute(input)).includes("D-REDIS-ENDPOINT"), endpoint);
    }
  }
  for (const endpoint of [
    "redis://127.0.0.1:6379/0",
    "rediss://cache.example.test:6380/2",
    "redis://[2001:db8::1]:6379"
  ]) {
    const input = structuredClone(base);
    input.cache = { enabled: true, provider: "redis", ttlSeconds: 60, endpoint };
    for (const execute of executors) {
      assert(!diagnosticIds(execute(input)).includes("D-REDIS-ENDPOINT"), endpoint);
    }
  }
});

test("general baseline scores the full mutant catalog without tuned selection", () => {
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
  assert.equal(matrix.totals.killed + matrix.totals.survived, 33);
  assert.equal(matrix.totals.triggered + matrix.totals.untriggered, 33);
  assert(matrix.totals.killed > 0 && matrix.totals.killed < 33);
  assert.equal(matrix.totals.mutationScore, matrix.totals.killed / 33);
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
  assert(report.semanticCoverage.paths.rate > 0 && report.semanticCoverage.paths.rate < 1);
  assert.equal(
    report.semanticCoverage.paths.exercised + report.semanticCoverage.paths.missing.length,
    report.semanticCoverage.paths.total
  );
  assert.equal(report.semanticCoverage.invariants.rate, 1);
  assert.equal(report.diagnosticCoverage.rate, 1);
  assert.equal(report.mutation.catalogValidation.validated, 33);
  assert.equal(report.mutation.total, 33);
  assert.equal(report.redundancyAndDiversity.exactDuplicateCases, 0);

  const reverseKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  };
  const first = corpus.cases[0];
  const duplicateCorpus = {
    ...corpus,
    promotion: {
      ...corpus.promotion,
      submittedCases: 2,
      promotedCases: 2,
      promotionRate: 2 / 60
    },
    cases: [
      first,
      { ...first, id: `${first.id}-REORDERED`, input: reverseKeys(first.input) }
    ]
  };
  const duplicateReport = buildReport(duplicateCorpus, matrix, mappingSpec);
  assert.equal(duplicateReport.redundancyAndDiversity.exactDuplicateCases, 1);
});

test("canonical metrics are snapshot-derived and reject outcome tampering", () => {
  const temporary = resolve(root, ".regression-work", "metrics-authentication");
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    const snapshotPath = resolve(temporary, "B01-A0.json");
    const metricsPath = resolve(temporary, "B01-A0.metrics.json");
    const baselineSnapshot = generateBaseline({ blockId: "B01", seed: 1812433253 });
    const snapshotBytes = Buffer.from(`${JSON.stringify(baselineSnapshot, null, 2)}\n`);
    writeFileSync(snapshotPath, snapshotBytes);
    const artifact = deriveMetricsArtifact(snapshotBytes, {
      runId: "B01-A0",
      blockId: "B01",
      armId: 0
    });
    assert(artifact.metrics.coverage.paths.rate > 0
      && artifact.metrics.coverage.paths.rate <= 1);
    assert.equal(artifact.metrics.mutation.catalogSize, 33);
    assert.equal(artifact.metrics.mutation.triggered + artifact.metrics.mutation.untriggered, 33);
    assert.equal(artifact.metrics.mutation.killed + artifact.metrics.mutation.survived, 33);
    assert.deepEqual(artifact.provenance.oracle.files.map((file) => file.path),
      ["evaluator/oracle/index.mjs"]);
    assert.match(artifact.provenance.generator.commitSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.match(artifact.provenance.generator.treeSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    assert(artifact.provenance.generator.files.some((file) =>
      file.path === "baseline/general-generate.mjs"
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.blobSha)));
    const relabeledBaseline = generateBaseline();
    relabeledBaseline.generator = { armId: 0, blockId: "B01", seed: 1812433253 };
    assert.throws(() => deriveMetricsArtifact(canonicalStagingBytes(relabeledBaseline), {
      runId: "B01-A0",
      blockId: "B01",
      armId: 0
    }), /differs from the frozen seeded generator/);
    assert.throws(() => deriveMetricsArtifact(Buffer.concat([snapshotBytes, Buffer.from("\n")]), {
      runId: "B01-A0",
      blockId: "B01",
      armId: 0
    }), /not canonical staging bytes/);
    const metricsBytes = canonicalMetricsBytes(artifact);
    writeFileSync(metricsPath, metricsBytes);
    const metricsSha256 = createHash("sha256").update(metricsBytes).digest("hex");
    const runRecord = {
      runId: "B01-A0",
      blockId: "B01",
      armId: 0,
      sessionIds: ["baseline-session"],
      staging: {
        path: snapshotPath,
        sha256: artifact.snapshotSha256,
        sourceRoot: "corpus-staging/"
      },
      metrics: {
        path: metricsPath,
        sha256: metricsSha256,
        snapshotSha256: artifact.snapshotSha256,
        eventId: "baseline-metrics",
        evaluatorSessionId: "evaluator-session",
        evaluatorProcessId: "evaluator-process"
      }
    };
    const payload = {
      formatVersion: 1,
      provider: "github-copilot-platform",
      exportId: "metrics-authentication",
      exportedAt: "2026-07-29T00:05:00Z",
      capturedAt: "2026-07-29T00:04:30Z",
      events: [
        {
          eventId: "baseline-started",
          type: "run.started",
          timestamp: "2026-07-29T00:03:50Z",
          sessionId: "baseline-session",
          processId: "baseline-process",
          runId: "B01-A0",
          blockId: "B01",
          armId: 0,
          role: "baseline",
          sequence: 6
        },
        {
          eventId: "baseline-completed",
          type: "run.completed",
          timestamp: "2026-07-29T00:04:00Z",
          sessionId: "baseline-session",
          runId: "B01-A0",
          blockId: "B01",
          armId: 0,
          role: "baseline"
        },
        {
          eventId: "baseline-unblinded",
          type: "outcomes.unblinded",
          timestamp: "2026-07-29T00:04:10Z",
          sessionId: "baseline-session",
          runId: "B01-A0",
          blockId: "B01",
          armId: 0,
          role: "baseline"
        },
        {
          eventId: "baseline-metrics",
          type: "metrics.computed",
          timestamp: "2026-07-29T00:04:20Z",
          sessionId: "evaluator-session",
          processId: "evaluator-process",
          runId: "B01-A0",
          blockId: "B01",
          armId: 0,
          role: "evaluator",
          actor: "evaluator",
          metricsPath,
          metricsSha256,
          snapshotSha256: artifact.snapshotSha256,
          evaluatorCodeSha256: artifact.provenance.evaluator.sha256,
          specSha256: artifact.provenance.spec.sha256,
          oracleCodeSha256: artifact.provenance.oracle.sha256,
          mutantCodeSha256: artifact.provenance.mutants.sha256
        }
      ]
    };
    const signed = signedExport(payload);
    const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
    assert.deepEqual(verifyMetricsArtifact({
      metricsPath,
      runRecord,
      authenticated
    }), artifact);
    const validGlobal = evaluateGlobalAttribution(authenticated);
    assert.equal(validGlobal.status, "compliant", validGlobal.violations.join("\n"));

    const impersonatedPayload = structuredClone(payload);
    const impersonatedEvent = impersonatedPayload.events.find((event) =>
      event.type === "metrics.computed");
    impersonatedEvent.sessionId = "baseline-session";
    impersonatedEvent.processId = "baseline-process";
    const impersonatedRecord = structuredClone(runRecord);
    impersonatedRecord.metrics.evaluatorSessionId = "baseline-session";
    impersonatedRecord.metrics.evaluatorProcessId = "baseline-process";
    const impersonatedSigned = signedExport(impersonatedPayload);
    const impersonatedAuthenticated = authenticateExport(
      impersonatedSigned.bytes,
      impersonatedSigned.signature,
      impersonatedSigned.publicKey
    );
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord: impersonatedRecord,
      authenticated: impersonatedAuthenticated
    }), /signed metrics event differs/);
    const impersonatedGlobal = evaluateGlobalAttribution(impersonatedAuthenticated);
    assert.equal(impersonatedGlobal.status, "noncompliant");
    assert(impersonatedGlobal.violations.some((violation) =>
      violation.includes("impersonates an authenticated run identity")));

    assert.throws(() => assertAuthenticatedRunCoverage(
      [],
      new Map([[runRecord.runId, { ...runRecord, phase: "excluded" }]]),
      authenticated
    ), /one-to-one/);

    const wrongBoundaryPayload = structuredClone(payload);
    wrongBoundaryPayload.events.find((event) =>
      event.type === "run.completed").armId = 1;
    const wrongBoundarySigned = signedExport(wrongBoundaryPayload);
    const wrongBoundaryAuthenticated = authenticateExport(
      wrongBoundarySigned.bytes,
      wrongBoundarySigned.signature,
      wrongBoundarySigned.publicKey
    );
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord,
      authenticated: wrongBoundaryAuthenticated
    }), /precedes completion\/unblinding/);

    const tampered = structuredClone(artifact);
    tampered.metrics.promotion.promotionRate = 0.5;
    const tamperedBytes = canonicalMetricsBytes(tampered);
    writeFileSync(metricsPath, tamperedBytes);
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord,
      authenticated
    }), /metrics hash differs/);

    const reboundRecord = structuredClone(runRecord);
    reboundRecord.metrics.sha256 = createHash("sha256").update(tamperedBytes).digest("hex");
    const reboundPayload = structuredClone(payload);
    reboundPayload.events.find((event) => event.type === "metrics.computed").metricsSha256
      = reboundRecord.metrics.sha256;
    const reboundSigned = signedExport(reboundPayload);
    const reboundAuthenticated = authenticateExport(
      reboundSigned.bytes,
      reboundSigned.signature,
      reboundSigned.publicKey
    );
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord: reboundRecord,
      authenticated: reboundAuthenticated
    }), /does not match deterministic evaluator output/);

    writeFileSync(metricsPath, metricsBytes);
    writeFileSync(snapshotPath, Buffer.concat([snapshotBytes, Buffer.from("\n")]));
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord,
      authenticated
    }), /snapshot hash differs/);
    writeFileSync(snapshotPath, snapshotBytes);

    const wrongSnapshotRecord = structuredClone(runRecord);
    wrongSnapshotRecord.metrics.snapshotSha256 = "0".repeat(64);
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord: wrongSnapshotRecord,
      authenticated
    }), /identity differs/);

    const forgedCodeArtifact = structuredClone(artifact);
    forgedCodeArtifact.provenance.oracle.sha256 = "0".repeat(64);
    const forgedCodeBytes = canonicalMetricsBytes(forgedCodeArtifact);
    writeFileSync(metricsPath, forgedCodeBytes);
    const forgedCodeRecord = structuredClone(runRecord);
    forgedCodeRecord.metrics.sha256 = createHash("sha256").update(forgedCodeBytes).digest("hex");
    const forgedCodePayload = structuredClone(payload);
    const forgedCodeEvent = forgedCodePayload.events.find((event) =>
      event.type === "metrics.computed");
    forgedCodeEvent.metricsSha256 = forgedCodeRecord.metrics.sha256;
    forgedCodeEvent.oracleCodeSha256 = forgedCodeArtifact.provenance.oracle.sha256;
    const forgedCodeSigned = signedExport(forgedCodePayload);
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord: forgedCodeRecord,
      authenticated: authenticateExport(
        forgedCodeSigned.bytes,
        forgedCodeSigned.signature,
        forgedCodeSigned.publicKey
      )
    }), /does not match deterministic evaluator output/);
    writeFileSync(metricsPath, metricsBytes);

    const wrongCodePayload = structuredClone(payload);
    wrongCodePayload.events.find((event) => event.type === "metrics.computed").oracleCodeSha256
      = "0".repeat(64);
    const wrongCodeSigned = signedExport(wrongCodePayload);
    assert.throws(() => verifyMetricsArtifact({
      metricsPath,
      runRecord,
      authenticated: authenticateExport(
        wrongCodeSigned.bytes,
        wrongCodeSigned.signature,
        wrongCodeSigned.publicKey
      )
    }), /signed metrics event differs/);

    const oldShape = {
      runs: [{
        runId: "B01-A0",
        blockId: "B01",
        armId: 0,
        metricsPath,
        promotionRate: 1
      }],
      runRecords: []
    };
    assert(validateJsonSchema(
      oldShape,
      readRootJson("schemas", "statistics-input.schema.json"),
      { schemaDir: resolve(root, "schemas") }
    ).some((error) => error.keyword === "additionalProperties"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("reproduction rejects JSON formatting, key-order, and newline tampering", () => {
  const value = { alpha: 1, nested: { beta: 2, gamma: 3 } };
  assert.doesNotThrow(() => assertExactArtifact(value, canonicalArtifactBytes(value), "fixture"));
  for (const tampered of [
    Buffer.from(JSON.stringify(value)),
    Buffer.from('{\n  "nested": {\n    "beta": 2,\n    "gamma": 3\n  },\n  "alpha": 1\n}\n'),
    Buffer.from(`${JSON.stringify(value, null, 2)}\r\n`)
  ]) {
    assert.throws(() => assertExactArtifact(value, tampered, "fixture"), /byte-for-byte/);
  }
});

test("delegated arms use one byte-identical mechanism and tool contract", () => {
  const contract = readRootJson("design", "arm-contract.json");
  const frontier = contract.arms.find((arm) => arm.id === 2);
  const cheap = contract.arms.find((arm) => arm.id === 4);
  const target = contract.arms.find((arm) => arm.id === 5);
  assert.equal(frontier.delegationContract, cheap.delegationContract);
  assert.equal(frontier.delegationContract, target.delegationContract);
  assert.equal(target.agentName, contract.delegationContract.agentName);
  assert.equal(target.workerModelOverride, "claude-haiku-4.5");
  assert.deepEqual(contract.delegationContract.toolSurface, contract.commonContract.toolSurface);
  assert.equal(contract.delegationContract.artifact, ".github/skills/semantic-test-corpus/SKILL.md");
  assert.equal(contract.delegationContract.artifact, contract.delegationContract.registeredPath);
  assert.equal(contract.delegationContract.invocation, "semantic-test-corpus");
  assert.equal(contract.commonContract.agentName, "semantic-test-corpus");
  assert(contract.commonContract.toolSurface.every((name) => name.startsWith("semantic-corpus/")));
  assert.equal(existsSync(resolve(root, "design", "delegated-worker-skill.md")), false);
  assert(!readRootJson("design", "candidate-manifest.json").files.some((file) =>
    file.source === "design/delegated-worker-skill.md"));
  assert(!readRootJson("design", "candidate-manifest.json").files.some((file) =>
    file.destination.includes("semantic-test-corpus-haiku")));
});

test("synthetic signed-event unit enforces the common delegated mechanism", () => {
  const current = readRootJson("design", "arm-contract.json");
  assert.deepEqual(current.delegationContract.toolSurface, current.commonContract.toolSurface);
  assert(!current.commonContract.toolSurface.some((name) =>
    ["file.read", "file.write", "staging.validate"].includes(name)));
});

async function runSyntheticCorpusArm({ armId, runId, delegated }) {
  const request = readRootJson("design", "corpus-request.json");
  const run = await createCorpusRun(request);
  try {
    const mappingTarget = resolve(run.contract, "mapping-spec.json");
    writeFileSync(mappingTarget, readFileSync(resolve(root, "fixture", "spec", "mapping-spec.json")));
    chmodSync(mappingTarget, 0o400);

    const profile = readFileSync(resolve(root, "..", "..", ".github", "agents", "semantic-test-corpus.agent.md"), "utf8");
    assert.match(profile, /^name: semantic-test-corpus$/m);
    assert.doesNotMatch(profile.split("---")[1], /^model:/m);
    for (const tool of readRootJson("design", "arm-contract.json").commonContract.toolSurface) {
      assert(profile.includes(tool), `profile missing ${tool}`);
    }

    const service = await run.open();
    const responses = [];
    const dispatch = createDispatcher(service, (message) => responses.push(message));
    let nextId = 0;
    const calls = [];
    async function call(toolName, args, timestamp) {
      nextId += 1;
      await dispatch({
        jsonrpc: "2.0",
        id: nextId,
        method: "tools/call",
        params: { name: toolName.replace("semantic-corpus/", ""), arguments: args }
      });
      const response = responses.find((item) => item.id === nextId);
      calls.push({ callId: `${runId}-call-${nextId}`, toolName, args, timestamp, response });
      return response;
    }

    await call("semantic-corpus/list_contract_files", {}, "2026-07-29T00:02:10Z");
    await call("semantic-corpus/read_contract_file", { path: "request.json" }, "2026-07-29T00:02:20Z");
    const baseline = generateBaseline();
    await call("semantic-corpus/write_scenario_input", {
      scenarioId: "scenario-001",
      config: baseline.cases[0].input
    }, "2026-07-29T00:02:30Z");
    await call("semantic-corpus/write_scenario_input", {
      scenarioId: "scenario-002",
      config: baseline.cases[1].input
    }, "2026-07-29T00:02:40Z");
    const rejected = await call("semantic-corpus/write_scenario_input", {
      scenarioId: "scenario-003",
      config: { ...baseline.cases[2].input, expectedOutcome: "forbidden" }
    }, "2026-07-29T00:02:50Z");
    assert.equal(rejected.error.data.code, "SCHEMA_ERROR");

    const blockId = "B01";
    const actor = delegated ? "worker" : "parent";
    const actorSessionId = `${runId}-${actor}`;
    const events = authenticatedRoleEvents({
      runId,
      blockId,
      armId,
      contractRoot: run.contract,
      stagingRoot: run.staging,
      delegated
    });
    if (delegated) {
      const skillSha256 = createHash("sha256")
        .update(readFileSync(resolve(root, "..", "..", ".github", "skills", "semantic-test-corpus", "SKILL.md")))
        .digest("hex");
      events.push(
        {
          eventId: `${runId}-delegation-invoked`,
          type: "delegation.invoked",
          timestamp: "2026-07-29T00:02:00Z",
          sessionId: `${runId}-parent`,
          runId,
          blockId,
          armId,
          role: "parent",
          callId: `${runId}-delegation`,
          workerSessionId: `${runId}-worker`,
          skillName: "semantic-test-corpus",
          skillPath: ".github/skills/semantic-test-corpus/SKILL.md",
          agentName: "semantic-test-corpus",
          skillSha256
        },
        {
          eventId: `${runId}-delegation-completed`,
          type: "delegation.completed",
          timestamp: "2026-07-29T00:03:30Z",
          sessionId: `${runId}-parent`,
          runId,
          blockId,
          armId,
          role: "parent",
          callId: `${runId}-delegation`,
          agentName: "semantic-test-corpus",
          returnText: "corpus-staging - 2 scenarios - FAILURE: SCHEMA_ERROR"
        }
      );
    }
    for (const entry of calls) {
      const argumentsSha256 = createHash("sha256")
        .update(canonicalJson(entry.args))
        .digest("hex");
      const scenarioId = entry.args.scenarioId;
      events.push({
        eventId: `${entry.callId}-called`,
        type: "tool.called",
        timestamp: entry.timestamp,
        sessionId: actorSessionId,
        runId,
        blockId,
        armId,
        role: actor,
        actor,
        callId: entry.callId,
        toolName: entry.toolName,
        argumentsSha256,
        ...(scenarioId ? { scenarioId } : {})
      });
      const resultTimestamp = entry.timestamp.replace(/(\d\d)Z$/, (_, seconds) =>
        `${String(Number(seconds) + 1).padStart(2, "0")}Z`);
      const error = entry.response.error;
      events.push({
        eventId: `${entry.callId}-result`,
        type: "tool.result",
        timestamp: resultTimestamp,
        sessionId: actorSessionId,
        runId,
        blockId,
        armId,
        role: actor,
        actor,
        callId: entry.callId,
        toolName: entry.toolName,
        resultStatus: error ? "error" : "success",
        ...(error ? {
          errorCode: error.data.code,
          errorMessage: error.message
        } : {})
      });
      const accessPath = entry.toolName === "semantic-corpus/list_contract_files"
        || entry.toolName === "semantic-corpus/read_contract_file"
        ? resolve(run.contract, "request.json")
        : entry.toolName === "semantic-corpus/write_scenario_input" && !error
          ? resolve(run.staging, "scenarios", `${scenarioId}.json`)
          : null;
      if (accessPath) {
        events.push({
          eventId: `${entry.callId}-access`,
          type: "fs.access",
          timestamp: resultTimestamp,
          sessionId: actorSessionId,
          runId,
          blockId,
          armId,
          role: actor,
          actor,
          callId: entry.callId,
          path: accessPath,
          operation: accessPath.startsWith(run.contract) ? "read" : "write",
          decision: "allow"
        });
      }
    }

    const outputPath = resolve(run.cwd, "benchmark-staging", `${runId}.json`);
    const preAdapterExportedAt = "2026-07-29T00:04:17Z";
    const preAdapterPayload = {
      formatVersion: 1,
      provider: "github-copilot-platform",
      exportId: `export-${runId}-model-complete`,
      exportedAt: preAdapterExportedAt,
      capturedAt: "2026-07-29T00:04:16Z",
      events: events.filter((event) =>
        Date.parse(event.timestamp) <= Date.parse(preAdapterExportedAt))
    };
    const preAdapterSigned = signedExport(preAdapterPayload);
    const preAdapterAuthenticated = authenticateExport(
      preAdapterSigned.bytes,
      preAdapterSigned.signature,
      preAdapterSigned.publicKey
    );
    const adapted = snapshotCorpusStaging({
      corpusContractRoot: run.contract,
      corpusStagingRoot: run.staging,
      platformEvents: preAdapterAuthenticated.payload.events,
      runId,
      blockId,
      armId,
      seed: 1812433253,
      outputPath
    });
    assert.equal(adapted.submittedCases, 2);
    assert.equal(adapted.toolErrorCount, 1);
    assert.equal(adapted.staging.adapter.manifest, null);
    assert.equal(adapted.staging.toolErrors[0].code, "SCHEMA_ERROR");
    assert.deepEqual(adapted.bytes, canonicalStagingBytes(adapted.staging));
    assert.equal(adapted.snapshotSha256, createHash("sha256").update(adapted.bytes).digest("hex"));

    events.push({
      eventId: `${runId}-adapter`,
      type: "adapter.snapshot",
      timestamp: "2026-07-29T00:04:18Z",
      sessionId: `${runId}-evaluator`,
      runId,
      blockId,
      armId,
      role: "evaluator",
      actor: "evaluator",
      snapshotPath: outputPath,
      snapshotSha256: adapted.snapshotSha256,
      sourceStagingRoot: run.staging,
      adapterVersion: 1
    });
    const payload = {
      formatVersion: 1,
      provider: "github-copilot-platform",
      exportId: `export-${runId}`,
      exportedAt: "2026-07-29T00:10:00Z",
      capturedAt: "2026-07-29T00:05:00Z",
      events
    };
    const signed = signedExport(payload);
    const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
    const audit = evaluateIsolationEvidence(authenticated, {
      armId,
      runId,
      contractRoot: run.contract,
      stagingRoot: run.staging,
      evaluatorRoot,
      snapshotPath: outputPath
    });
    assert.equal(audit.status, "compliant", audit.violations.join("\n"));
    assert.equal(audit.snapshotSha256, adapted.snapshotSha256);
    assert.equal(audit.checks.correlatedWriteCalls, 2);
    assert.deepEqual(validateJsonSchema(
      audit,
      readRootJson("schemas", "isolation-audit.schema.json"),
      { schemaDir: resolve(root, "schemas") }
    ), []);

    return { payload, run, outputPath };
  } catch (error) {
    await run.cleanup();
    throw error;
  }
}

test("synthetic event units cover partial and rejected inline/delegated MCP runs", async () => {
  const inline = await runSyntheticCorpusArm({ armId: 1, runId: "B01-A1", delegated: false });
  const delegated = await runSyntheticCorpusArm({ armId: 2, runId: "B01-A2", delegated: true });
  try {
    const spoofed = structuredClone(delegated.payload);
    for (const event of spoofed.events.filter((item) =>
      ["tool.called", "tool.result", "fs.access"].includes(item.type))) {
      event.sessionId = "B01-A2-parent";
      event.role = "parent";
      event.actor = "parent";
    }
    const signed = signedExport(spoofed);
    const audit = evaluateIsolationEvidence(
      authenticateExport(signed.bytes, signed.signature, signed.publicKey),
      {
        armId: 2,
        runId: "B01-A2",
        contractRoot: delegated.run.contract,
        stagingRoot: delegated.run.staging,
        evaluatorRoot,
        snapshotPath: delegated.outputPath
      }
    );
    assert.equal(audit.status, "noncompliant");
    assert(audit.violations.some((violation) =>
      violation.includes("called semantic-corpus in a delegated arm")));

    const zeroEvidence = structuredClone(inline.payload);
    zeroEvidence.events = zeroEvidence.events.filter((event) =>
      !["tool.called", "tool.result", "fs.access"].includes(event.type));
    const zeroSigned = signedExport(zeroEvidence);
    const zeroAudit = evaluateIsolationEvidence(
      authenticateExport(zeroSigned.bytes, zeroSigned.signature, zeroSigned.publicKey),
      {
        armId: 1,
        runId: "B01-A1",
        contractRoot: inline.run.contract,
        stagingRoot: inline.run.staging,
        evaluatorRoot,
        snapshotPath: inline.outputPath
      }
    );
    assert.equal(zeroAudit.status, "noncompliant");
    assert(zeroAudit.violations.some((violation) =>
      violation.includes("successful-write count differs")));

    const mismatchedArguments = structuredClone(inline.payload);
    mismatchedArguments.events.find((event) =>
      event.type === "tool.called"
      && event.toolName === "semantic-corpus/write_scenario_input").argumentsSha256
      = "0".repeat(64);
    const mismatchedArgumentsSigned = signedExport(mismatchedArguments);
    const mismatchedArgumentsAudit = evaluateIsolationEvidence(
      authenticateExport(
        mismatchedArgumentsSigned.bytes,
        mismatchedArgumentsSigned.signature,
        mismatchedArgumentsSigned.publicKey
      ),
      {
        armId: 1,
        runId: "B01-A1",
        contractRoot: inline.run.contract,
        stagingRoot: inline.run.staging,
        evaluatorRoot,
        snapshotPath: inline.outputPath
      }
    );
    assert.equal(mismatchedArgumentsAudit.status, "noncompliant");
    assert(mismatchedArgumentsAudit.violations.some((violation) =>
      violation.includes("does not match its exact staged file")));

    const mismappedAdapter = structuredClone(delegated.payload);
    const adapterEvent = mismappedAdapter.events.find((event) => event.type === "adapter.snapshot");
    adapterEvent.blockId = "B02";
    adapterEvent.armId = 4;
    const mismappedSigned = signedExport(mismappedAdapter);
    const mismappedAudit = evaluateIsolationEvidence(
      authenticateExport(
        mismappedSigned.bytes,
        mismappedSigned.signature,
        mismappedSigned.publicKey
      ),
      {
        armId: 2,
        runId: "B01-A2",
        contractRoot: delegated.run.contract,
        stagingRoot: delegated.run.staging,
        evaluatorRoot,
        snapshotPath: delegated.outputPath
      }
    );
    assert.equal(mismappedAudit.status, "noncompliant");
    assert(mismappedAudit.violations.some((violation) =>
      violation.includes("adapter snapshot run mapping differs")));

    const validGlobalSigned = signedExport(inline.payload);
    const validGlobal = evaluateGlobalAttribution(authenticateExport(
      validGlobalSigned.bytes,
      validGlobalSigned.signature,
      validGlobalSigned.publicKey
    ));
    assert.equal(validGlobal.status, "compliant", validGlobal.violations.join("\n"));

    const mismappedBaseline = structuredClone(inline.payload);
    mismappedBaseline.events.find((event) =>
      event.eventId === "B01-A0-completed").armId = 1;
    const mismappedBaselineSigned = signedExport(mismappedBaseline);
    const mismappedBaselineGlobal = evaluateGlobalAttribution(authenticateExport(
      mismappedBaselineSigned.bytes,
      mismappedBaselineSigned.signature,
      mismappedBaselineSigned.publicKey
    ));
    assert.equal(mismappedBaselineGlobal.status, "noncompliant");
    assert(mismappedBaselineGlobal.violations.some((violation) =>
      violation.includes("baseline event B01-A0-completed")));

    const modelBackedBaseline = structuredClone(inline.payload);
    modelBackedBaseline.events.push({
      eventId: "B01-A0-created",
      type: "session.created",
      timestamp: "2026-07-29T00:00:30Z",
      sessionId: "B01-A0-process",
      runId: "B01-A0",
      blockId: "B01",
      armId: 0,
      role: "baseline"
    });
    const modelBackedBaselineSigned = signedExport(modelBackedBaseline);
    const modelBackedBaselineGlobal = evaluateGlobalAttribution(authenticateExport(
      modelBackedBaselineSigned.bytes,
      modelBackedBaselineSigned.signature,
      modelBackedBaselineSigned.publicKey
    ));
    assert.equal(modelBackedBaselineGlobal.status, "noncompliant");
    assert(modelBackedBaselineGlobal.violations.some((violation) =>
      violation.includes("forbidden model/MCP event")));
  } finally {
    await inline.run.cleanup();
    await delegated.run.cleanup();
  }
});

test("statistics accepts a full export containing authenticated baseline and AI events", async () => {
  const ai = await runSyntheticCorpusArm({ armId: 1, runId: "B01-A1", delegated: false });
  try {
    const baselineRun = frozenSchedule.runs.find((run) => run.runId === "B01-A0");
    const baselineSnapshotPath = resolve(ai.run.cwd, "benchmark-staging", "B01-A0.json");
    const baselineSnapshot = generateBaseline({
      blockId: "B01",
      seed: baselineRun.seed
    });
    const baselineSnapshotBytes = canonicalStagingBytes(baselineSnapshot);
    writeFileSync(baselineSnapshotPath, baselineSnapshotBytes);
    const definitions = [
      {
        runId: "B01-A0",
        blockId: "B01",
        armId: 0,
        snapshotPath: baselineSnapshotPath,
        snapshotBytes: baselineSnapshotBytes,
        metricsTimestamp: "2026-07-29T00:04:25Z"
      },
      {
        runId: "B01-A1",
        blockId: "B01",
        armId: 1,
        snapshotPath: ai.outputPath,
        snapshotBytes: readFileSync(ai.outputPath),
        metricsTimestamp: "2026-07-29T00:04:26Z"
      }
    ];
    const payload = structuredClone(ai.payload);
    for (const definition of definitions) {
      definition.artifact = deriveMetricsArtifact(definition.snapshotBytes, definition);
      definition.metricsPath = resolve(ai.run.cwd, "metrics", `${definition.runId}.json`);
      mkdirSync(dirname(definition.metricsPath), { recursive: true });
      definition.metricsBytes = canonicalMetricsBytes(definition.artifact);
      writeFileSync(definition.metricsPath, definition.metricsBytes);
      definition.metricsSha256 = createHash("sha256")
        .update(definition.metricsBytes)
        .digest("hex");
      definition.metricsEventId = `${definition.runId}-metrics`;
      definition.evaluatorSessionId = `${definition.runId}-evaluator`;
      definition.evaluatorProcessId = `${definition.runId}-evaluator-process`;
      payload.events.push({
        eventId: definition.metricsEventId,
        type: "metrics.computed",
        timestamp: definition.metricsTimestamp,
        sessionId: definition.evaluatorSessionId,
        processId: definition.evaluatorProcessId,
        runId: definition.runId,
        blockId: definition.blockId,
        armId: definition.armId,
        role: "evaluator",
        actor: "evaluator",
        metricsPath: definition.metricsPath,
        metricsSha256: definition.metricsSha256,
        snapshotSha256: definition.artifact.snapshotSha256,
        evaluatorCodeSha256: definition.artifact.provenance.evaluator.sha256,
        specSha256: definition.artifact.provenance.spec.sha256,
        oracleCodeSha256: definition.artifact.provenance.oracle.sha256,
        mutantCodeSha256: definition.artifact.provenance.mutants.sha256
      });
    }
    const signed = signedExport(payload);
    const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
    const unavailableUsage = () => ({
      available: false,
      nanoAiu: null,
      credits: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null
    });
    const commonRecord = (definition) => ({
      runId: definition.runId,
      blockId: definition.blockId,
      armId: definition.armId,
      availability: "available",
      phase: "complete",
      staging: {
        path: definition.snapshotPath,
        sha256: definition.artifact.snapshotSha256,
        sourceRoot: "corpus-staging/"
      },
      metrics: {
        path: definition.metricsPath,
        sha256: definition.metricsSha256,
        snapshotSha256: definition.artifact.snapshotSha256,
        eventId: definition.metricsEventId,
        evaluatorSessionId: definition.evaluatorSessionId,
        evaluatorProcessId: definition.evaluatorProcessId
      },
      timing: {
        startedAt: "2026-07-29T00:00:54Z",
        endedAt: "2026-07-29T00:04:10Z",
        latencyMs: 196000
      },
      usage: {
        parent: unavailableUsage(),
        worker: unavailableUsage(),
        total: unavailableUsage()
      },
      tools: { surface: [], calls: [] },
      compliance: {
        isolationAuditPath: `${definition.runId}.audit.json`,
        evidenceSha256: authenticated.authentication.payloadSha256,
        status: "compliant",
        checks: {},
        violations: []
      }
    });
    const baselineDefinition = definitions.find((definition) => definition.armId === 0);
    const aiDefinition = definitions.find((definition) => definition.armId === 1);
    const baselineRecord = {
      ...commonRecord(baselineDefinition),
      sessionIds: ["B01-A0-process"],
      modelEvidence: null
    };
    const aiRoles = ["parent"].map((role) => {
      const created = payload.events.find((event) =>
        event.runId === aiDefinition.runId && event.role === role && event.type === "session.created");
      const bound = payload.events.find((event) =>
        event.runId === aiDefinition.runId && event.role === role && event.type === "model.bound");
      return {
        role,
        sessionId: created.sessionId,
        sessionCreatedEventId: created.eventId,
        modelBoundEventId: bound.eventId
      };
    });
    const aiRecord = {
      ...commonRecord(aiDefinition),
      sessionIds: aiRoles.map((role) => role.sessionId),
      modelEvidence: {
        exportId: payload.exportId,
        payloadSha256: authenticated.authentication.payloadSha256,
        signatureSha256: authenticated.authentication.signatureSha256,
        publicKeySha256: authenticated.authentication.publicKeySha256,
        roles: aiRoles
      }
    };
    const runs = definitions.map((definition) => ({
      runId: definition.runId,
      blockId: definition.blockId,
      armId: definition.armId,
      metricsPath: definition.metricsPath,
      ...(definition.armId === 0 ? {} : {
        evidenceContext: {
          contractRoot: ai.run.contract,
          stagingRoot: ai.run.staging,
          evaluatorRoot
        }
      })
    }));
    const result = analyzeAuthenticatedStatisticsInput({
      runs,
      runRecords: [baselineRecord, aiRecord]
    }, authenticated);
    assert.deepEqual(result.analysisEligibility.unavailableIsolationRuns, []);
    assert.equal(result.descriptive.armSummaries
      .find((arm) => arm.armId === 0).eligibleOutcomes, 1);
    assert.equal(result.descriptive.armSummaries
      .find((arm) => arm.armId === 1).eligibleOutcomes, 1);

    const mismappedPayload = structuredClone(payload);
    mismappedPayload.events.find((event) =>
      event.eventId === "B01-A0-completed").armId = 1;
    const mismappedSigned = signedExport(mismappedPayload);
    const mismappedAuthenticated = authenticateExport(
      mismappedSigned.bytes,
      mismappedSigned.signature,
      mismappedSigned.publicKey
    );
    const mismappedAiRecord = structuredClone(aiRecord);
    Object.assign(mismappedAiRecord.modelEvidence, {
      payloadSha256: mismappedAuthenticated.authentication.payloadSha256,
      signatureSha256: mismappedAuthenticated.authentication.signatureSha256,
      publicKeySha256: mismappedAuthenticated.authentication.publicKeySha256
    });
    assert.throws(() => analyzeAuthenticatedStatisticsInput({
      runs,
      runRecords: [baselineRecord, mismappedAiRecord]
    }, mismappedAuthenticated), /global event attribution failed/);

    const overDurationPayload = structuredClone(payload);
    overDurationPayload.exportedAt = "2026-07-29T01:00:00Z";
    overDurationPayload.events.find((event) =>
      event.eventId === "B01-A0-completed").timestamp = "2026-07-29T00:31:00Z";
    overDurationPayload.events.find((event) =>
      event.eventId === "B01-A0-unblinded").timestamp = "2026-07-29T00:31:05Z";
    const baselineUsage = overDurationPayload.events.find((event) =>
      event.eventId === "B01-A0-usage");
    baselineUsage.timestamp = "2026-07-29T00:31:06Z";
    baselineUsage.intervalEnd = "2026-07-29T00:31:05Z";
    overDurationPayload.events.find((event) =>
      event.eventId === "B01-A0-metrics").timestamp = "2026-07-29T00:31:10Z";
    const overDurationSigned = signedExport(overDurationPayload);
    const overDurationAuthenticated = authenticateExport(
      overDurationSigned.bytes,
      overDurationSigned.signature,
      overDurationSigned.publicKey
    );
    const overDurationAiRecord = structuredClone(aiRecord);
    Object.assign(overDurationAiRecord.modelEvidence, {
      payloadSha256: overDurationAuthenticated.authentication.payloadSha256,
      signatureSha256: overDurationAuthenticated.authentication.signatureSha256,
      publicKeySha256: overDurationAuthenticated.authentication.publicKeySha256
    });
    assert(baselineRecord.timing.latencyMs < 30 * 60 * 1000);
    assert.throws(() => analyzeAuthenticatedStatisticsInput({
      runs,
      runRecords: [baselineRecord, overDurationAiRecord]
    }, overDurationAuthenticated), /baseline duration exceeds the 30-minute limit/);
  } finally {
    await ai.run.cleanup();
  }
});

test("captured real Copilot smoke audits preserve names and fail unavailable honestly", () => {
  const captures = readRootJson("fixtures", "platform-audit", "captures.json");
  const expectedTools = [
    "semantic-corpus/list_contract_files",
    "semantic-corpus/read_contract_file",
    "semantic-corpus/write_scenario_input",
    "semantic-corpus/write_scenario_manifest"
  ];
  for (const capture of captures.captures) {
    const bytes = readFileSync(resolve(root, capture.path));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    const adapted = adaptPlatformAudit({ rawBytes: bytes, cell: capture.cell });
    assert.equal(adapted.status, "unavailable");
    assert.equal(adapted.protocolCellAvailable, false);
    assert.equal(adapted.normalizedExport, null);
    assert(adapted.missingEvidence.includes("detached-ed25519-signature"));
    assert.deepEqual(
      [...new Set(adapted.observed.toolCalls.map((call) => call.contractToolName))].sort(),
      expectedTools.toSorted()
    );
    assert(adapted.observed.toolCalls.every((call) =>
      call.rawToolName === `semantic-corpus-${call.mcpToolName}`));
    if (capture.cell === "inline") {
      assert(adapted.observed.toolCalls.every((call) => call.actor === "parent"));
      assert.equal(adapted.observed.delegation.invoked, false);
    } else {
      assert(adapted.observed.toolCalls.every((call) => call.actor === "worker"));
      assert.equal(adapted.observed.delegation.invoked, true);
      assert.equal(adapted.observed.delegation.completed, true);
      assert.equal(adapted.observed.delegation.agentName, "semantic-test-corpus");
    }
  }
});

test("model preflight unit accepts only authenticated fresh atomic event evidence", () => {
  const signed = signedExport(modelEvidencePayload());
  const authenticated = authenticateExport(signed.bytes, signed.signature, signed.publicKey);
  const runRecords = modelRunRecords(authenticated);
  const available = evaluateModelBindings(authenticated, runRecords);
  assert.equal(available.allRunsAvailable, true);
  assert.equal(available.plannedRuns, 60);
  assert.equal(available.availableRuns, 60);
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
    staging: {
      path: "staging/B01-A1.json",
      sha256: "d".repeat(64),
      sourceRoot: "corpus-staging/"
    },
    metrics: {
      path: "metrics/B01-A1.json",
      sha256: "e".repeat(64),
      snapshotSha256: "d".repeat(64),
      eventId: "B01-A1-metrics",
      evaluatorSessionId: "B01-A1-evaluator",
      evaluatorProcessId: "B01-A1-evaluator-process"
    },
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
  const temporary = resolve(root, ".regression-work", "semantic-candidate");
  const repositoryRoot = resolve(root, "..", "..");
  const repositorySibling = resolve(repositoryRoot, "..", `.semantic-candidate-sibling-${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  rmSync(repositorySibling, { recursive: true, force: true });
  try {
    const boundary = materializeCandidate(temporary, {
      allowTestDestination: true,
      blockId: "B01"
    });
    assert.equal(boundary.files.length, readRootJson("design", "candidate-manifest.json").files.length);
    assert.equal(boundary.protocolId, "semantic-test-corpus-execution-v2");
    assert.match(boundary.boundarySha256, /^[a-f0-9]{64}$/);
    assert.match(boundary.terminalCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const sourcePin = readRootJson("design", "source-pin.json");
    assert.equal(boundary.sourceCommit, sourcePin.sourceCommit);
    assert.equal(boundary.sourceTree, sourcePin.sourceTree);
    assert(boundary.files.every((file) =>
      sourcePin.sourceBlobs[file.sourcePath] === file.sourceBlob));
    assert(boundary.files.every((file) => !file.path.startsWith("evaluator/")));
    assert.equal(existsSync(resolve(temporary, "evaluator")), false);
    assert.equal(spawnSync("git", ["status", "--short"], { cwd: temporary, encoding: "utf8" }).stdout, "");
    assert(existsSync(resolve(temporary, ".github", "agents", "semantic-test-corpus.agent.md")));
    assert.equal(
      existsSync(resolve(temporary, ".github", "agents", "semantic-test-corpus-haiku.agent.md")),
      false
    );
    assert(existsSync(resolve(temporary, "tools", "semantic-corpus-mcp", "server.mjs")));
    assert.equal(readRootJson("design", "corpus-request.json").targetCount, 60);
    for (const script of ["materialize-candidate.mjs", "collect-local-evidence.mjs"]) {
      assert.doesNotMatch(readFileSync(resolve(root, "scripts", script), "utf8"), /\bHEAD\b/u);
    }
    assert.throws(() => materializeCandidate(resolve(root, "candidate-output"), {
      blockId: "B01"
    }), /outside the source repository/);
    assert.throws(() => materializeCandidate(
      resolve(root, "..", "semantic-candidate-sibling"), { blockId: "B01" }
    ), /outside the source repository/);
    assert.equal(materializeCandidate(repositorySibling, {
      blockId: "B01"
    }).materializedRoot, repositorySibling);
    assert.throws(() => materializeCandidate(resolve(repositoryRoot, ".."), {
      blockId: "B01"
    }),
      /cannot contain the source repository/);

    process.env.SEMANTIC_CORPUS_ALLOW_TEST_DESTINATION = "1";
    assert.throws(() => materializeCandidate(resolve(root, "environment-override"), {
      blockId: "B01"
    }),
      /outside the source repository/);
    delete process.env.SEMANTIC_CORPUS_ALLOW_TEST_DESTINATION;

    const junctionTarget = resolve(root, ".regression-work", "junction-target");
    const junction = resolve(root, ".regression-work", "junction");
    mkdirSync(junctionTarget, { recursive: true });
    try {
      symlinkSync(junctionTarget, junction, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => materializeCandidate(junction, {
        allowTestDestination: true,
        blockId: "B01"
      }),
        /symbolic link, junction, or reparse/);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    }
  } finally {
    delete process.env.SEMANTIC_CORPUS_ALLOW_TEST_DESTINATION;
    rmSync(resolve(root, ".regression-work"), { recursive: true, force: true });
    rmSync(repositorySibling, { recursive: true, force: true });
  }
});

test("isolation compliance is derived from signed policy and access logs", () => {
  const current = readRootJson("design", "platform-evidence-contract.json");
  assert.equal(current.policy.filesystemMode, "semantic-corpus-contract-ro-staging-rw");
  assert(current.requiredIsolationEvents.includes("adapter.snapshot"));
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
    bindingAvailability: bindingAvailabilityFor(observations)
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
  }), /authenticated platform export/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    alpha: 1
  }), /authenticated platform export/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    margins: { promotionRate: 0 }
  }), /authenticated platform export/);
  assert.throws(() => analyzeStatisticsInput({
    observations,
    bindingAvailability: bindings,
    bootstrapSeed: 1,
    bootstrapResamples: 1
  }), /authenticated platform export/);

  const signedEvidence = signedExport(modelEvidencePayload());
  const authenticatedEvidence = authenticateExport(
    signedEvidence.bytes,
    signedEvidence.signature,
    signedEvidence.publicKey
  );
  assert.throws(() => analyzeAuthenticatedStatisticsInput({
    observations,
    runRecords: modelRunRecords(authenticatedEvidence),
    bindingAvailability: bindings
  }, authenticatedEvidence), /caller-supplied analysis\/evidence fields are forbidden/);
});

test("factorial summaries and missingness sensitivity match known synthetic values", () => {
  const armValues = new Map([[0, 0.5], [1, 0.6], [2, 0.7], [3, 0.4], [4, 0.45]]);
  const observations = frozenSchedule.runs.filter((run) => run.armId <= 4).map((run) => ({
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
    bindingAvailability: bindingAvailabilityFor(observations)
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

  const unavailableRun = analyzeBaselineComparisons(observations, {
    bindingAvailability: bindingAvailabilityFor(observations, ["B12-A4"])
  });
  assert.equal(unavailableRun.analysisEligibility.completeBlocks.length, 11);
  assert.equal(unavailableRun.analysisEligibility.confirmatoryAvailable, false);
  assert.deepEqual(unavailableRun.analysisEligibility.unavailableAiRuns, ["B12-A4"]);
  assert.match(unavailableRun.analysisEligibility.unavailableReason, /lack frozen model availability/);
  assert.equal(unavailableRun.comparisons, null);
  assert.equal(unavailableRun.factorial, null);

  const isolationUnavailableObservations = structuredClone(observations);
  isolationUnavailableObservations.find((observation) => observation.runId === "B12-A4").isolationVerified = false;
  const isolationUnavailable = analyzeBaselineComparisons(isolationUnavailableObservations, {
    bindingAvailability: bindingAvailabilityFor(isolationUnavailableObservations)
  });
  assert.deepEqual(isolationUnavailable.analysisEligibility.unavailableIsolationRuns, ["B12-A4"]);
  assert.equal(isolationUnavailable.analysisEligibility.confirmatoryAvailable, false);
  assert.equal(isolationUnavailable.comparisons, null);
  assert.equal(isolationUnavailable.factorial, null);

  const baselineOnly = observations.filter((observation) => observation.armId === 0);
  const zeroComplete = analyzeBaselineComparisons(baselineOnly, {
    bindingAvailability: bindingAvailabilityFor(observations)
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
