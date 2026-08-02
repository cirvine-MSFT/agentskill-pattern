import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  existsSync,
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
  aggregateTiming,
  aggregateUsage,
  assertPrivacySafe,
  auditRuntime,
  buildCopilotArgs,
  buildWorkerHandoff,
  concisePilotSummary,
  evaluatePilotGate,
  frozenPilotPlan,
  integrityCriticalMissingActors,
  normalizedPathHash,
  privacyNormalize,
  sha256,
  startedFrom,
  workerActivityStarted
} from "../scripts/pilot-contract.mjs";
import {
  collectStaticPreflight,
  dryRun,
  identityDisposition,
  initializeCandidateRepository,
  markStarted,
  reserveSlot,
  rootsOverlap,
  schedulePilot,
  settledUsage,
  terminalDisposition,
  verifyAuthorizationPayload
} from "../scripts/pilot-runner.mjs";
import {experimentRoot, readJson, stableStringify} from "../scripts/lib.mjs";

function usageRow(overrides = {}) {
  return {
    id: 1,
    session_id: "session",
    turn_index: 0,
    agent_id: null,
    parent_tool_call_id: null,
    model: "gpt-5.6-sol",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_nano_aiu: 1_000_000_000,
    request_multiplier: 1,
    duration_ms: 100,
    time_to_first_token_ms: 10,
    inter_token_latency_ms: 1,
    initiator: "user",
    api_endpoint: "test",
    reasoning_effort: "medium",
    finish_reason: "stop",
    content_filter_triggered: 0,
    token_details_json: "{}",
    created_at: "2026-08-02T00:00:00.000Z",
    ...overrides
  };
}

function toolStart(toolCallId, toolName, args, extra = {}) {
  return {
    type: "tool.execution_start",
    timestamp: "2026-08-02T00:00:01.000Z",
    agentId: extra.agentId,
    data: {
      toolCallId,
      toolName,
      arguments: args,
      parentToolCallId: extra.parentToolCallId
    }
  };
}

function toolComplete(toolCallId, extra = {}) {
  return {
    type: "tool.execution_complete",
    timestamp: "2026-08-02T00:00:02.000Z",
    agentId: extra.agentId,
    data: {
      toolCallId,
      parentToolCallId: extra.parentToolCallId,
      success: true,
      result: {content: extra.content ?? "ok"}
    }
  };
}

function syntheticA2(run, candidateRoot) {
  const workerCallId = "call_sonnet_worker";
  const policy = {
    docTarget: resolve(candidateRoot, "docs", "guide.md"),
    sourcePath: resolve(candidateRoot, "src", "index.mjs"),
    allowedWorkerReads: [
      resolve(candidateRoot, "TASK.md"),
      resolve(candidateRoot, "docs", "CONVENTIONS.md"),
      resolve(candidateRoot, "src", "index.mjs"),
      resolve(candidateRoot, "docs", "guide.md")
    ],
    allowedWorkerWrites: [resolve(candidateRoot, "docs", "guide.md")],
    initialDocText: ""
  };
  const worker = {agentId: workerCallId, parentToolCallId: workerCallId};
  const terminal = JSON.stringify({
    status: "success",
    target: "docs/guide.md",
    replaced: true
  });
  const events = [
    {type: "assistant.turn_start", timestamp: "2026-08-02T00:00:00.000Z", data: {}},
    {
      type: "model.call_start",
      timestamp: "2026-08-02T00:00:00.100Z",
      data: {model: "gpt-5.6-sol"}
    },
    toolStart("edit-production", "edit", {path: "src/index.mjs"}),
    toolComplete("edit-production"),
    toolStart("skill-1", "skill", {skill: "feature-documentation-sonnet-v2"}),
    toolComplete("skill-1"),
    toolStart(workerCallId, "task", {
      agent_type: "feature-documentation-sonnet-v2",
      prompt: buildWorkerHandoff(policy, candidateRoot)
    }),
    {
      type: "subagent.started",
      timestamp: "2026-08-02T00:00:01.200Z",
      agentId: workerCallId,
      data: {model: "claude-sonnet-4.6"}
    },
    {
      type: "model.call_start",
      timestamp: "2026-08-02T00:00:01.300Z",
      agentId: workerCallId,
      data: {model: "claude-sonnet-4.6", parentToolCallId: workerCallId}
    },
    toolStart("read-1", "read", {path: "TASK.md"}, worker),
    toolComplete("read-1", worker),
    toolStart("read-2", "read", {path: "docs/CONVENTIONS.md"}, worker),
    toolComplete("read-2", worker),
    toolStart("read-3", "read", {path: "src/index.mjs"}, worker),
    toolComplete("read-3", worker),
    toolStart("read-4", "read", {path: "docs/guide.md"}, worker),
    toolComplete("read-4", worker),
    toolStart("worker-edit", "edit", {
      path: "docs/guide.md",
      old_str: "",
      new_str: "# Guide\n"
    }, worker),
    toolComplete("worker-edit", worker),
    {
      type: "subagent.completed",
      timestamp: "2026-08-02T00:00:03.000Z",
      agentId: workerCallId,
      data: {model: "claude-sonnet-4.6"}
    },
    toolComplete(workerCallId, {content: terminal}),
    {type: "assistant.turn_end", timestamp: "2026-08-02T00:00:04.000Z", data: {}},
    {
      type: "result",
      timestamp: "2026-08-02T00:00:04.100Z",
      sessionId: run.parentSessionId,
      exitCode: 0,
      data: {}
    }
  ];
  const rows = [
    usageRow({session_id: run.parentSessionId}),
    usageRow({
      id: 2,
      session_id: run.parentSessionId,
      agent_id: workerCallId,
      parent_tool_call_id: workerCallId,
      model: "claude-sonnet-4.6",
      input_tokens: 40,
      output_tokens: 10,
      total_nano_aiu: 250_000_000,
      duration_ms: 50,
      initiator: "sub-agent",
      reasoning_effort: null
    })
  ];
  return {events, rows, policy, workerCallId};
}

function passingObservation(run) {
  return {
    ...run,
    started: true,
    completed: true,
    status: "complete",
    adherent: true,
    usage: {
      combinedAiCredits: run.arm === "A2" ? 1.25 : 1,
      parentAiCredits: 1,
      workerAiCredits: run.arm === "A2" ? 0.25 : 0,
      parentCumulativeInputTokens: 100,
      parentPeakInputTokens: 100,
      totalTokens: run.arm === "A2" ? 170 : 120
    },
    timing: {wallMs: 1000, workerMs: run.arm === "A2" ? 200 : 0},
    evaluation: {
      pass: true,
      feature: {score: 1},
      documentation: {correctness: 1, coverage: 1, executability: 1, format: 1}
    },
    evaluationReproduced: true,
    externalEvaluatorAiCredits: 0,
    usagePartitioned: true,
    integrityPass: true,
    disposedExactlyOnce: true,
    evidenceSha256: "a".repeat(64)
  };
}

test("frozen pilot exposes all 12 unique identities in exact order", () => {
  const plan = frozenPilotPlan();
  assert.equal(plan.length, 12);
  assert.deepEqual(plan.map((run) => run.observationId), [
    "V2P-01-A2-15f62ce532",
    "V2P-01-A1-331ac11add",
    "V2P-02-A1-7a60e558ae",
    "V2P-02-A2-e4517c4b10",
    "V2P-03-A1-9e3af9bd37",
    "V2P-03-A2-37a1edfd82",
    "V2P-04-A2-7132a374f4",
    "V2P-04-A1-12009132e1",
    "V2P-05-A2-7a28a0be04",
    "V2P-05-A1-06a9fd759e",
    "V2P-06-A1-38e08fb291",
    "V2P-06-A2-5506441ef0"
  ]);
  for (const field of ["observationId", "parentSessionId", "worktreeId"]) {
    assert.equal(new Set(plan.map((run) => run[field])).size, 12);
  }
  assert.equal(new Set(plan.filter((run) => run.arm === "A2")
    .map((run) => run.workerSessionId)).size, 6);
});

test("exact CLI arguments preserve model, tools, isolation, and no retry", () => {
  const [a2, a1] = frozenPilotPlan();
  const root = resolve(tmpdir(), "v2-candidate");
  const policy = {
    sourcePath: resolve(root, "src", "index.mjs"),
    docTarget: resolve(root, "docs", "guide.md")
  };
  const argsA2 = buildCopilotArgs(a2, root, ["playwright", "azure"], policy);
  const argsA1 = buildCopilotArgs(a1, root);
  assert.deepEqual(argsA2.slice(0, 8), [
    "-p", argsA2[1],
    "--session-id", a2.parentSessionId,
    "--model", "gpt-5.6-sol",
    "--output-format", "json"
  ]);
  assert(argsA2.includes("--available-tools=read,edit,bash,skill,task"));
  assert(argsA1.includes("--available-tools=read,edit,bash"));
  assert(argsA2.includes("--disable-builtin-mcps"));
  assert(argsA2.includes("--no-custom-instructions"));
  assert(!argsA2.includes("--resume"));
  assert(!argsA2.includes("--continue"));
  assert.deepEqual(argsA2.slice(-4), ["--context", "default", "--effort", "medium"]);
});

test("A2 audit proves Skill, named Sonnet task, model, bounded tools, and terminal", () => {
  const root = resolve(tmpdir(), "v2-audit-candidate");
  const run = frozenPilotPlan().find((item) => item.arm === "A2");
  const {events, rows, policy, workerCallId} = syntheticA2(run, root);
  const audit = auditRuntime({events, usageRows: rows, run, candidateRoot: root, policy});
  assert.equal(audit.adherent, true, audit.reasons.join("; "));
  assert.equal(audit.workerControlPlaneIdHash, sha256(workerCallId));

  const bypass = events.filter((event) =>
    !(event.type === "tool.execution_start" && event.data?.toolName === "skill")
    && !(event.type === "tool.execution_complete" && event.data?.toolCallId === "skill-1"));
  assert.equal(auditRuntime({
    events: bypass,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  }).adherent, false);

  const postWorkerRead = structuredClone(events);
  postWorkerRead.splice(-2, 0, toolStart("parent-review", "read", {path: "docs/guide.md"}));
  const violated = auditRuntime({
    events: postWorkerRead,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  });
  assert.equal(violated.adherent, false);
  assert(violated.reasons.some((reason) => /after worker editing/iu.test(reason)));

  const partial = structuredClone(events);
  partial.find((event) => event.data?.toolCallId === "worker-edit")
    .data.arguments.old_str = "one line";
  assert.equal(auditRuntime({
    events: partial,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  }).adherent, false);

  const badHandoff = structuredClone(events);
  badHandoff.find((event) => event.data?.toolCallId === workerCallId
    && event.type === "tool.execution_start").data.arguments.prompt = "direct bypass";
  assert.equal(auditRuntime({
    events: badHandoff,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  }).adherent, false);

  const unfinishedSkill = structuredClone(events);
  const taskIndex = unfinishedSkill.findIndex((event) =>
    event.type === "tool.execution_start" && event.data?.toolCallId === workerCallId);
  const [task] = unfinishedSkill.splice(taskIndex, 1);
  const skillCompleteIndex = unfinishedSkill.findIndex((event) =>
    event.type === "tool.execution_complete" && event.data?.toolCallId === "skill-1");
  unfinishedSkill.splice(skillCompleteIndex, 0, task);
  assert.equal(auditRuntime({
    events: unfinishedSkill,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  }).adherent, false);

  const extraSkill = structuredClone(events);
  extraSkill.splice(2, 0,
    toolStart("skill-extra", "skill", {skill: "unrelated-skill"}),
    toolComplete("skill-extra"));
  assert.equal(auditRuntime({
    events: extraSkill,
    usageRows: rows,
    run,
    candidateRoot: root,
    policy
  }).adherent, false);
});

test("usage settlement splits parent, worker, combined credits, and context", () => {
  const run = frozenPilotPlan().find((item) => item.arm === "A2");
  const {rows, workerCallId} = syntheticA2(run, resolve(tmpdir(), "v2-usage"));
  const result = aggregateUsage(rows, {arm: "A2", workerCallId});
  assert.deepEqual(result.usage, {
    combinedAiCredits: 1.25,
    parentAiCredits: 1,
    workerAiCredits: 0.25,
    parentCumulativeInputTokens: 100,
    parentPeakInputTokens: 100,
    totalTokens: 170
  });
  assert.deepEqual(result.unattributedRows, []);
});

test("pilot gate math requires five valid pairs, routing, usage, privacy, and dispositions", () => {
  const observations = frozenPilotPlan().map(passingObservation);
  const gate = evaluatePilotGate(observations);
  assert.equal(gate.decision, "GO");
  assert.equal(gate.validPairs, 6);
  const failed = structuredClone(observations);
  failed.find((item) => item.arm === "A2").adherent = false;
  assert.equal(evaluatePilotGate(failed).decision, "NO-GO");
  const invalidControls = structuredClone(observations);
  invalidControls.filter((item) => item.arm === "A1").slice(0, 2)
    .forEach((item) => {
      item.adherent = false;
    });
  assert.equal(evaluatePilotGate(invalidControls).validPairs, 4);
  assert.equal(evaluatePilotGate(invalidControls).decision, "NO-GO");
  const fatalIntegrity = structuredClone(observations);
  fatalIntegrity[10].integrityPass = false;
  assert.equal(evaluatePilotGate(fatalIntegrity).decision, "NO-GO");
  assert.equal(evaluatePilotGate(observations, {privacyPass: false}).decision, "NO-GO");
  const summary = concisePilotSummary(observations, gate);
  assert.equal(summary.observationCount, 12);
  assert.equal(summary.observations[0].workerAiCredits, 0.25);
});

test("scheduler retains ordinary failures and stops only after integrity becomes impossible", () => {
  const ordinary = schedulePilot({
    runOne: (run) => ({
      ...passingObservation(run),
      status: "process-failure",
      completed: false,
      integrityPass: true,
      identityConsumed: true
    }),
    retainOne: () => assert.fail("ordinary failure must not truncate the schedule")
  });
  assert.equal(ordinary.observations.length, 12);
  assert.equal(ordinary.stopReason, null);

  let calls = 0;
  const integrity = schedulePilot({
    runOne: (run) => ({
      ...passingObservation(run),
      integrityPass: ++calls < 3,
      diagnostics: ["synthetic integrity failure"],
      identityConsumed: true
    }),
    retainOne: (run, reason) => ({
      ...passingObservation(run),
      started: false,
      completed: false,
      integrityPass: false,
      identityConsumed: false,
      diagnostics: [reason]
    })
  });
  assert.equal(calls, 3);
  assert.equal(integrity.observations.length, 12);
  assert.equal(integrity.observations.filter((item) => item.started).length, 3);
  assert.match(integrity.stopReason, /synthetic integrity failure/iu);

  let preStartCalls = 0;
  const preStart = schedulePilot({
    runOne: () => {
      preStartCalls += 1;
      throw new Error("proven before model request");
    },
    retainOne: (run, reason) => ({
      ...passingObservation(run),
      started: false,
      completed: false,
      integrityPass: false,
      identityConsumed: false,
      diagnostics: [reason]
    })
  });
  assert.equal(preStartCalls, 12);
  assert.equal(preStart.stopReason, null);
  assert(preStart.observations.every((item) => item.started === false));
});

test("lifecycle records are write-once and candidates are independent clean Git roots", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "v2-lifecycle-git-"));
  try {
    const run = frozenPilotPlan()[0];
    const lock = reserveSlot(resolve(parent, "locks"), run);
    assert.throws(() => reserveSlot(resolve(parent, "locks"), run));
    markStarted(lock);
    assert.throws(() => markStarted(lock), /more than once/iu);
    terminalDisposition(lock, {
      schemaVersion: 2,
      observationId: run.observationId,
      state: "terminal",
      started: true,
      consumed: true,
      retry: false,
      status: "complete",
      evidenceSha256: "a".repeat(64)
    });
    assert.throws(() => terminalDisposition(lock, {}), /terminal disposition/iu);

    const candidate = resolve(parent, "candidate");
    mkdirSync(candidate);
    writeFileSync(resolve(candidate, "TASK.md"), "synthetic\n");
    initializeCandidateRepository(candidate);
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf8",
      windowsHide: true
    });
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: candidate,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(resolve(top.stdout.trim()), candidate);
    assert.equal(status.stdout, "");
    assert(existsSync(resolve(candidate, ".git")));
  } finally {
    rmSync(parent, {recursive: true, force: true});
  }
});

test("changing usage snapshots fail settlement instead of becoming final evidence", () => {
  let id = 0;
  let failure;
  try {
    settledUsage("synthetic", "session", () => [usageRow({id: ++id})]);
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /did not settle/iu);
  assert.equal(failure.latestRows.length, 1);
  assert.equal(startedFrom([], failure.latestRows), true);
});

test("missing required worker usage fails closed and result usage supplies wall timing", () => {
  const parentOnly = aggregateUsage([usageRow()], {
    arm: "A2",
    workerCallId: "missing-worker"
  });
  assert.equal(parentOnly.usage.workerAiCredits, null);
  assert.deepEqual(parentOnly.missingRequiredActors, ["worker"]);
  assert.deepEqual(integrityCriticalMissingActors(["worker"], false), []);
  assert.deepEqual(integrityCriticalMissingActors(["worker"], true), ["worker"]);
  assert.deepEqual(integrityCriticalMissingActors(["parent", "worker"], false), ["parent"]);
  assert.equal(workerActivityStarted([
    toolStart("task-one", "task", {agent_type: "other"}),
    toolStart("task-two", "task", {agent_type: "feature-documentation-sonnet-v2"}),
    {type: "subagent.started", agentId: "task-two", data: {}}
  ]), true);
  assert.deepEqual(aggregateTiming([
    {type: "result", usage: {sessionDurationMs: 321}}
  ], parentOnly), {wallMs: 321, workerMs: null});
});

test("expired authorization remains reproducible but cannot execute", () => {
  const authorization = readJson(resolve(experimentRoot, "design", "authorization.json"));
  authorization.issuedAt = "2020-01-01T00:00:00Z";
  authorization.expiresAt = "2020-01-02T00:00:00Z";
  delete authorization.payloadSha256;
  authorization.payloadSha256 = sha256(stableStringify(authorization));
  assert.doesNotThrow(() => verifyAuthorizationPayload(authorization));
  assert.throws(
    () => verifyAuthorizationPayload(authorization, {enforceExpiry: true}),
    /expired/iu
  );
});

test("session registration without model usage is consumed but remains pre-start", () => {
  assert.deepEqual(identityDisposition(false, false), {
    started: false,
    consumed: false,
    preStartStatus: "pre-start-failure"
  });
  assert.deepEqual(identityDisposition(false, true), {
    started: false,
    consumed: true,
    preStartStatus: "identity-consumed-before-start"
  });
  assert.deepEqual(identityDisposition(true, false), {
    started: true,
    consumed: true,
    preStartStatus: "pre-start-failure"
  });
});

test("static preflight creates no roots and rejects overlap", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "v2-preflight-"));
  const artifactRoot = resolve(parent, "artifacts");
  const candidateRoot = resolve(parent, "candidates");
  const store = resolve(parent, "session-store.db");
  writeFileSync(store, "");
  try {
    const authorization = structuredClone(
      readJson(resolve(experimentRoot, "design", "authorization.json"))
    );
    authorization.paths.cliSha256 = normalizedPathHash(process.execPath);
    authorization.paths.sessionStoreSha256 = normalizedPathHash(store);
    authorization.paths.artifactRootSha256 = normalizedPathHash(artifactRoot);
    authorization.paths.candidateRootSha256 = normalizedPathHash(candidateRoot);
    authorization.cli.binarySha256 = sha256(readFileSync(process.execPath));
    const payload = {...authorization};
    delete payload.payloadSha256;
    authorization.payloadSha256 = sha256(stableStringify(payload));
    const result = collectStaticPreflight({
      cli: process.execPath,
      sessionStore: store,
      artifactRoot,
      candidateRoot,
      authorizationOverride: authorization,
      gitEvidence: {
        status: "",
        head: "a".repeat(40),
        originMain: "a".repeat(40),
        preregistrationAncestor: true
      },
      cliEvidence: {
        version: "GitHub Copilot CLI 1.0.77.",
        help: [
          "-p, --prompt", "--session-id", "--model", "--output-format",
          "-C <directory>", "--allow-all-tools", "--available-tools",
          "--disable-builtin-mcps", "--disable-mcp-server", "--disallow-temp-dir",
          "--no-custom-instructions", "--no-ask-user", "--no-remote-export",
          "--no-auto-update", "--context", "--effort"
        ].join("\n"),
        configuredMcpServers: []
      },
      usageStoreEvidence: {
        ok: true,
        schemaSha256: authorization.sessionStore.usageSchemaSha256
      },
      consumedIdsEvidence: [],
      skipIndexVerification: true
    });
    assert.equal(result.rootsCreated, false);
    assert.equal(existsSync(artifactRoot), false);
    assert.equal(existsSync(candidateRoot), false);
    assert.equal(rootsOverlap(artifactRoot, resolve(artifactRoot, "nested")), true);
  } finally {
    rmSync(parent, {recursive: true, force: true});
  }
});

test("privacy normalization and concise evidence reject machine paths and secrets", () => {
  const homeDirectory = `Us${"ers"}`;
  const privatePath = ["C:", homeDirectory, "casey", "private", "raw.json"].join("\\");
  const privateRoot = ["C:", homeDirectory, "casey", "private"].join("\\");
  const homePath = ["C:", homeDirectory, "casey", "raw.json"].join("\\");
  const normalized = privacyNormalize({
    path: privatePath,
    diagnostic: "token=super-secret"
  }, [[privateRoot, "<private-root>"]]);
  assert.deepEqual(normalized, {
    path: "<private-root>\\raw.json",
    diagnostic: "token=<redacted>"
  });
  assert.doesNotThrow(() => assertPrivacySafe(normalized));
  assert.throws(() => assertPrivacySafe({path: homePath}),
    /home path leaked/iu);
});

test("Windows npm dry-run integration exposes the exact prospective execute command", () => {
  const command = process.platform === "win32" ? process.env.ComSpec : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm --silent run runner:dry"]
    : ["--silent", "run", "runner:dry"];
  const result = spawnSync(command, args, {
    cwd: experimentRoot,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.observationsStarted, 0);
  assert.equal(output.canExecuteExcludedPilot, true);
  assert.equal(output.canExecuteMain, false);
  assert.match(output.exactWindowsNpmInvocation,
    /git fetch origin main;.*npm run runner:execute -- --cli \$cli --session-store \$store/iu);
});
