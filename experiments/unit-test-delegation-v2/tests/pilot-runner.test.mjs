import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { evaluatePilot } from "../scripts/analysis.mjs";
import {
  A1_TOOLS,
  A2_TOOLS,
  aggregateTiming,
  aggregateTools,
  aggregateUsage,
  assertPrivacySafe,
  auditEvents,
  buildCopilotArgs,
  concisePilotSummary,
  conservativeMetric,
  deriveTrace,
  frozenPilotPlan,
  parseCopilotJsonl,
  privacyNormalize
} from "../scripts/pilot-contract.mjs";
import {
  classifyPilotStatus,
  collectStaticPreflight,
  executePilot,
  reservePilotIdentity,
  retainedNotStartedObservation
} from "../scripts/pilot-runner.mjs";

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
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function toolStart(toolCallId, toolName, args, extra = {}) {
  return {
    type: "tool.execution_start",
    timestamp: "2026-08-01T00:00:01.000Z",
    data: { toolCallId, toolName, arguments: args, ...extra.data },
    ...extra,
    data: { toolCallId, toolName, arguments: args, ...extra.data }
  };
}

function syntheticA2(plan) {
  const prompt = "frozen prompt";
  const workerCallId = "worker-call-1";
  const envelope = {
    runId: plan.observationId.toLowerCase(),
    requirementsPath: "TASK.md",
    changedProductionPaths: ["src/feature.js"],
    nearbyTestPaths: ["test/conventions.test.js"],
    targetTestPath: "test/feature.test.js",
    targetSentinel: `// UNIT_TEST_SENTINEL:${plan.observationId.toLowerCase()}\n`,
    framework: {
      runner: "node:test",
      assertions: "node:assert/strict",
      moduleSystem: "commonjs"
    },
    statusHash: "status-hash"
  };
  const terminal = `${envelope.runId} | ${envelope.targetTestPath} | SUCCESS | ${envelope.statusHash}`;
  const events = [
    { type: "user.message", timestamp: "2026-08-01T00:00:00.000Z", data: { content: prompt } },
    { type: "assistant.turn_start", timestamp: "2026-08-01T00:00:00.100Z", data: {} },
    { type: "model.call_start", timestamp: "2026-08-01T00:00:00.200Z", data: { model: "gpt-5.6-sol" } },
    toolStart("edit-production", "edit", { path: "src/feature.js" }),
    toolStart("skill-1", "skill", { skill: "unit-test-authoring" }),
    {
      type: "tool.execution_complete",
      timestamp: "2026-08-01T00:00:01.100Z",
      data: { toolCallId: "skill-1", success: true, result: { content: "loaded" } }
    },
    toolStart(workerCallId, "task", {
      agent_type: "unit-test-author-sonnet-v2",
      prompt: JSON.stringify(envelope)
    }),
    {
      type: "subagent.started",
      timestamp: "2026-08-01T00:00:01.200Z",
      agentId: workerCallId,
      data: { model: "claude-sonnet-4.6" }
    },
    {
      type: "model.call_start",
      timestamp: "2026-08-01T00:00:01.300Z",
      agentId: workerCallId,
      data: { model: "claude-sonnet-4.6", parentToolCallId: workerCallId }
    },
    toolStart("read-1", "read", { path: "TASK.md" }, { agentId: workerCallId, data: { parentToolCallId: workerCallId } }),
    toolStart("read-2", "read", { path: "src/feature.js" }, { agentId: workerCallId, data: { parentToolCallId: workerCallId } }),
    toolStart("read-3", "read", { path: "test/conventions.test.js" }, { agentId: workerCallId, data: { parentToolCallId: workerCallId } }),
    toolStart("worker-edit", "edit", { path: "test/feature.test.js" }, { agentId: workerCallId, data: { parentToolCallId: workerCallId } }),
    ...["read-1", "read-2", "read-3", "worker-edit"].map((toolCallId) => ({
      type: "tool.execution_complete",
      timestamp: "2026-08-01T00:00:02.000Z",
      agentId: workerCallId,
      data: {
        toolCallId,
        parentToolCallId: workerCallId,
        success: true,
        result: { content: "ok" }
      }
    })),
    {
      type: "subagent.completed",
      timestamp: "2026-08-01T00:00:02.200Z",
      agentId: workerCallId,
      data: { model: "claude-sonnet-4.6", content: terminal }
    },
    {
      type: "tool.execution_complete",
      timestamp: "2026-08-01T00:00:02.300Z",
      data: {
        toolCallId: workerCallId,
        success: true,
        result: { content: terminal }
      }
    },
    { type: "assistant.turn_end", timestamp: "2026-08-01T00:00:03.000Z", data: {} },
    { type: "result", timestamp: "2026-08-01T00:00:03.100Z", sessionId: plan.sessionId, exitCode: 0, data: {} }
  ];
  const rows = [
    usageRow({ session_id: plan.sessionId }),
    usageRow({
      id: 2,
      session_id: plan.sessionId,
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
  return { prompt, workerCallId, envelope, events, rows };
}

function syntheticObservation(plan) {
  const treatment = plan.arm === "A2";
  return {
    schemaVersion: 2,
    observationId: plan.observationId,
    sessionId: plan.sessionId,
    worktreeId: plan.worktreeId,
    candidateCommitSha: "a".repeat(40),
    blockId: plan.blockId,
    taskId: plan.taskId,
    repetition: plan.repetition,
    arm: plan.arm,
    startDisposition: "started",
    status: "complete",
    usage: {
      parent: { credits: 2, nanoAiu: 2_000_000_000, inputTokens: 200, outputTokens: 20, completions: 2 },
      worker: treatment
        ? { credits: 0.25, nanoAiu: 250_000_000, inputTokens: 40, outputTokens: 10, completions: 1 }
        : { credits: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, completions: 0 },
      combinedCredits: treatment ? 2.25 : 2,
      combinedNanoAiu: treatment ? 2_250_000_000 : 2_000_000_000,
      totalModelTokens: treatment ? 270 : 220
    },
    parentContext: { cumulativeInputTokens: 200, peakInputTokens: 100 },
    timing: { parentActiveMs: 200, workerActiveMs: treatment ? 50 : 0, parentWaitMs: treatment ? 1000 : 0, wallMs: 3000 },
    tools: { parentCalls: treatment ? 3 : 4, workerCalls: treatment ? 5 : 0, resultBytes: 100 },
    evaluation: {
      feature: { score: 1 },
      tests: {
        normalizedHash: plan.observationId,
        duplicate: null,
        trivial: false,
        visiblePass: true,
        goldPass: true,
        branchCoverage: 1,
        components: {
          compilePass: 1,
          meaningfulAssertions: 1,
          mutantKill: 1,
          branchCoverage: 1,
          statementCoverage: 1,
          noFalsePositive: 1,
          isolation: 1,
          nontrivial: 1
        }
      },
      adherence: { adherent: true, reasons: [] }
    },
    diagnostics: []
  };
}

test("pilot order and identities are frozen in committed randomized order", () => {
  const plan = frozenPilotPlan();
  assert.deepEqual(plan.map((entry) => entry.observationId), [
    "pilot-P12-r01-A1",
    "pilot-P12-r01-A2",
    "pilot-P13-r01-A2",
    "pilot-P13-r01-A1",
    "pilot-P11-r01-A1",
    "pilot-P11-r01-A2"
  ]);
  assert.equal(new Set(plan.map((entry) => entry.sessionId)).size, 6);
  assert.equal(new Set(plan.map((entry) => entry.worktreeId)).size, 6);
});

test("runner requires execute and exposes exact arm tool surfaces", () => {
  const [a1, a2] = frozenPilotPlan();
  const argsA1 = buildCopilotArgs({ prompt: "x", plan: a1, candidateRoot: "candidate" });
  const argsA2 = buildCopilotArgs({ prompt: "x", plan: a2, candidateRoot: "candidate" });
  assert(argsA1.includes(`--available-tools=${A1_TOOLS.join(",")}`));
  assert(argsA2.includes(`--available-tools=${A2_TOOLS.join(",")}`));
  assert(!argsA1.includes("--execute"));
  assert.throws(() => executePilot({
    cli: "copilot",
    sessionStore: "missing",
    privateRoot: "missing",
    execute: false
  }), /explicit --execute/u);
});

test("preflight validates hashes and identities without creating or consuming roots", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-preflight-"));
  const privateRoot = path.join(parent, "absent-private-root");
  const sessionStore = path.join(parent, "session-store.db");
  const python = process.platform === "win32" ? "python" : "python3";
  const created = spawnSync(python, [
    "-c",
    "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE sessions (id TEXT)'); db.execute('CREATE TABLE assistant_usage_events (session_id TEXT)'); db.commit()",
    sessionStore
  ], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const help = [
    "-p, --prompt",
    "--session-id",
    "--model",
    "--output-format",
    "-C <directory>",
    "--allow-all-tools",
    "--available-tools",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export"
  ].join("\n");
  try {
    const preflight = collectStaticPreflight({
      cli: "copilot",
      sessionStore,
      privateRoot,
      nodeVersion: "22.14.0",
      gitEvidence: { status: "", head: "a".repeat(40) },
      cliEvidence: {
        version: "GitHub Copilot CLI 1.0.77.",
        help,
        configuredMcpServers: [],
        usageStore: { ok: true, columns: [] }
      }
    });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.rootsCreated, false);
    assert.equal(preflight.observationsStarted, 0);
    assert.deepEqual(preflight.consumedIds, []);
    assert.equal(fs.existsSync(privateRoot), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("identity reservation is write-once and prevents duplicate starts", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-lock-"));
  try {
    const plan = frozenPilotPlan()[0];
    reservePilotIdentity(parent, plan);
    assert.throws(() => reservePilotIdentity(parent, plan), /EEXIST/u);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("synthetic execution retains post-start failure and generates reports without AI", () => {
  const privateRoot = path.join(os.tmpdir(), `utd2-synthetic-run-${process.pid}-${Date.now()}`);
  const help = [
    "-p, --prompt",
    "--session-id",
    "--model",
    "--output-format",
    "-C <directory>",
    "--allow-all-tools",
    "--available-tools",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export"
  ].join("\n");
  try {
    const result = executePilot({
      cli: "synthetic-copilot",
      sessionStore: "synthetic-session-store.db",
      privateRoot,
      execute: true,
      nodeVersion: "22.14.0",
      gitEvidence: { status: "", head: "a".repeat(40) },
      cliEvidence: {
        version: "GitHub Copilot CLI 1.0.77.",
        help,
        configuredMcpServers: [],
        usageStore: { ok: true, columns: [] },
        consumedIds: []
      },
      spawn: () => {
        throw new Error("synthetic post-start failure");
      },
      usageExporter: () => []
    });
    assert.equal(result.gate.decision, "NO-GO");
    assert.equal(result.summary.observationCount, 6);
    assert.equal(result.summary.startedCount, 6);
    assert.match(result.evidenceRootHash, /^[a-f0-9]{64}$/u);
    assert(fs.existsSync(path.join(privateRoot, "sanitized", "pilot-summary.json")));
    assert(fs.existsSync(path.join(privateRoot, "evidence-manifest.json")));
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("A2 events prove actor, model, tool, and parent no-review boundaries", () => {
  const plan = frozenPilotPlan()[1];
  const { prompt, workerCallId, envelope, events, rows } = syntheticA2(plan);
  const trace = deriveTrace(events);
  assert.equal(trace.workerCallId, workerCallId);
  assert.deepEqual(trace.events.filter((entry) => entry.actor === "worker").map((entry) => entry.kind),
    ["view", "view", "view", "edit", "terminal"]);
  assert.deepEqual(auditEvents({
    events,
    usageRows: rows,
    prompt,
    plan,
    workspace: process.cwd(),
    envelope
  }), { adherent: true, reasons: [], workerCallId });
  const violated = structuredClone(events);
  violated.splice(-2, 0, toolStart("parent-review", "view", { path: "test/feature.test.js" }));
  const audit = auditEvents({
    events: violated,
    usageRows: rows,
    prompt,
    plan,
    workspace: process.cwd(),
    envelope
  });
  assert.equal(audit.adherent, false);
  assert(audit.reasons.includes("parent accessed the delegated target test"));
});

test("A1 parsing rejects delegation and worker usage", () => {
  const plan = frozenPilotPlan()[0];
  const prompt = "control";
  const events = [
    { type: "user.message", timestamp: "2026-08-01T00:00:00.000Z", data: { content: prompt } },
    { type: "model.call_start", timestamp: "2026-08-01T00:00:00.100Z", data: { model: "gpt-5.6-sol" } },
    toolStart("edit-1", "edit", { path: "src/feature.js" }),
    toolStart("edit-2", "edit", { path: "test/feature.test.js" }),
    { type: "result", timestamp: "2026-08-01T00:00:01.000Z", sessionId: plan.sessionId, exitCode: 0, data: {} }
  ];
  const rows = [usageRow({ session_id: plan.sessionId })];
  const audit = auditEvents({
    events,
    usageRows: rows,
    prompt,
    plan,
    workspace: process.cwd(),
    envelope: {}
  });
  assert.equal(audit.adherent, true);
  const delegated = [...events, toolStart("task-1", "task", { agent_type: "unit-test-author-sonnet-v2" })];
  assert.equal(auditEvents({
    events: delegated,
    usageRows: rows,
    prompt,
    plan,
    workspace: process.cwd(),
    envelope: {}
  }).adherent, false);
  assert.deepEqual(parseCopilotJsonl(events.map((entry) => JSON.stringify(entry)).join("\n")), events);
});

test("usage aggregation settles parent, worker, combined, context, timing, and tools", () => {
  const plan = frozenPilotPlan()[1];
  const { events, rows, workerCallId } = syntheticA2(plan);
  const settled = aggregateUsage(rows, { arm: "A2", workerCallId });
  assert.deepEqual(settled.usage, {
    parent: { credits: 1, nanoAiu: 1_000_000_000, inputTokens: 100, outputTokens: 20, completions: 1 },
    worker: { credits: 0.25, nanoAiu: 250_000_000, inputTokens: 40, outputTokens: 10, completions: 1 },
    combinedCredits: 1.25,
    combinedNanoAiu: 1_250_000_000,
    totalModelTokens: 170
  });
  assert.deepEqual(settled.parentContext, { cumulativeInputTokens: 100, peakInputTokens: 100 });
  assert.deepEqual(aggregateTiming(events, settled.actorRows), {
    parentActiveMs: 100,
    workerActiveMs: 50,
    parentWaitMs: 1000,
    wallMs: 2900
  });
  const tools = aggregateTools(events, workerCallId);
  assert.equal(tools.parentCalls, 3);
  assert.equal(tools.workerCalls, 4);
});

test("started failure retention and conservative imputations fail closed", () => {
  assert.equal(classifyPilotStatus({
    startDisposition: "started",
    execution: { error: { code: "ETIMEDOUT" }, status: null },
    result: null,
    auditReasons: [],
    evaluationError: null
  }), "timeout");
  const failed = syntheticObservation(frozenPilotPlan()[0]);
  failed.usage.combinedCredits = null;
  failed.usage.parent.credits = null;
  failed.timing.wallMs = null;
  assert.equal(conservativeMetric(failed, "combinedCredits"), 90);
  assert.equal(conservativeMetric(failed, "parentCredits"), 90);
  assert.equal(conservativeMetric(failed, "wallMs"), 360000);
  const retained = retainedNotStartedObservation(
    frozenPilotPlan()[2],
    "b".repeat(40),
    "integrity stop"
  );
  assert.equal(retained.startDisposition, "not-started");
  assert.equal(retained.status, "pre-start-failure");
});

test("frozen pilot gate and report generation are deterministic", () => {
  const observations = frozenPilotPlan().map(syntheticObservation);
  const gate = evaluatePilot(observations);
  assert.equal(gate.decision, "GO");
  const summary = concisePilotSummary(observations, gate);
  assert.equal(summary.pairs.length, 3);
  assert.equal(summary.startedCount, 6);
  const failed = structuredClone(observations);
  failed[1].status = "delegation-failure";
  assert.equal(evaluatePilot(failed).decision, "GO");
  failed[5].status = "delegation-failure";
  assert.equal(evaluatePilot(failed).decision, "NO-GO");
});

test("privacy normalization redacts roots and secret-like diagnostics", () => {
  const normalized = privacyNormalize({
    path: "C:\\Users\\casey\\private\\raw.json",
    diagnostic: "token=super-secret"
  }, [["C:\\Users\\casey\\private", "<private-root>"]]);
  assert.deepEqual(normalized, {
    path: "<private-root>\\raw.json",
    diagnostic: "token=<redacted>"
  });
  assert.doesNotThrow(() => assertPrivacySafe(normalized));
  assert.throws(() => assertPrivacySafe({ path: "C:\\Users\\casey\\raw.json" }), /home path leaked/u);
});
