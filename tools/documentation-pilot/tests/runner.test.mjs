import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {evaluateAdherence} from "../../../experiments/documentation-delegation/scripts/evaluate-adherence.mjs";
import {
  RUNNER_PROTOCOL_ID,
  assertAuthorizationFresh,
  assertFrozenOrder,
  auditTelemetry,
  buildCanonicalSummary,
  buildCopilotArgs,
  buildWorkerHandoff,
  computePilotDecision,
  createExecutionAuthorization,
  defaultLifecycleIndex,
  frozenMaterializationId,
  jsonBytes,
  pilotRuns,
  privacyAudit,
  readDesign,
  runnerPackageDigest,
  settleUsage
} from "../core.mjs";
import {
  buildCandidateEnvironment,
  captureCandidateInputs,
  executePilot,
  freezeCandidatePolicy,
  inspectCandidateLaunch,
  preflight,
  runNegativeControlProbes,
  runObservation,
  verifyCandidateOutputs
} from "../runner.mjs";

function temporary(name) {
  return resolve(tmpdir(), `${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

function executionAuthorization() {
  const now = new Date();
  return {
    approved: true,
    basis: "merged-prospective-amendment-plus-explicit-execute",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    nonce: "synthetic-authorization-nonce",
    authorizationBlobSha256: "a".repeat(64)
  };
}

function passingProbes() {
  return {
    pass: true,
    reasons: [],
    launcherStatus: 0,
    candidateReadable: true,
    deniedPathCount: 7,
    deniedReadableCount: 0
  };
}

function usageRow(id, run, worker = false) {
  return {
    id,
    session_id: run.parentSessionId,
    turn_index: 0,
    agent_id: worker ? run.workerSessionId : null,
    parent_tool_call_id: worker ? run.workerSessionId : null,
    model: worker ? "claude-haiku-4.5" : "gpt-5.6-sol",
    input_tokens: worker ? 50 : 100,
    output_tokens: worker ? 10 : 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_nano_aiu: worker ? 250_000_000 : 1_000_000_000,
    request_multiplier: 1,
    duration_ms: worker ? 250 : 500,
    time_to_first_token_ms: 20,
    inter_token_latency_ms: 2,
    initiator: worker ? "sub-agent" : "user",
    api_endpoint: "responses",
    reasoning_effort: worker ? null : "medium",
    finish_reason: "stop",
    content_filter_triggered: 0,
    token_details_json: "{}",
    created_at: "2026-08-01T00:00:00.000Z"
  };
}

function event(type, data, timestamp, extra = {}) {
  return {type, data, timestamp, ...extra};
}

function syntheticEvents(run, candidateRoot, {parentReadAfter = false} = {}) {
  const start = "2026-08-01T00:00:00.000Z";
  const target = resolve(candidateRoot, "docs", "guide.md");
  const events = [
    event("user.message", {content: "frozen prompt"}, start),
    event("model.call_start", {model: "gpt-5.6-sol"}, "2026-08-01T00:00:00.010Z")
  ];
  if (run.arm === "A2") {
    events.push(
      event("tool.execution_start", {
        toolCallId: "skill-call",
        toolName: "skill",
        arguments: {skill: "feature-documentation"}
      }, "2026-08-01T00:00:00.020Z"),
      event("tool.execution_complete", {
        toolCallId: "skill-call",
        success: true,
        result: {content: "loaded"}
      }, "2026-08-01T00:00:00.030Z"),
      event("tool.execution_start", {
        toolCallId: run.workerSessionId,
        toolName: "task",
        arguments: {
          agent_type: "feature-documentation-haiku",
          prompt: buildWorkerHandoff({
            sourcePath: "src/index.mjs",
            docTarget: "docs/guide.md"
          })
        }
      }, "2026-08-01T00:00:00.040Z"),
      event("subagent.started", {
        toolCallId: run.workerSessionId,
        sessionId: run.workerSessionId,
        model: "claude-haiku-4.5"
      }, "2026-08-01T00:00:00.050Z", {agentId: run.workerSessionId}),
      event("model.call_start", {
        model: "claude-haiku-4.5",
        parentToolCallId: run.workerSessionId
      }, "2026-08-01T00:00:00.060Z", {agentId: run.workerSessionId}),
      event("tool.execution_start", {
        toolCallId: "worker-read",
        toolName: "read",
        arguments: {path: resolve(candidateRoot, "TASK.md")},
        parentToolCallId: run.workerSessionId
      }, "2026-08-01T00:00:00.070Z", {agentId: run.workerSessionId}),
      event("tool.execution_complete", {
        toolCallId: "worker-read",
        success: true,
        result: {content: "task"},
        parentToolCallId: run.workerSessionId
      }, "2026-08-01T00:00:00.080Z", {agentId: run.workerSessionId}),
      event("tool.execution_start", {
        toolCallId: "worker-edit",
        toolName: "edit",
        arguments: {path: target},
        parentToolCallId: run.workerSessionId
      }, "2026-08-01T00:00:00.090Z", {agentId: run.workerSessionId}),
      event("tool.execution_complete", {
        toolCallId: "worker-edit",
        success: true,
        result: {content: "written"},
        parentToolCallId: run.workerSessionId
      }, "2026-08-01T00:00:00.100Z", {agentId: run.workerSessionId}),
      event("subagent.completed", {
        toolCallId: run.workerSessionId,
        model: "claude-haiku-4.5"
      }, "2026-08-01T00:00:00.110Z", {agentId: run.workerSessionId}),
      event("tool.execution_complete", {
        toolCallId: run.workerSessionId,
        success: true,
        result: {content: `${target} - SUCCESS`}
      }, "2026-08-01T00:00:00.120Z")
    );
    if (parentReadAfter) {
      events.push(
        event("tool.execution_start", {
          toolCallId: "parent-read",
          toolName: "read",
          arguments: {path: target}
        }, "2026-08-01T00:00:00.130Z"),
        event("tool.execution_complete", {
          toolCallId: "parent-read",
          success: true,
          result: {content: "forbidden"}
        }, "2026-08-01T00:00:00.140Z")
      );
    }
  }
  events.push({
    type: "result",
    timestamp: "2026-08-01T00:00:01.000Z",
    sessionId: run.parentSessionId,
    exitCode: 0
  });
  return events;
}

function boundary(candidateRoot) {
  return {
    caseSensitivePaths: process.platform !== "win32",
    candidateRoot,
    docTarget: resolve(candidateRoot, "docs", "guide.md"),
    allowedWorkerReads: [
      resolve(candidateRoot, "TASK.md"),
      resolve(candidateRoot, "docs", "CONVENTIONS.md"),
      resolve(candidateRoot, "src", "index.mjs"),
      resolve(candidateRoot, "docs", "guide.md")
    ],
    allowedWorkerWrites: [resolve(candidateRoot, "docs", "guide.md")]
  };
}

function fakeMaterialize({candidateRoot, evaluatorRoot, observationId}) {
  mkdirSync(resolve(candidateRoot, "docs"), {recursive: true});
  mkdirSync(resolve(candidateRoot, "src"), {recursive: true});
  mkdirSync(evaluatorRoot, {recursive: true});
  writeFileSync(resolve(candidateRoot, "TASK.md"), "synthetic\n");
  writeFileSync(resolve(candidateRoot, "docs", "CONVENTIONS.md"), "synthetic\n");
  writeFileSync(resolve(candidateRoot, "docs", "guide.md"), "");
  writeFileSync(resolve(candidateRoot, "src", "index.mjs"), "export const value = 1;\n");
  writeFileSync(resolve(candidateRoot, "CANDIDATE.json"), jsonBytes({
    observationId,
    sourcePath: "src/index.mjs",
    docTarget: "docs/guide.md",
    allowedWorkerReads: [
      "TASK.md", "docs/CONVENTIONS.md", "src/index.mjs", "docs/guide.md"
    ],
    allowedWorkerWrites: ["docs/guide.md"]
  }));
  writeFileSync(resolve(evaluatorRoot, "hidden-spec.json"), "{}\n");
}

function fakeEvaluation() {
  return {
    schemaVersion: 1,
    taskId: "pilot-synthetic",
    variantId: "v1",
    pass: true,
    feature: {score: 1, passed: 1, total: 1, failures: []},
    documentation: {
      correctness: 1,
      coverage: 1,
      executability: 1,
      format: 1,
      unsupportedClaims: 0,
      details: []
    }
  };
}

test("execution arguments pin prompts, models, tools, and parent session IDs", () => {
  const [a2, a1] = pilotRuns();
  const a2Args = buildCopilotArgs({run: a2, candidateRoot: "C:\\candidate"});
  const a1Args = buildCopilotArgs({run: a1, candidateRoot: "C:\\candidate"});
  assert.equal(a2Args[a2Args.indexOf("--session-id") + 1], a2.parentSessionId);
  assert.equal(a2Args[a2Args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.ok(a2Args.includes("--available-tools=read,edit,bash,skill,task"));
  assert.ok(a1Args.includes("--available-tools=read,edit,bash"));
  assert.ok(!a1Args.join(" ").includes("feature-documentation-haiku"));
  assert.match(a2Args[1], /^You own the complete engineering task/);
});

test("lifecycle order rejects duplicates and substitution", () => {
  const runs = pilotRuns();
  const index = defaultLifecycleIndex();
  assert.doesNotThrow(() => assertFrozenOrder(index, runs[0]));
  assert.throws(() => assertFrozenOrder(index, runs[1]), /Next frozen observation/u);
  index.entries.push({
    observationId: runs[0].observationId,
    parentSessionId: runs[0].parentSessionId,
    workerSessionId: runs[0].workerSessionId
  });
  assert.doesNotThrow(() => assertFrozenOrder(index, runs[1]));
  assert.throws(() => assertFrozenOrder(index, runs[0]), /Next frozen observation|already consumed/u);
});

test("actor and tool parsing enforces worker confinement and parent no-review", () => {
  const run = pilotRuns().find((item) => item.arm === "A2");
  const candidate = temporary("docs-actor");
  const good = auditTelemetry(syntheticEvents(run, candidate), {
    run,
    boundary: boundary(candidate),
    evaluateAdherence
  });
  assert.equal(good.adherent, true, good.reasons.join("\n"));
  assert.equal(good.workerCallId, run.workerSessionId);
  const reviewed = auditTelemetry(syntheticEvents(run, candidate, {parentReadAfter: true}), {
    run,
    boundary: boundary(candidate),
    evaluateAdherence
  });
  assert.equal(reviewed.adherent, false);
  assert.match(reviewed.reasons.join("\n"), /Parent read or edited/u);
});

test("usage aggregation partitions parent and worker and fails closed", () => {
  const a2 = pilotRuns().find((item) => item.arm === "A2");
  const rows = [usageRow(1, a2), usageRow(2, a2, true)];
  const settled = settleUsage(rows, {run: a2, workerCallId: a2.workerSessionId});
  assert.equal(settled.available, true);
  assert.equal(settled.usage.combinedAiCredits, 1.25);
  assert.equal(settled.usage.parentCumulativeInputTokens, 100);
  assert.equal(settled.usage.workerTokens, 60);
  const ambiguous = settleUsage([...rows, {...rows[0], id: 3, agent_id: "other"}], {
    run: a2,
    workerCallId: a2.workerSessionId
  });
  assert.equal(ambiguous.available, false);
  assert.match(ambiguous.reasons.join("\n"), /unattributed/u);
});

test("privacy audit rejects secret-bearing evidence", () => {
  assert.equal(privacyAudit({events: "synthetic fixture"}).pass, true);
  assert.equal(privacyAudit({events: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"}).pass, false);
});

test("pilot gate math and canonical report require all frozen conjuncts", () => {
  const observations = pilotRuns().map((run) => ({
    observationId: run.observationId,
    blockId: run.blockId,
    arm: run.arm,
    started: true,
    startCount: 1,
    completed: true,
    disposition: "complete",
    adherent: true,
    routingPass: true,
    parentNoReview: true,
    usageSettled: true,
    terminalCaptured: true,
    usage: {
      combinedAiCredits: run.arm === "A2" ? 1 : 2,
      parentCumulativeInputTokens: run.arm === "A2" ? 100 : 200
    },
    timing: {},
    tools: {},
    evaluation: fakeEvaluation(),
    evidenceSha256: "a".repeat(64),
    failure: null
  }));
  const reproduction = {pass: true, passes: 2, details: []};
  assert.equal(computePilotDecision(observations, reproduction).decision, "GO");
  observations[0].usageSettled = false;
  assert.equal(computePilotDecision(observations, reproduction).decision, "NO-GO");
  const report = buildCanonicalSummary(observations, reproduction, "b".repeat(64));
  assert.equal(report.pilot.decision, "NO-GO");
  assert.equal(report.authorizationBoundary.mainAuthorized, false);
  assert.equal(report.runs.some((run) => "path" in run), false);
});

test("synthetic full lifecycle retains evidence without AI calls", () => {
  const root = temporary("documentation-pilot-lifecycle");
  const artifactRoot = resolve(root, "artifacts");
  const candidateRoot = resolve(root, "candidates");
  const expected = readDesign().manifest.generatedBundles;
  const options = {
    cli: process.execPath,
    sessionStore: "synthetic",
    artifactRoot,
    candidateRoot,
    sandboxLauncher: "never-called",
    sandboxSha256: "0".repeat(64),
    configuredMcpServers: ["azure"],
    authorizationFile: null
  };
  try {
    mkdirSync(root);
    const result = executePilot(options, {
      preflight: () => ({
        pass: true,
        reasons: [],
        authorization: executionAuthorization(),
        configuredMcpServers: ["azure"]
      }),
      materializeFixture: fakeMaterialize,
      directoryDigest: (path) => {
        const run = pilotRuns().find((item) =>
          path.includes(item.worktreeId) || path.includes(item.observationId));
        const key = `pilot/${run.fixtureId}/${run.variantId}`;
        return path.endsWith("evaluator")
          ? expected[key].evaluatorSha256
          : expected[key].candidateSha256;
      },
      createCandidateGitRoot: () => ({
        initialCommit: "1".repeat(40),
        initialTree: "2".repeat(40)
      }),
      runNegativeControlProbes: passingProbes,
      execute: ({run, candidateRoot: candidate}) => ({
        status: 0,
        signal: null,
        error: null,
        stdout: Buffer.from(
          syntheticEvents(run, candidate).map((item) => JSON.stringify(item)).join("\n") + "\n"
        ),
        stderr: Buffer.alloc(0)
      }),
      readUsageRows: (_database, parentSessionId) => {
        const run = pilotRuns().find((item) => item.parentSessionId === parentSessionId);
        return [
          usageRow(1, run),
          ...(run.arm === "A2" ? [usageRow(2, run, true)] : [])
        ];
      },
      evaluate: fakeEvaluation
    });
    assert.equal(result.observations.length, 4);
    assert.equal(
      result.summary.pilot.decision,
      "GO",
      JSON.stringify({
        gates: result.summary.pilot.gates,
        observations: result.observations.map((item) => ({
          id: item.observationId,
          reasons: item.observation.adherence.violations,
          failure: item.failure
        }))
      }, null, 2)
    );
    assert.equal(result.reproduction.details.length, 8);
    assert.equal(
      JSON.parse(readFileSync(resolve(artifactRoot, "lifecycle", "index.json"), "utf8"))
        .entries.length,
      4
    );
    assert.equal(
      JSON.parse(readFileSync(resolve(artifactRoot, "canonical", "pilot-summary.json"), "utf8"))
        .authorizationBoundary.mainAuthorized,
      false
    );
    const canonicalRun = JSON.parse(readFileSync(
      resolve(artifactRoot, "canonical", pilotRuns()[0].observationId + ".json"),
      "utf8"
    ));
    assert.deepEqual(Object.keys(canonicalRun).sort(), ["disposition", "observation"]);
    assert.deepEqual(Object.keys(canonicalRun.observation).sort(), [
      "adherence", "adherent", "arm", "blockId", "completed", "evaluation", "fixtureId",
      "observationId", "order", "parentSessionId", "protocolId", "schemaVersion",
      "sourceCommit", "started", "timing", "tools", "usage", "variantId", "workerSessionId"
    ].sort());
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("post-spawn malformed telemetry is retained as ITT failure without retry", () => {
  const root = temporary("documentation-pilot-failure");
  const artifactRoot = resolve(root, "artifacts");
  const candidateRoot = resolve(root, "candidates");
  const expected = readDesign().manifest.generatedBundles;
  try {
    mkdirSync(root);
    const result = executePilot({
      cli: process.execPath,
      sessionStore: "synthetic",
      artifactRoot,
      candidateRoot,
      sandboxLauncher: "never-called",
      sandboxSha256: "0".repeat(64),
      configuredMcpServers: [],
      authorizationFile: null
    }, {
      preflight: () => ({
        pass: true,
        reasons: [],
        authorization: executionAuthorization()
      }),
      materializeFixture: fakeMaterialize,
      directoryDigest: (path) => {
        const run = pilotRuns()[0];
        const key = `pilot/${run.fixtureId}/${run.variantId}`;
        return path.endsWith("evaluator")
          ? expected[key].evaluatorSha256
          : expected[key].candidateSha256;
      },
      createCandidateGitRoot: () => ({
        initialCommit: "1".repeat(40),
        initialTree: "2".repeat(40)
      }),
      runNegativeControlProbes: passingProbes,
      execute: () => ({
        status: 23,
        signal: null,
        error: null,
        stdout: Buffer.from("{\"type\":\"model.call_start\"\n"),
        stderr: Buffer.from("synthetic failure")
      }),
      readUsageRows: (_database, parentSessionId) => {
        const run = pilotRuns().find((item) => item.parentSessionId === parentSessionId);
        return [usageRow(1, run)];
      },
      evaluate: fakeEvaluation
    });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].started, true);
    assert.equal(result.observations[0].startCount, 1);
    assert.equal(result.observations[0].disposition, "started-failure");
    assert.equal(result.summary.pilot.decision, "NO-GO");
    assert.match(
      readFileSync(
        resolve(artifactRoot, "private", pilotRuns()[0].observationId, "events.jsonl"),
        "utf8"
      ),
      /model.call_start/u
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CLI refuses implicit execution and no-run attestation remains zero", () => {
  const runner = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runner.mjs");
  const refused = spawnSync(process.execPath, [runner], {encoding: "utf8"});
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to run without exactly one mode/u);
  const attestation = JSON.parse(
    readFileSync(resolve(dirname(runner), "no-run-attestation.json"), "utf8")
  );
  assert.equal(attestation.aiObservationsStarted, 0);
  assert.equal(attestation.pilotIdsConsumed, 0);
  assert.equal(attestation.resultRootsCreated, false);
});

test("frozen bundle identity uses preregistered placeholder bytes", () => {
  const run = pilotRuns()[0];
  assert.equal(
    frozenMaterializationId(run),
    `FREEZE-${run.fixtureId}-${run.variantId}`
  );
});

test("real evaluator preparation branch is reachable without AI execution", () => {
  const root = temporary("documentation-pilot-evaluator-runtime");
  const run = pilotRuns()[0];
  const expected = readDesign().manifest.generatedBundles[
    `pilot/${run.fixtureId}/${run.variantId}`
  ];
  const options = {
    cli: process.execPath,
    sessionStore: "synthetic",
    artifactRoot: resolve(root, "artifacts"),
    candidateRoot: resolve(root, "candidates"),
    sandboxLauncher: resolve(root, "missing-launcher.exe"),
    sandboxSha256: "0".repeat(64),
    configuredMcpServers: [],
    authorization: {authorizationBlobSha256: "a".repeat(64)}
  };
  try {
    mkdirSync(options.artifactRoot, {recursive: true});
    mkdirSync(options.candidateRoot, {recursive: true});
    const result = runObservation(options, run, {
      materializeFixture: fakeMaterialize,
      directoryDigest: (path) => path.endsWith("evaluator")
        ? expected.evaluatorSha256
        : expected.candidateSha256,
      createCandidateGitRoot: () => ({
        initialCommit: "1".repeat(40),
        initialTree: "2".repeat(40)
      }),
      runNegativeControlProbes: passingProbes,
      execute: ({run: current, candidateRoot}) => ({
        status: 0,
        signal: null,
        error: null,
        stdout: Buffer.from(
          syntheticEvents(current, candidateRoot)
            .map((item) => JSON.stringify(item)).join("\n") + "\n"
        ),
        stderr: Buffer.alloc(0)
      }),
      readUsageRows: (_database, parentSessionId) => {
        const current = pilotRuns().find((item) => item.parentSessionId === parentSessionId);
        return [usageRow(1, current), usageRow(2, current, true)];
      }
    });
    assert.equal(result.disposition, "started-failure");
    assert.doesNotMatch(result.failure, /prepareEvaluatorRuntime is not defined/u);
    assert.equal(existsSync(resolve(
      options.artifactRoot,
      "private",
      run.observationId,
      "evaluator",
      ".runtime",
      "evaluate.mjs"
    )), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("runner package digest is deterministic and excludes future approvals", () => {
  const first = runnerPackageDigest();
  const second = runnerPackageDigest();
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, second);
});

test("execution authorization is fresh, nonce-bound, and expires", () => {
  const root = temporary("documentation-pilot-authorization");
  const cli = resolve(root, "copilot.exe");
  try {
    mkdirSync(root);
    writeFileSync(cli, "synthetic cli");
    const now = new Date("2026-08-01T00:00:00.000Z");
    const authorization = createExecutionAuthorization({
      cli,
      sessionStore: resolve(root, "store.db"),
      artifactRoot: resolve(root, "artifacts"),
      candidateRoot: resolve(root, "candidates"),
      sandboxSha256: "0".repeat(64)
    }, {
      pass: true,
      head: "1".repeat(40),
      canonicalRemoteMain: "1".repeat(40)
    }, now, "reviewed-execution-nonce");
    assert.doesNotThrow(() => assertAuthorizationFresh(authorization, now));
    assert.throws(
      () => assertAuthorizationFresh(authorization, new Date(authorization.expiresAt)),
      /stale/u
    );
    assert.equal(authorization.basis, "merged-prospective-amendment-plus-explicit-execute");
    assert.equal(authorization.runnerSourceCommit, "1".repeat(40));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("request-generation preflight succeeds without self-authorizing execution", () => {
  const root = temporary("documentation-pilot-request-preflight");
  const sessionStore = resolve(root, "session-store.db");
  try {
    mkdirSync(root);
    writeFileSync(sessionStore, "");
    const result = preflight({
      cli: process.execPath,
      sessionStore,
      artifactRoot: resolve(root, "artifacts"),
      candidateRoot: resolve(root, "candidates"),
      sandboxLauncher: resolve(root, "launcher.exe"),
      sandboxSha256: "0".repeat(64),
      authorizationFile: null
    }, {
      inspectCleanRepository: () => ({pass: true, status: ""}),
      inspectCli: () => ({
        pass: true,
        reasons: [],
        versionLine: "GitHub Copilot CLI 1.0.77.",
        configuredMcpServers: []
      }),
      inspectSandboxLauncher: () => ({
        pass: true,
        reasons: [],
        sha256: "0".repeat(64),
        verification: "hash-only"
      }),
      assertNoConsumedIds: () => {}
    });
    assert.equal(result.pass, true, result.reasons.join("\n"));
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.authorization, null);
    assert.match(result.authorizationRequest.runnerSha256, /^[a-f0-9]{64}$/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("spawned process with empty usage is evaluated then stopped as start-unverifiable", () => {
  const root = temporary("documentation-pilot-unverifiable-start");
  const run = pilotRuns()[0];
  const expected = readDesign().manifest.generatedBundles[
    `pilot/${run.fixtureId}/${run.variantId}`
  ];
  const options = {
    cli: process.execPath,
    sessionStore: "synthetic",
    artifactRoot: resolve(root, "artifacts"),
    candidateRoot: resolve(root, "candidates"),
    sandboxLauncher: "never-called",
    sandboxSha256: "0".repeat(64),
    configuredMcpServers: [],
    authorization: {authorizationBlobSha256: "a".repeat(64)}
  };
  try {
    mkdirSync(options.artifactRoot, {recursive: true});
    mkdirSync(options.candidateRoot, {recursive: true});
    const result = runObservation(options, run, {
      materializeFixture: fakeMaterialize,
      directoryDigest: (path) => path.endsWith("evaluator")
        ? expected.evaluatorSha256
        : expected.candidateSha256,
      createCandidateGitRoot: () => ({
        initialCommit: "1".repeat(40),
        initialTree: "2".repeat(40)
      }),
      runNegativeControlProbes: passingProbes,
      execute: ({run: current, candidateRoot}) => ({
        status: 0,
        signal: null,
        error: null,
        stdout: Buffer.from(
          syntheticEvents(current, candidateRoot)
            .map((item) => JSON.stringify(item)).join("\n") + "\n"
        ),
        stderr: Buffer.alloc(0)
      }),
      readUsageRows: () => [],
      evaluate: fakeEvaluation
    });
    assert.equal(result.started, false);
    assert.equal(result.disposition, "start-unverifiable");
    assert.deepEqual(result.evaluation, fakeEvaluation());
    assert.match(result.failure, /start boundary is unverifiable/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("candidate launch omits hidden roots and permits only Copilot control-plane policy", () => {
  const root = temporary("documentation-pilot-disclosure");
  const candidateRoot = resolve(root, "candidate");
  const evidenceRoot = resolve(root, "evidence");
  const evaluatorRoot = resolve(evidenceRoot, "evaluator");
  const run = pilotRuns()[0];
  const args = buildCopilotArgs({run, candidateRoot});
  const environment = buildCandidateEnvironment({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: evidenceRoot,
    SAFE_VALUE: "candidate-safe"
  }, [evidenceRoot, evaluatorRoot]);
  const inspection = inspectCandidateLaunch({
    candidateRoot,
    executable: process.execPath,
    args,
    environment,
    forbiddenPaths: [evidenceRoot, evaluatorRoot]
  });
  assert.equal(inspection.pass, true);
  assert.equal("GITHUB_WORKSPACE" in environment, false);
  assert.match(inspection.launcherArguments.join(" "), /copilot-control-plane/u);
  assert.doesNotMatch(JSON.stringify({args, environment}), /evidence|evaluator/u);
  const disclosed = inspectCandidateLaunch({
    candidateRoot,
    executable: process.execPath,
    args: [...args, evidenceRoot],
    environment,
    forbiddenPaths: [evidenceRoot]
  });
  assert.equal(disclosed.pass, false);
});

test("runner-owned policy survives candidate manifest tampering and rejects it", () => {
  const root = temporary("documentation-pilot-policy");
  const candidateRoot = resolve(root, "candidate");
  const evaluatorRoot = resolve(root, "evaluator");
  try {
    fakeMaterialize({candidateRoot, evaluatorRoot, observationId: "synthetic"});
    const policy = freezeCandidatePolicy(candidateRoot);
    const captured = captureCandidateInputs(candidateRoot, policy);
    writeFileSync(policy.docTarget, "allowed output\n");
    assert.equal(verifyCandidateOutputs(candidateRoot, captured).pass, true);
    writeFileSync(resolve(candidateRoot, "CANDIDATE.json"), jsonBytes({
      sourcePath: "..\\hidden\\source.mjs",
      docTarget: "..\\hidden\\gold.md",
      allowedWorkerReads: ["..\\hidden"],
      allowedWorkerWrites: ["..\\hidden"]
    }));
    const result = verifyCandidateOutputs(candidateRoot, captured);
    assert.equal(result.pass, false);
    assert.match(result.reasons.join("\n"), /CANDIDATE\.json/u);
    assert.equal(policy.docTarget, resolve(candidateRoot, "docs", "guide.md"));
    assert.equal(policy.boundary.allowedWorkerReads.every((path) =>
      path.startsWith(candidateRoot)), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("negative controls fail against an unconfined Windows-compatible launch", () => {
  const root = temporary("documentation-pilot-probes");
  const candidateRoot = resolve(root, "candidate");
  const hiddenRoot = resolve(root, "hidden");
  try {
    mkdirSync(candidateRoot, {recursive: true});
    mkdirSync(hiddenRoot, {recursive: true});
    writeFileSync(resolve(candidateRoot, "public.txt"), "public");
    writeFileSync(resolve(hiddenRoot, "gold.txt"), "hidden");
    const result = runNegativeControlProbes({
      launcher: "synthetic-launcher",
      candidateRoot,
      deniedPaths: [hiddenRoot],
      spawn: (_launcher, args, options) => {
        assert.equal(args[args.indexOf("--network") + 1], "copilot-control-plane");
        const separator = args.indexOf("--");
        return spawnSync(args[separator + 1], args.slice(separator + 2), options);
      }
    });
    assert.equal(result.pass, false);
    assert.equal(result.deniedReadableCount, 1);
    assert.match(result.reasons.join("\n"), /forbidden coordinator path/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("telemetry rejects unexpected tools and coordinator paths", () => {
  const run = pilotRuns().find((item) => item.arm === "A2");
  const candidate = temporary("documentation-pilot-unexpected-tool");
  const hidden = resolve(dirname(candidate), "hidden-evaluator");
  const events = syntheticEvents(run, candidate);
  events.splice(events.length - 1, 0, event("tool.execution_start", {
    toolCallId: "unexpected-web",
    toolName: "web_search",
    arguments: {path: hidden}
  }, "2026-08-01T00:00:00.900Z"));
  const result = auditTelemetry(events, {
    run,
    boundary: boundary(candidate),
    evaluateAdherence,
    forbiddenPaths: [hidden]
  });
  assert.equal(result.adherent, false);
  assert.match(result.reasons.join("\n"), /unexpected tool|forbidden coordinator path/u);
});

test("execute authorization requires verified current main and exact resource bindings", () => {
  const root = temporary("documentation-pilot-main-authorization");
  const cli = resolve(root, "copilot.exe");
  try {
    mkdirSync(root);
    writeFileSync(cli, "synthetic cli");
    const options = {
      cli,
      sessionStore: resolve(root, "store.db"),
      artifactRoot: resolve(root, "artifacts"),
      candidateRoot: resolve(root, "candidates"),
      sandboxSha256: "0".repeat(64)
    };
    assert.throws(
      () => createExecutionAuthorization(options, {
        pass: false,
        reasons: ["HEAD is not the current canonical main commit"]
      }),
      /current canonical main/u
    );
    const authorization = createExecutionAuthorization(options, {
      pass: true,
      head: "2".repeat(40),
      canonicalRemoteMain: "2".repeat(40)
    }, new Date(), "fresh-main-execution-nonce");
    assert.equal(authorization.runnerSourceCommit, "2".repeat(40));
    assert.match(authorization.bindingsSha256, /^[a-f0-9]{64}$/u);
    assert.match(authorization.bindings.cliSha256, /^[a-f0-9]{64}$/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
