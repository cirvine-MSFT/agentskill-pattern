import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {isAbsolute, relative, resolve, sep} from "node:path";
import {evaluateAdherence} from "./evaluate-adherence.mjs";
import {experimentRoot, readJson, stableStringify} from "./lib.mjs";

export const CLI_VERSION = "1.0.77";
export const NODE_VERSION = "22.14.0";
export const PARENT_MODEL = "gpt-5.6-sol";
export const WORKER_MODEL = "claude-sonnet-4.6";
export const PARENT_EFFORT = "medium";
export const A1_TOOLS = Object.freeze(["read", "edit", "bash"]);
export const A2_TOOLS = Object.freeze(["read", "edit", "bash", "skill", "task"]);

const SKILL_NAME = "feature-documentation-sonnet-v2";
const AGENT_NAME = "feature-documentation-sonnet-v2";
const REQUIRED_HELP = [
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
  "--no-remote-export",
  "--no-auto-update",
  "--context",
  "--effort"
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedPathHash(value) {
  return sha256(resolve(value).toLowerCase());
}

export function frozenPilotPlan() {
  const schedule = readJson(resolve(experimentRoot, "design", "schedule.json"));
  let globalOrder = 0;
  return schedule.pilot.flatMap((block) => block.runs.map((run) => ({
    ...run,
    globalOrder: ++globalOrder,
    blockId: block.blockId,
    fixtureId: block.fixtureId,
    variantId: block.variantId
  })));
}

export function inspectCliSurface({version, help, configuredMcpServers}) {
  const versionLine = String(version ?? "").split(/\r?\n/u)
    .find((line) => line.trim())?.trim() ?? null;
  const missingHelp = REQUIRED_HELP.filter((flag) => !String(help ?? "").includes(flag));
  const reasons = [];
  if (versionLine !== `GitHub Copilot CLI ${CLI_VERSION}.`) {
    reasons.push(`requires exact GitHub Copilot CLI ${CLI_VERSION}`);
  }
  if (missingHelp.length) reasons.push(`CLI help is missing: ${missingHelp.join(", ")}`);
  if (!Array.isArray(configuredMcpServers)) reasons.push("configured MCP list is unavailable");
  return {
    ok: reasons.length === 0,
    versionLine,
    missingHelp,
    configuredMcpServers: Array.isArray(configuredMcpServers)
      ? [...configuredMcpServers].sort()
      : [],
    reasons
  };
}

export function buildCopilotArgs(run, candidateRoot, disabledMcpServers = [], policy = null) {
  const prompts = readJson(resolve(experimentRoot, "design", "prompts.json"));
  assert(run.arm !== "A2" || policy, "A2 requires the frozen candidate policy");
  const prompt = run.arm === "A2"
    ? `${prompts.sharedEnvelope}\n\n${prompts.A2}\n\nExact worker handoff:\n`
      + buildWorkerHandoff(policy, candidateRoot)
    : `${prompts.sharedEnvelope}\n\n${prompts.A1}`;
  const tools = run.arm === "A1" ? A1_TOOLS : A2_TOOLS;
  return [
    "-p", prompt,
    "--session-id", run.parentSessionId,
    "--model", PARENT_MODEL,
    "--output-format", "json",
    "-C", resolve(candidateRoot),
    "--allow-all-tools",
    `--available-tools=${tools.join(",")}`,
    "--disable-builtin-mcps",
    ...[...disabledMcpServers].sort().flatMap((name) => ["--disable-mcp-server", name]),
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", "default",
    "--effort", PARENT_EFFORT
  ];
}

export function parseCopilotJsonl(value) {
  return Buffer.from(value).toString("utf8").split(/\r?\n/u).filter(Boolean)
    .map((line, index) => {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.type !== "string") throw new Error("event type is missing");
        return event;
      } catch (error) {
        throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
      }
    });
}

function toolPath(event) {
  const args = event.data?.arguments;
  if (!args || typeof args !== "object") return null;
  return ["path", "file", "file_path", "target"]
    .map((name) => args[name])
    .find((value) => typeof value === "string") ?? null;
}

function taskCall(events) {
  const calls = events.filter((event) =>
    event.type === "tool.execution_start" && event.data?.toolName === "task");
  return {calls, id: calls.length === 1 ? calls[0].data?.toolCallId ?? null : null};
}

function actor(event, workerCallId) {
  return workerCallId
    && (event.agentId === workerCallId || event.data?.parentToolCallId === workerCallId)
    ? "worker"
    : "parent";
}

function completionMap(events) {
  return new Map(events
    .filter((event) => event.type === "tool.execution_complete")
    .map((event) => [event.data?.toolCallId, event]));
}

function observedModels(events, role, workerCallId) {
  return [...new Set(events
    .filter((event) =>
      ["model.call_start", "assistant.message", "subagent.started", "subagent.completed"]
        .includes(event.type))
    .filter((event) => actor(event, workerCallId) === role)
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))];
}

function normalizeCandidatePath(value, candidateRoot) {
  if (typeof value !== "string") return null;
  const root = resolve(candidateRoot);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const path = relative(root, absolute);
  return path.split(sep).join("/");
}

function policyPath(value, candidateRoot) {
  return relative(resolve(candidateRoot), resolve(value)).split(sep).join("/");
}

export function buildWorkerHandoff(policy, candidateRoot) {
  const prompts = readJson(resolve(experimentRoot, "design", "prompts.json"));
  const source = policyPath(policy.sourcePath, candidateRoot);
  const target = policyPath(policy.docTarget, candidateRoot);
  return prompts.workerHandoff
    .replace("CHANGED_SOURCE_PATHS", source)
    .replaceAll("TARGET", target);
}

function completeInitialReplacement(args, initialDocText) {
  if (!args || typeof args !== "object" || typeof initialDocText !== "string") return false;
  const oldText = ["old_str", "oldText", "old_string", "oldString", "old_value", "oldValue"]
    .map((name) => args[name])
    .find((value) => typeof value === "string");
  const newText = ["new_str", "newText", "new_string", "newString", "new_value", "newValue"]
    .map((name) => args[name])
    .find((value) => typeof value === "string");
  return oldText === initialDocText && typeof newText === "string" && newText.length > 0;
}

export function auditRuntime({events, usageRows, run, candidateRoot, policy}) {
  const reasons = [];
  const {calls, id: workerCallId} = taskCall(events);
  const completions = completionMap(events);
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const parentStarts = starts.filter((event) => actor(event, workerCallId) === "parent");
  const expectedTools = new Set(run.arm === "A1" ? A1_TOOLS : A2_TOOLS);
  if (parentStarts.some((event) => !expectedTools.has(event.data?.toolName))) {
    reasons.push("parent used a tool outside the frozen arm surface");
  }

  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1 || results[0].sessionId !== run.parentSessionId) {
    reasons.push("result session identity is missing or incorrect");
  }
  const parentRows = usageRows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  if (!parentRows.length || parentRows.some((row) =>
    row.model !== PARENT_MODEL || row.reasoning_effort !== PARENT_EFFORT)) {
    reasons.push("parent usage attribution is missing or incorrect");
  }

  const normalizedEvents = [];
  for (const event of events) {
    if (event.type === "tool.execution_start") {
      const role = actor(event, workerCallId);
      const name = event.data?.toolName;
      if (role === "parent" && name === "skill") {
        normalizedEvents.push({
          type: "skill_load",
          actor: role,
          skill: event.data?.arguments?.skill
        });
      } else if (role === "parent" && name === "task") {
        normalizedEvents.push({
          type: "agent_invocation",
          actor: role,
          agent: event.data?.arguments?.agent_type
        });
      } else {
        const complete = completions.get(event.data?.toolCallId);
        normalizedEvents.push({
          type: "tool",
          actor: role,
          tool: name === "view" ? "read" : name,
          path: normalizeCandidatePath(toolPath(event), candidateRoot),
          success: complete?.data?.success === true,
          operation: name === "edit" ? "replace" : null,
          complete: name === "edit"
            && completeInitialReplacement(event.data?.arguments, policy.initialDocText)
        });
      }
    } else if (event.type === "subagent.started" && event.agentId === workerCallId) {
      normalizedEvents.push({
        type: "session_created",
        actor: "worker",
        sessionId: event.agentId,
        requestedModel: calls[0]?.data?.arguments?.agent_type === AGENT_NAME
          ? WORKER_MODEL
          : null,
        observedModel: event.data?.model ?? null
      });
    } else if (event.type === "tool.execution_complete"
      && event.data?.toolCallId === workerCallId) {
      normalizedEvents.push({
        type: "terminal",
        actor: "worker",
        text: event.data?.result?.content ?? ""
      });
    }
  }

  const adherence = evaluateAdherence({
    arm: run.arm,
    workerSessionId: workerCallId,
    boundary: {
      caseSensitivePaths: process.platform !== "win32",
      docTarget: policyPath(policy.docTarget, candidateRoot),
      allowedWorkerReads: policy.allowedWorkerReads
        .map((path) => policyPath(path, candidateRoot)),
      allowedWorkerWrites: policy.allowedWorkerWrites
        .map((path) => policyPath(path, candidateRoot))
    },
    events: normalizedEvents
  });
  reasons.push(...adherence.violations);

  if (run.arm === "A2") {
    const skillStarts = starts.filter((event) => event.data?.toolName === "skill");
    const skill = skillStarts.filter((event) => event.data?.arguments?.skill === SKILL_NAME);
    const skillComplete = completions.get(skill[0]?.data?.toolCallId);
    const skillStartIndex = events.indexOf(skill[0]);
    const skillCompleteIndex = events.indexOf(skillComplete);
    const taskStartIndex = events.indexOf(calls[0]);
    if (skillStarts.length !== 1
      || skill.length !== 1
      || skillComplete?.data?.success !== true) {
      reasons.push("routing Skill load is missing or unsuccessful");
    }
    if (!(skillStartIndex >= 0
      && skillStartIndex < skillCompleteIndex
      && skillCompleteIndex < taskStartIndex)) {
      reasons.push("routing Skill must complete successfully before the named agent task starts");
    }
    const taskComplete = completions.get(workerCallId);
    const workerCompletions = events.filter((event) =>
      event.type === "subagent.completed" && event.agentId === workerCallId);
    if (calls.length !== 1
      || calls[0].data?.arguments?.agent_type !== AGENT_NAME
      || taskComplete?.data?.success !== true
      || workerCompletions.length !== 1) {
      reasons.push("named Sonnet agent task is missing or unsuccessful");
    }
    if (calls[0]?.data?.arguments?.prompt !== buildWorkerHandoff(policy, candidateRoot)) {
      reasons.push("named Sonnet agent task prompt differs from the frozen worker handoff");
    }
    const workerRows = usageRows.filter((row) =>
      row.agent_id === workerCallId && row.parent_tool_call_id === workerCallId);
    if (!workerCallId || !workerRows.length || workerRows.some((row) =>
      row.model !== WORKER_MODEL || row.initiator !== "sub-agent")) {
      reasons.push("worker usage attribution or observed model is missing or incorrect");
    }
  } else if (calls.length || starts.some((event) => event.data?.toolName === "skill")
    || usageRows.some((row) => row.agent_id !== null || row.parent_tool_call_id !== null)) {
    reasons.push("A1 invoked or accrued documentation-worker activity");
  }

  return {
    adherent: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    workerCallId,
    workerControlPlaneIdHash: workerCallId ? sha256(workerCallId) : null,
    normalizedEvents
  };
}

function safeIntegerSum(rows, field) {
  if (rows.some((row) => !Number.isSafeInteger(row[field]) || row[field] < 0)) return null;
  const value = rows.reduce((sum, row) => sum + row[field], 0);
  return Number.isSafeInteger(value) ? value : null;
}

function safeNumberSum(rows, field) {
  if (rows.some((row) =>
    typeof row[field] !== "number" || !Number.isFinite(row[field]) || row[field] < 0)) {
    return null;
  }
  const value = rows.reduce((sum, row) => sum + row[field], 0);
  return Number.isFinite(value) ? value : null;
}

function actorUsage(rows, required) {
  if (!rows.length && !required) {
    return {
      aiCredits: 0,
      nanoAiu: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      calls: 0
    };
  }
  if (!rows.length) {
    return {
      aiCredits: null,
      nanoAiu: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
      calls: 0
    };
  }
  const nanoAiu = safeNumberSum(rows, "total_nano_aiu");
  return {
    aiCredits: nanoAiu === null ? null : nanoAiu / 1e9,
    nanoAiu: Number.isSafeInteger(nanoAiu) ? nanoAiu : null,
    inputTokens: safeIntegerSum(rows, "input_tokens"),
    outputTokens: safeIntegerSum(rows, "output_tokens"),
    durationMs: safeNumberSum(rows, "duration_ms"),
    calls: rows.length
  };
}

export function aggregateUsage(rows, {arm, workerCallId}) {
  const parentRows = rows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  const workerRows = arm === "A2" && workerCallId
    ? rows.filter((row) =>
      row.agent_id === workerCallId && row.parent_tool_call_id === workerCallId)
    : [];
  const attributed = new Set([...parentRows, ...workerRows]);
  const parent = actorUsage(parentRows, true);
  const worker = actorUsage(workerRows, arm === "A2");
  const combinedNanoAiu = parent.nanoAiu === null || worker.nanoAiu === null
    ? null
    : parent.nanoAiu + worker.nanoAiu;
  const tokenValues = [
    parent.inputTokens, parent.outputTokens, worker.inputTokens, worker.outputTokens
  ];
  return {
    usage: {
      combinedAiCredits: combinedNanoAiu === null ? null : combinedNanoAiu / 1e9,
      parentAiCredits: parent.aiCredits,
      workerAiCredits: worker.aiCredits,
      parentCumulativeInputTokens: parent.inputTokens,
      parentPeakInputTokens: parentRows.length
        && parentRows.every((row) => Number.isSafeInteger(row.input_tokens))
        ? Math.max(...parentRows.map((row) => row.input_tokens))
        : null,
      totalTokens: tokenValues.every(Number.isSafeInteger)
        ? tokenValues.reduce((sum, value) => sum + value, 0)
        : null
    },
    parent,
    worker,
    missingRequiredActors: [
      ...(parentRows.length ? [] : ["parent"]),
      ...(arm === "A2" && !workerRows.length ? ["worker"] : [])
    ],
    unattributedRows: rows.filter((row) => !attributed.has(row))
  };
}

function eventTime(event) {
  const value = Date.parse(event?.timestamp ?? "");
  return Number.isFinite(value) ? value : null;
}

export function aggregateTiming(events, usage, measuredWallMs = null) {
  const starts = events.filter((event) => event.type === "assistant.turn_start" && !event.agentId);
  const ends = events.filter((event) => event.type === "assistant.turn_end" && !event.agentId);
  const workerStarts = events.filter((event) => event.type === "subagent.started");
  const workerEnds = events.filter((event) => event.type === "subagent.completed");
  const first = eventTime(starts[0]);
  const last = eventTime(ends.at(-1));
  const workerFirst = eventTime(workerStarts[0]);
  const workerLast = eventTime(workerEnds.at(-1));
  const result = events.find((event) => event.type === "result");
  const reportedWallMs = result?.usage?.sessionDurationMs
    ?? result?.data?.usage?.sessionDurationMs
    ?? null;
  return {
    wallMs: first !== null && last !== null && last >= first
      ? last - first
      : Number.isFinite(reportedWallMs) && reportedWallMs >= 0
        ? Math.round(reportedWallMs)
        : Number.isFinite(measuredWallMs) && measuredWallMs >= 0
          ? Math.round(measuredWallMs)
          : null,
    workerMs: workerFirst !== null && workerLast !== null && workerLast >= workerFirst
      ? workerLast - workerFirst
      : usage.missingRequiredActors.includes("worker")
        ? null
      : Number.isFinite(usage.worker.durationMs)
        ? Math.round(usage.worker.durationMs)
        : usage.worker.calls === 0 ? 0 : null
  };
}

export function startedFrom(events, rows) {
  return rows.some((row) => row.agent_id === null && row.parent_tool_call_id === null)
    || events.some((event) =>
      ["model.call_start", "assistant.message"].includes(event.type) && !event.agentId);
}

export function integrityCriticalMissingActors(missingActors, workerStarted) {
  return missingActors.filter((actor) => actor !== "worker" || workerStarted);
}

export function workerActivityStarted(events) {
  const taskIds = new Set(events
    .filter((event) =>
      event.type === "tool.execution_start" && event.data?.toolName === "task")
    .map((event) => event.data?.toolCallId)
    .filter(Boolean));
  return events.some((event) =>
    event.agentId
    && taskIds.has(event.agentId)
    && [
      "subagent.started",
      "model.call_start",
      "assistant.message",
      "tool.execution_start",
      "tool.execution_complete",
      "subagent.completed"
    ].includes(event.type));
}

function validPair(observations, blockId) {
  const rows = observations.filter((item) => item.blockId === blockId);
  return rows.length === 2
    && rows.every((item) =>
      item.started
      && item.completed
      && item.adherent
      && item.integrityPass
      && item.evaluation
      && item.evaluation.pass
      && item.evaluationReproduced
      && Number.isFinite(item.usage.combinedAiCredits));
}

export function evaluatePilotGate(observations, {privacyPass = true, lifecyclePass = true} = {}) {
  const plan = frozenPilotPlan();
  const blocks = [...new Set(plan.map((run) => run.blockId))];
  const validPairs = blocks.filter((blockId) => validPair(observations, blockId));
  const startedA2 = observations.filter((item) => item.arm === "A2" && item.started);
  const reasons = [];
  if (observations.length !== 12) reasons.push("all 12 scheduled slots must be retained");
  if (new Set(observations.map((item) => item.observationId)).size !== 12) {
    reasons.push("scheduled observation identities are incomplete or duplicated");
  }
  if (!observations.every((item) => item.disposedExactlyOnce)) {
    reasons.push("every slot must have one terminal disposition");
  }
  if (observations.some((item) => item.integrityPass === false)) {
    reasons.push("evidence integrity failed for at least one scheduled slot");
  }
  if (validPairs.length < 5) reasons.push("fewer than five valid complete pilot pairs");
  if (!startedA2.every((item) => item.adherent)) {
    reasons.push("a started A2 observation lacks mandatory routing evidence");
  }
  if (!observations.filter((item) => item.started).every((item) => item.usagePartitioned)) {
    reasons.push("started usage is not completely partitioned");
  }
  if (!observations.filter((item) => item.evaluation).every((item) =>
    item.evaluationReproduced && item.externalEvaluatorAiCredits === 0)) {
    reasons.push("deterministic zero-credit evaluation did not reproduce");
  }
  if (!privacyPass) reasons.push("concise evidence failed privacy checks");
  if (!lifecyclePass) reasons.push("lifecycle locks are incomplete");
  return {
    schemaVersion: 2,
    phase: "excluded-pilot",
    validPairs: validPairs.length,
    scheduledSlots: observations.length,
    disposedSlots: observations.filter((item) => item.disposedExactlyOnce).length,
    decision: reasons.length ? "NO-GO" : "GO",
    mainAuthorized: false,
    reasons
  };
}

export function concisePilotSummary(observations, gate) {
  return {
    schemaVersion: 2,
    phase: "excluded-pilot",
    decision: gate.decision,
    mainAuthorized: false,
    observationCount: observations.length,
    startedCount: observations.filter((item) => item.started).length,
    validPairs: gate.validPairs,
    reasons: gate.reasons,
    observations: observations.map((item) => ({
      observationId: item.observationId,
      blockId: item.blockId,
      arm: item.arm,
      started: item.started,
      completed: item.completed,
      status: item.status,
      adherent: item.adherent,
      combinedAiCredits: item.usage.combinedAiCredits,
      parentAiCredits: item.usage.parentAiCredits,
      workerAiCredits: item.usage.workerAiCredits,
      featureScore: item.evaluation?.feature?.score ?? null,
      documentation: item.evaluation?.documentation
        ? {
          correctness: item.evaluation.documentation.correctness,
          coverage: item.evaluation.documentation.coverage,
          executability: item.evaluation.documentation.executability,
          format: item.evaluation.documentation.format
        }
        : null,
      workerControlPlaneIdHash: item.workerControlPlaneIdHash ?? null,
      evidenceSha256: item.evidenceSha256
    }))
  };
}

export function privacyNormalize(value, replacements = []) {
  if (Array.isArray(value)) return value.map((entry) => privacyNormalize(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, privacyNormalize(entry, replacements)]));
  }
  if (typeof value !== "string") return value;
  let output = value;
  for (const [source, target] of replacements) {
    output = output.replaceAll(source, target)
      .replaceAll(source.replaceAll("\\", "/"), target);
  }
  return output
    .replace(/\b(bearer|token|secret|password|authorization)\s*[:=]\s*\S+/giu,
      "$1=<redacted>")
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+/gu, "<home>");
}

export function assertPrivacySafe(value) {
  const strings = [];
  const visit = (entry) => {
    if (typeof entry === "string") strings.push(entry);
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
  assert(!strings.some((text) =>
    /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/u.test(text)),
  "absolute home path leaked");
  assert(!strings.some((text) =>
    /\b(?:bearer|token|secret|password|authorization)\s*[:=]\s*(?!<redacted>)\S+/iu
      .test(text)), "secret-like value leaked");
  return value;
}

export function evidenceHash(observation) {
  const copy = {...observation, evidenceSha256: null};
  return sha256(stableStringify(copy));
}
