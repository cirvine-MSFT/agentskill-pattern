import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { evaluateTrace, generateSchedule, readJson, root } from "./lib.mjs";

export const PILOT_NAMESPACE = "unit-test-delegation-pilot-v1";
export const COPILOT_VERSION = "1.0.77";
export const NODE_VERSION = "22.14.0";
export const PARENT_MODEL = "gpt-5.6-sol";
export const WORKER_MODEL = "claude-haiku-4.5";
export const PARENT_CONTEXT = "default";
export const PARENT_EFFORT = "medium";
export const A1_TOOLS = ["edit", "powershell", "view"];
export const A2_TOOLS = ["edit", "powershell", "skill", "task", "view"];

const REQUIRED_HELP_FLAGS = [
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
];

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function predeterminedSessionId(observationId) {
  const bytes = crypto.createHash("sha256")
    .update(`${PILOT_NAMESPACE}\0${observationId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function predeterminedWorktreeId(observationId) {
  return `worktree-${sha256(`unit-test-delegation-pilot-worktree-v1\0${observationId}`).slice(0, 24)}`;
}

export function frozenPilotPlan() {
  const schedule = readJson(path.join(root, "design", "schedule.json"));
  assert.deepEqual(schedule, generateSchedule(), "frozen schedule differs from deterministic generation");
  return schedule.pilot.flatMap((block) => block.observations.map((observation) => ({
    globalOrder: schedule.pilot
      .slice(0, block.blockIndex - 1)
      .reduce((sum, entry) => sum + entry.observations.length, 0) + observation.order,
    blockId: block.blockId,
    blockIndex: block.blockIndex,
    taskId: block.taskId,
    repetition: block.repetition,
    observationId: observation.observationId,
    arm: observation.arm,
    order: observation.order,
    sessionId: predeterminedSessionId(observation.observationId),
    worktreeId: predeterminedWorktreeId(observation.observationId)
  })));
}

export function inspectCliSurface({ version, help, configuredMcpServers }) {
  const versionLine = String(version ?? "").split(/\r?\n/u).find((line) => line.trim())?.trim() ?? null;
  const missingHelpFlags = REQUIRED_HELP_FLAGS.filter((flag) => !String(help ?? "").includes(flag));
  const reasons = [];
  if (versionLine !== `GitHub Copilot CLI ${COPILOT_VERSION}.`) {
    reasons.push(`requires exact GitHub Copilot CLI ${COPILOT_VERSION}`);
  }
  if (missingHelpFlags.length > 0) reasons.push(`CLI help is missing: ${missingHelpFlags.join(", ")}`);
  if (!Array.isArray(configuredMcpServers)) reasons.push("configured MCP server list is unavailable");
  return {
    ok: reasons.length === 0,
    versionLine,
    missingHelpFlags,
    configuredMcpServers: Array.isArray(configuredMcpServers) ? [...configuredMcpServers].sort() : [],
    reasons
  };
}

export function buildCopilotArgs({ prompt, plan, candidateRoot, disabledMcpServers = [] }) {
  assert.equal(typeof prompt, "string");
  assert(prompt.length > 0, "prompt is required");
  assert(plan && ["A1", "A2"].includes(plan.arm), "pilot plan is required");
  const availableTools = plan.arm === "A1" ? A1_TOOLS : A2_TOOLS;
  return [
    "-p", prompt,
    "--session-id", plan.sessionId,
    "--model", PARENT_MODEL,
    "--output-format", "json",
    "-C", path.resolve(candidateRoot),
    "--allow-all-tools",
    `--available-tools=${availableTools.join(",")}`,
    "--disable-builtin-mcps",
    ...[...disabledMcpServers].sort().flatMap((server) => ["--disable-mcp-server", server]),
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", PARENT_CONTEXT,
    "--effort", PARENT_EFFORT
  ];
}

export function parseCopilotJsonl(value) {
  return Buffer.from(value).toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
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
  for (const field of ["path", "file", "file_path", "target"]) {
    if (typeof args[field] === "string") return args[field];
  }
  return null;
}

function toolKind(name) {
  if (["read", "view"].includes(name)) return "view";
  if (["edit", "apply_patch"].includes(name)) return "edit";
  if (["powershell", "bash", "shell"].includes(name)) return "shell";
  if (["rg", "glob", "search"].includes(name)) return "search";
  if (name === "task") return "task";
  return null;
}

function workerCall(events) {
  const tasks = events.filter((event) =>
    event.type === "tool.execution_start" && event.data?.toolName === "task");
  return { tasks, workerCallId: tasks.length === 1 ? tasks[0].data?.toolCallId ?? null : null };
}

function eventActor(event, workerCallId) {
  return workerCallId
    && (event.agentId === workerCallId || event.data?.parentToolCallId === workerCallId)
    ? "worker"
    : "parent";
}

export function deriveTrace(events) {
  const { workerCallId } = workerCall(events);
  const completions = new Map(events
    .filter((event) => event.type === "tool.execution_complete")
    .map((event) => [event.data?.toolCallId, event]));
  const traceEvents = [];
  for (const event of events) {
    if (event.type === "tool.execution_start") {
      const name = event.data?.toolName;
      const kind = toolKind(name);
      if (!kind) continue;
      const completion = completions.get(event.data?.toolCallId);
      const content = completion?.data?.result?.content;
      traceEvents.push({
        seq: traceEvents.length,
        actor: eventActor(event, workerCallId),
        kind,
        path: toolPath(event),
        toolName: name,
        resultBytes: typeof content === "string" ? Buffer.byteLength(content) : null
      });
    } else if (event.type === "subagent.completed" && event.agentId === workerCallId) {
      traceEvents.push({
        seq: traceEvents.length,
        actor: "worker",
        kind: "terminal",
        path: null,
        toolName: null,
        resultBytes: typeof event.data?.content === "string" ? Buffer.byteLength(event.data.content) : null
      });
    }
  }
  return { schemaVersion: 1, workerCallId, events: traceEvents };
}

function observedModels(events, actor, workerCallId) {
  return [...new Set(events
    .filter((event) => ["model.call_start", "assistant.message", "subagent.started", "subagent.completed"].includes(event.type))
    .filter((event) => eventActor(event, workerCallId) === actor)
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))];
}

function normalizePath(value, workspace) {
  if (typeof value !== "string") return "";
  const candidate = path.isAbsolute(value) ? path.relative(path.resolve(workspace), path.resolve(value)) : value;
  return candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function auditEvents({ events, usageRows, prompt, plan, workspace, envelope }) {
  const reasons = [];
  const { tasks, workerCallId } = workerCall(events);
  const toolStarts = events.filter((event) => event.type === "tool.execution_start");
  const toolCompletes = events.filter((event) => event.type === "tool.execution_complete");
  const externalMessages = events.filter((event) =>
    event.type === "user.message" && !event.agentId
    && !String(event.data?.source ?? "").startsWith("skill-"));
  if (externalMessages.length !== 1 || externalMessages[0].data?.content !== prompt) {
    reasons.push("external kickoff differs from the exact prompt");
  }
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1 || results[0].sessionId !== plan.sessionId) {
    reasons.push("result session identity is missing or incorrect");
  }
  const parentModels = observedModels(events, "parent", workerCallId);
  if (parentModels.length !== 1 || parentModels[0] !== PARENT_MODEL) {
    reasons.push("parent event model attribution is missing or incorrect");
  }
  const parentRows = usageRows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  if (parentRows.length === 0 || parentRows.some((row) =>
    row.model !== PARENT_MODEL || row.reasoning_effort !== PARENT_EFFORT)) {
    reasons.push("parent usage model/effort attribution is missing or incorrect");
  }
  const allowed = new Set(plan.arm === "A1" ? A1_TOOLS : A2_TOOLS);
  const parentTools = toolStarts.filter((event) => eventActor(event, workerCallId) === "parent");
  if (parentTools.some((event) => !allowed.has(event.data?.toolName))) {
    reasons.push("parent used a tool outside the frozen arm surface");
  }

  if (plan.arm === "A1") {
    if (tasks.length !== 0 || toolStarts.some((event) => event.data?.toolName === "skill")) {
      reasons.push("A1 invoked delegation");
    }
    if (usageRows.some((row) => row.agent_id !== null || row.parent_tool_call_id !== null)) {
      reasons.push("A1 contains worker-attributed usage");
    }
  } else {
    const skillStarts = toolStarts.filter((event) =>
      event.data?.toolName === "skill" && event.data?.arguments?.skill === "unit-test-authoring");
    if (skillStarts.length !== 1) reasons.push("A2 Skill invocation count mismatch");
    const skillCompletes = toolCompletes.filter((event) =>
      event.data?.toolCallId === skillStarts[0]?.data?.toolCallId);
    if (skillCompletes.length !== 1 || skillCompletes[0].data?.success !== true) {
      reasons.push("A2 Skill completion is missing or unsuccessful");
    }
    if (tasks.length !== 1
      || tasks[0].data?.arguments?.agent_type !== "unit-test-author-haiku") {
      reasons.push("A2 fixed-Haiku task invocation is missing or incorrect");
    }
    const taskCompletes = toolCompletes.filter((event) =>
      event.data?.toolCallId === workerCallId);
    if (taskCompletes.length !== 1 || taskCompletes[0].data?.success !== true) {
      reasons.push("A2 worker task completion is missing or unsuccessful");
    }
    const taskPrompt = tasks[0]?.data?.arguments?.prompt;
    const requiredEnvelopeValues = [
      envelope.runId,
      envelope.requirementsPath,
      ...envelope.changedProductionPaths,
      ...envelope.nearbyTestPaths,
      envelope.targetTestPath,
      envelope.statusHash
    ].filter((value) => typeof value === "string");
    if (typeof taskPrompt !== "string"
      || requiredEnvelopeValues.some((value) => !taskPrompt.includes(value))
      || /(?:hidden|mutant|gold|evidence|schedule)/iu.test(taskPrompt)) {
      reasons.push("A2 worker prompt does not contain only the frozen envelope");
    }
    const workerRows = usageRows.filter((row) =>
      row.agent_id === workerCallId && row.parent_tool_call_id === workerCallId);
    if (!workerCallId || workerRows.length === 0
      || workerRows.some((row) => row.model !== WORKER_MODEL || row.initiator !== "sub-agent")) {
      reasons.push("worker usage attribution is missing or incorrect");
    }
    const workerModels = observedModels(events, "worker", workerCallId);
    if (workerModels.length !== 1 || workerModels[0] !== WORKER_MODEL) {
      reasons.push("worker event model attribution is missing or incorrect");
    }
    const workerTools = toolStarts.filter((event) => eventActor(event, workerCallId) === "worker");
    if (workerTools.some((event) => !["read", "view", "edit"].includes(event.data?.toolName))) {
      reasons.push("worker used a forbidden tool");
    }
    for (const start of workerTools) {
      const completes = toolCompletes.filter((event) =>
        event.data?.toolCallId === start.data?.toolCallId);
      if (completes.length !== 1 || completes[0].data?.success !== true) {
        reasons.push("worker tool completion is missing or unsuccessful");
        break;
      }
    }
    const expectedTerminal = `${envelope.runId} | ${envelope.targetTestPath} | SUCCESS | ${envelope.statusHash}`;
    const workerTerminal = events.filter((event) =>
      event.type === "subagent.completed" && event.agentId === workerCallId);
    const terminalContent = workerTerminal[0]?.data?.content
      ?? taskCompletes[0]?.data?.result?.content;
    if (workerTerminal.length !== 1 || terminalContent !== expectedTerminal) {
      reasons.push("worker compact terminal line is missing or incorrect");
    }
    const target = normalizePath(envelope.targetTestPath, workspace);
    if (parentTools.some((event) =>
      ["read", "view", "edit", "apply_patch", "powershell", "bash", "shell", "rg", "glob", "search"]
        .includes(event.data?.toolName)
      && normalizePath(toolPath(event), workspace) === target)) {
      reasons.push("parent accessed the delegated target test");
    }
    const trace = deriveTrace(events);
    const adherence = evaluateTrace(trace, envelope, workspace);
    reasons.push(...adherence.reasons);
  }
  return { adherent: reasons.length === 0, reasons: [...new Set(reasons)], workerCallId };
}

function safeSum(rows, field) {
  if (rows.some((row) => !Number.isSafeInteger(row[field]) || row[field] < 0)) return null;
  const total = rows.reduce((sum, row) => sum + row[field], 0);
  return Number.isSafeInteger(total) ? total : null;
}

function safeNumericSum(rows, field) {
  if (rows.some((row) => typeof row[field] !== "number"
    || !Number.isFinite(row[field]) || row[field] < 0)) return null;
  const total = rows.reduce((sum, row) => sum + row[field], 0);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function actorUsage(rows, required) {
  if (rows.length === 0 && !required) {
    return { credits: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, completions: 0 };
  }
  const nanoAiu = safeNumericSum(rows, "total_nano_aiu");
  const inputTokens = safeSum(rows, "input_tokens");
  const outputTokens = safeSum(rows, "output_tokens");
  return {
    credits: nanoAiu === null ? null : nanoAiu / 1e9,
    nanoAiu: Number.isSafeInteger(nanoAiu) ? nanoAiu : null,
    inputTokens,
    outputTokens,
    completions: rows.length
  };
}

export function aggregateUsage(rows, { arm, workerCallId }) {
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
  const totalModelTokens = [parent.inputTokens, parent.outputTokens, worker.inputTokens, worker.outputTokens]
    .every(Number.isSafeInteger)
    ? parent.inputTokens + parent.outputTokens + worker.inputTokens + worker.outputTokens
    : null;
  const parentInputs = parentRows.map((row) => row.input_tokens);
  return {
    usage: {
      parent,
      worker,
      combinedCredits: combinedNanoAiu === null ? null : combinedNanoAiu / 1e9,
      combinedNanoAiu,
      totalModelTokens
    },
    parentContext: {
      cumulativeInputTokens: safeSum(parentRows, "input_tokens"),
      peakInputTokens: parentInputs.length > 0 && parentInputs.every(Number.isSafeInteger)
        ? Math.max(...parentInputs)
        : null
    },
    actorRows: { parent: parentRows, worker: workerRows },
    unattributedRows: rows.filter((row) => !attributed.has(row))
  };
}

function eventTime(event) {
  const value = Date.parse(event?.timestamp ?? "");
  return Number.isFinite(value) ? value : null;
}

export function aggregateTiming(events, actorRows) {
  const starts = events.filter((event) => event.type === "assistant.turn_start" && !event.agentId);
  const ends = events.filter((event) => event.type === "assistant.turn_end" && !event.agentId);
  const workerStarts = events.filter((event) => event.type === "subagent.started");
  const workerEnds = events.filter((event) => event.type === "subagent.completed");
  const first = eventTime(starts[0]);
  const last = eventTime(ends.at(-1));
  const workerFirst = eventTime(workerStarts[0]);
  const workerLast = eventTime(workerEnds.at(-1));
  const duration = (rows) => {
    const value = safeNumericSum(rows, "duration_ms");
    return value === null ? null : Math.round(value);
  };
  return {
    parentActiveMs: duration(actorRows.parent),
    workerActiveMs: duration(actorRows.worker),
    parentWaitMs: workerFirst !== null && workerLast !== null && workerLast >= workerFirst
      ? workerLast - workerFirst
      : actorRows.worker.length === 0 ? 0 : null,
    wallMs: first !== null && last !== null && last >= first ? last - first : null
  };
}

export function aggregateTools(events, workerCallId) {
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const byActorAndName = {};
  let resultBytes = 0;
  for (const event of starts) {
    const actor = eventActor(event, workerCallId);
    const name = event.data?.toolName ?? "unknown";
    byActorAndName[`${actor}:${name}`] = (byActorAndName[`${actor}:${name}`] ?? 0) + 1;
  }
  for (const event of events.filter((entry) => entry.type === "tool.execution_complete")) {
    const content = event.data?.result?.content;
    if (typeof content === "string") resultBytes += Buffer.byteLength(content);
  }
  return {
    parentCalls: starts.filter((event) => eventActor(event, workerCallId) === "parent").length,
    workerCalls: starts.filter((event) => eventActor(event, workerCallId) === "worker").length,
    resultBytes,
    byActorAndName
  };
}

export function conservativeMetric(observation, name) {
  const imputations = {
    combinedCredits: 40,
    parentCredits: 40,
    parentCumulativeInput: 80000,
    parentPeakInput: 80000,
    totalModelTokens: 80000,
    wallMs: 300000
  };
  const values = {
    combinedCredits: observation.usage?.combinedCredits,
    parentCredits: observation.usage?.parent?.credits,
    parentCumulativeInput: observation.parentContext?.cumulativeInputTokens,
    parentPeakInput: observation.parentContext?.peakInputTokens,
    totalModelTokens: observation.usage?.totalModelTokens,
    wallMs: observation.timing?.wallMs
  };
  return Number.isFinite(values[name])
    ? values[name]
    : observation.startDisposition === "started" ? imputations[name] ?? null : null;
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
    if (source) output = output.replaceAll(source, target).replaceAll(source.replaceAll("\\", "/"), target);
  }
  output = output
    .replace(/\b(bearer|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "$1=<redacted>")
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+/gu, "<home>");
  return output;
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
    /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/u.test(text)), "absolute home path leaked");
  assert(!strings.some((text) =>
    /\b(?:bearer|token|secret|password|authorization)\s*[:=]\s*(?!<redacted>)\S+/iu.test(text)),
  "secret-like value leaked");
  return value;
}

export function concisePilotSummary(observations, gate) {
  const pairs = frozenPilotPlan().filter((entry) => entry.arm === "A1").map((control) => {
    const treatment = frozenPilotPlan().find((entry) =>
      entry.blockId === control.blockId && entry.arm === "A2");
    const row = (plan) => {
      const observed = observations.find((entry) => entry.observationId === plan.observationId);
      return observed ? {
        observationId: observed.observationId,
        status: observed.status,
        started: observed.startDisposition === "started",
        featureScore: observed.evaluation?.feature?.score ?? null,
        testComposite: observed.evaluation?.tests?.composite ?? observed.evaluation?.tests?.compositeBeforeDuplicate ?? null,
        combinedCredits: observed.usage?.combinedCredits ?? null,
        parentCredits: observed.usage?.parent?.credits ?? null,
        workerCredits: observed.usage?.worker?.credits ?? null,
        totalModelTokens: observed.usage?.totalModelTokens ?? null,
        parentModelTokens: Number.isFinite(observed.usage?.parent?.inputTokens)
          && Number.isFinite(observed.usage?.parent?.outputTokens)
          ? observed.usage.parent.inputTokens + observed.usage.parent.outputTokens
          : null,
        workerModelTokens: Number.isFinite(observed.usage?.worker?.inputTokens)
          && Number.isFinite(observed.usage?.worker?.outputTokens)
          ? observed.usage.worker.inputTokens + observed.usage.worker.outputTokens
          : null,
        parentCumulativeInputTokens: observed.parentContext?.cumulativeInputTokens ?? null,
        parentPeakInputTokens: observed.parentContext?.peakInputTokens ?? null,
        parentActiveMs: observed.timing?.parentActiveMs ?? null,
        workerActiveMs: observed.timing?.workerActiveMs ?? null,
        parentWaitMs: observed.timing?.parentWaitMs ?? null,
        wallMs: observed.timing?.wallMs ?? null,
        adherent: observed.evaluation?.adherence?.adherent ?? null
      } : null;
    };
    return { blockId: control.blockId, A1: row(control), A2: row(treatment) };
  });
  return {
    schemaVersion: 1,
    phase: "excluded-pilot",
    decision: gate.decision,
    reasons: gate.reasons,
    observationCount: observations.length,
    startedCount: observations.filter((entry) => entry.startDisposition === "started").length,
    pairs
  };
}
