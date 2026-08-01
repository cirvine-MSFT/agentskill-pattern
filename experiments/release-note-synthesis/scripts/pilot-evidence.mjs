import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function parseEvents(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") throw new Error("event type is missing");
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

function toolName(event) {
  return event.data?.toolName ?? event.toolName ?? null;
}

function isStart(event) {
  return event.type === "tool.execution_start";
}

function isComplete(event) {
  return event.type === "tool.execution_complete";
}

function sum(rows, field) {
  const values = rows.map((row) => row[field]).filter(Number.isFinite);
  return values.length === rows.length ? values.reduce((total, value) => total + value, 0) : null;
}

function usageFor(rows) {
  return {
    completions: rows.length,
    inputTokens: sum(rows, "input_tokens"),
    outputTokens: sum(rows, "output_tokens"),
    cachedReadTokens: sum(rows, "cache_read_tokens"),
    cachedWriteTokens: sum(rows, "cache_write_tokens"),
    reasoningTokens: sum(rows, "reasoning_tokens"),
    modelTokens: rows.every((row) => Number.isFinite(row.input_tokens) && Number.isFinite(row.output_tokens))
      ? rows.reduce((total, row) => total + row.input_tokens + row.output_tokens, 0)
      : null,
    nanoAiu: sum(rows, "total_nano_aiu"),
    requestMultiplier: sum(rows, "request_multiplier"),
    activeTimeMs: sum(rows, "duration_ms"),
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  };
}

function auditEvents(path) {
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

function exactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function parseEnvelope(content) {
  if (typeof content !== "string" || content.trim() === "") return null;
  try {
    const value = JSON.parse(content);
    if (
      !exactKeys(value, ["runId", "outputPath", "integrity"])
      || !exactKeys(value.integrity, ["dossierSha256", "draftSha256", "draftBytes"])
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function urls(content) {
  return [...content.matchAll(/https:\/\/github\.com\/[^\s)>"]+/gu)]
    .map((match) => match[0].replace(/[.,;:]$/u, ""));
}

export function analyzeReturnAndLeakage({
  events,
  run,
  expectedEnvelope = null,
  allowedUrls = [],
  forbiddenFactIds = [],
}) {
  const workerCallId = events.find((event) => event.type === "subagent.started")?.data?.toolCallId
    ?? events.find((event) => event.type === "subagent.started")?.agentId
    ?? null;
  const messages = events.filter((event) => event.type === "assistant.message");
  const parentMessages = messages.filter((event) => !event.agentId && typeof event.data?.content === "string");
  const workerMessages = messages.filter((event) =>
    event.agentId === workerCallId && typeof event.data?.content === "string");
  const parentNonempty = parentMessages.map((event) => event.data.content.trim()).filter(Boolean);
  const workerNonempty = workerMessages.map((event) => event.data.content.trim()).filter(Boolean);
  const parentEnvelope = parseEnvelope(parentNonempty.at(-1));
  const workerEnvelope = parseEnvelope(workerNonempty.at(-1));
  const violations = [];
  if (parentNonempty.length !== 1 || !parentEnvelope) {
    violations.push("parent return is not exactly one compact status envelope");
  }
  if (workerNonempty.length !== 1 || !workerEnvelope) {
    violations.push("worker return is not exactly one compact status envelope");
  }
  if (expectedEnvelope) {
    const expected = JSON.stringify(expectedEnvelope);
    if (JSON.stringify(parentEnvelope) !== expected) violations.push("parent envelope differs from MCP write result");
    if (JSON.stringify(workerEnvelope) !== expected) violations.push("worker envelope differs from MCP write result");
  } else {
    violations.push("MCP write result envelope is unavailable");
  }
  const allowed = new Set(allowedUrls);
  for (const event of messages) {
    const content = event.data?.content ?? "";
    if (/evaluator[\\/]gold/iu.test(content)) {
      violations.push("model-visible content references evaluator/gold");
    }
    for (const factId of forbiddenFactIds) {
      if (content.includes(factId)) violations.push(`model-visible content leaks evaluator fact ID ${factId}`);
    }
    for (const url of urls(content)) {
      if (!allowed.has(url)) violations.push(`model-visible content contains cross-dossier URL ${url}`);
    }
  }
  if (parentNonempty.some((content) => !parseEnvelope(content))) {
    violations.push("parent received narration or draft content beyond the compact envelope");
  }
  if (workerNonempty.some((content) => /<function_calls>|<invoke\s+name=/iu.test(content))) {
    violations.push("worker emitted pseudo tool calls as assistant text");
  }
  return {
    compactReturnValid: violations.length === 0,
    parentEnvelope,
    workerEnvelope,
    violations: [...new Set(violations)],
    workerCallId,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function deriveRunEvidence({
  run,
  events,
  rawBytes,
  usageRows,
  auditPath,
  draftPath,
  processResult,
  startedAt,
  endedAt,
  configuredToolSchemas,
  allowedUrls = [],
  forbiddenFactIds = [],
}) {
  const reasons = [];
  const starts = events.filter(isStart);
  const completes = events.filter(isComplete);
  const skillStarts = starts.filter((event) =>
    toolName(event) === "skill"
    && event.data?.arguments?.skill === "release-note-synthesis");
  const skillCompletes = completes.filter((event) =>
    event.data?.toolCallId === skillStarts[0]?.data?.toolCallId
    && event.data?.success === true);
  const skillContexts = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source === "skill-release-note-synthesis");
  const taskStarts = starts.filter((event) => toolName(event) === "task");
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const workerCallId = subagentStarts[0]?.data?.toolCallId ?? subagentStarts[0]?.agentId ?? null;
  const mcpStarts = starts.filter((event) =>
    /(?:read_release_dossier|write_release_note_draft)$/u.test(toolName(event) ?? ""));
  const parentMcpCalls = mcpStarts.filter((event) => !event.agentId);
  const workerMcpCalls = mcpStarts.filter((event) => event.agentId === workerCallId);

  if (skillStarts.length !== 1 || skillCompletes.length !== 1 || skillContexts.length !== 1) {
    reasons.push("Skill discovery lifecycle is not exactly one complete release-note-synthesis invocation");
  }
  if (taskStarts.length !== 1) reasons.push("delegation task call is not exactly one");
  if (subagentStarts.length !== 1 || subagentCompletes.length !== 1) {
    reasons.push("fixed-Haiku subagent lifecycle is not exactly one complete invocation");
  }
  if (subagentStarts[0]?.data?.agentName !== "release-note-haiku") {
    reasons.push("observed worker agent is not release-note-haiku");
  }
  if (subagentStarts[0]?.data?.model !== "claude-haiku-4.5") {
    reasons.push("observed worker model is not claude-haiku-4.5");
  }
  if (mcpStarts.length !== 2 || workerMcpCalls.length !== 2 || parentMcpCalls.length !== 0) {
    reasons.push("MCP calls are not exactly two worker-owned and zero parent-owned");
  }

  let audit = [];
  try {
    audit = auditEvents(auditPath);
  } catch (error) {
    reasons.push(`audit unavailable: ${error.message}`);
  }
  const auditTypes = audit.map((event) => event.type);
  const readCount = auditTypes.filter((type) => type === "dossier.read").length;
  const writeCount = auditTypes.filter((type) => type === "draft.written").length;
  const terminalSuccess = auditTypes.at(-1) === "run.completed";
  if (readCount !== 1) reasons.push(`audit records ${readCount} dossier reads`);
  if (writeCount !== 1) reasons.push(`audit records ${writeCount} draft writes`);
  if (!terminalSuccess) reasons.push("MCP audit does not end in run.completed");

  let draft = null;
  try {
    draft = readFileSync(draftPath);
    const write = audit.find((event) => event.type === "draft.written");
    if (write?.sha256 !== sha256(draft) || write?.bytes !== draft.length) {
      reasons.push("draft bytes do not match MCP write audit");
    }
  } catch (error) {
    reasons.push(`draft unavailable: ${error.message}`);
  }

  const parentRows = usageRows.filter((row) => row.agent_id === null);
  const workerRows = usageRows.filter((row) => row.agent_id === workerCallId);
  const otherRows = usageRows.filter((row) => row.agent_id !== null && row.agent_id !== workerCallId);
  const parentUsage = usageFor(parentRows);
  const workerUsage = usageFor(workerRows);
  const totalUsage = usageFor(usageRows);
  if (parentRows.length === 0) reasons.push("no exact-session parent usage row");
  if (workerRows.length === 0) reasons.push("no exact-session worker usage row");
  if (otherRows.length > 0) reasons.push("exact-session usage contains an unexpected agent identity");
  if (JSON.stringify(parentUsage.models) !== JSON.stringify(["gpt-5.6-sol"])) {
    reasons.push("parent model set differs from the assigned singleton gpt-5.6-sol");
  }
  if (JSON.stringify(workerUsage.models) !== JSON.stringify(["claude-haiku-4.5"])) {
    reasons.push("worker model set differs from the assigned singleton claude-haiku-4.5");
  }

  const resultEvents = events.filter((event) => event.type === "result");
  if (resultEvents.length !== 1) reasons.push("raw events do not contain exactly one terminal result");
  if (resultEvents[0]?.sessionId !== run.sessionId) reasons.push("terminal session ID mismatch");
  if (processResult.status !== 0 || resultEvents[0]?.exitCode !== 0) {
    reasons.push(`Copilot process failed with status ${processResult.status}`);
  }

  const wallTimeMs = Date.parse(endedAt) - Date.parse(startedAt);
  const taskStart = taskStarts[0] ? Date.parse(taskStarts[0].timestamp) : NaN;
  const taskComplete = completes.find((event) =>
    event.data?.toolCallId === taskStarts[0]?.data?.toolCallId);
  const workerWallTimeMs = Number.isFinite(taskStart) && taskComplete
    ? Date.parse(taskComplete.timestamp) - taskStart
    : null;
  const parentWaitTimeMs = workerWallTimeMs;
  const toolResultBytes = completes.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event.data?.result ?? null), "utf8"),
    0,
  );
  const observedToolNames = [...new Set(starts.map(toolName).filter(Boolean))].sort();
  const schemaBytes = Buffer.byteLength(JSON.stringify(configuredToolSchemas), "utf8");
  const writeStart = mcpStarts.find((event) => /write_release_note_draft$/u.test(toolName(event) ?? ""));
  const writeComplete = completes.find((event) =>
    event.data?.toolCallId === writeStart?.data?.toolCallId && event.data?.success === true);
  const expectedEnvelope = writeComplete?.data?.result?.structuredContent
    ?? writeComplete?.data?.result
    ?? null;
  const returnAndLeakage = analyzeReturnAndLeakage({
    events,
    run,
    expectedEnvelope,
    allowedUrls,
    forbiddenFactIds,
  });
  reasons.push(...returnAndLeakage.violations);

  return {
    formatVersion: 1,
    runId: run.runId,
    dossierId: run.dossierId,
    arm: "A4",
    sessionId: run.sessionId,
    startedAt,
    endedAt,
    disposition: reasons.length === 0 ? "success" : "measured-failure",
    operationalSuccess: reasons.length === 0,
    treatmentAdherent: reasons.length === 0,
    strictSuccess: reasons.length === 0,
    failureReasons: reasons,
    mechanism: {
      parentModel: "gpt-5.6-sol",
      workerModel: subagentStarts[0]?.data?.model ?? null,
      skill: {
        name: "release-note-synthesis",
        invoked: skillStarts.length === 1,
        contextInjected: skillContexts.length === 1,
      },
      delegation: {
        invoked: subagentStarts.length === 1,
        completed: subagentCompletes.length === 1,
        agentName: subagentStarts[0]?.data?.agentName ?? null,
        workerCallId,
      },
      taskEnvelopeSha256: run.taskEnvelopeSha256,
    },
    boundary: {
      reads: readCount,
      writes: writeCount,
      terminalSuccess,
      configuredToolSchemaCount: configuredToolSchemas.length,
      configuredToolSchemaBytes: schemaBytes,
      observedToolNames,
      mcpCalls: mcpStarts.length,
      parentMcpCalls: parentMcpCalls.length,
      workerMcpCalls: workerMcpCalls.length,
      toolCalls: starts.length,
      toolResultBytes,
      rawEventBytes: rawBytes.length,
      draftBytes: draft?.length ?? null,
      draftSha256: draft ? sha256(draft) : null,
      boundariesObservable: audit.length > 0
        && skillStarts.length > 0
        && subagentStarts.length > 0
        && usageRows.length > 0,
    },
    usage: {
      parent: parentUsage,
      worker: workerUsage,
      total: totalUsage,
      unexpectedActors: usageFor(otherRows),
      credits: null,
      creditsAvailabilityReason: "local assistant_usage_events does not expose a credits column",
    },
    timing: {
      parentActiveMs: parentUsage.activeTimeMs,
      workerActiveMs: workerUsage.activeTimeMs,
      parentWaitMs: parentWaitTimeMs,
      workerWallMs: workerWallTimeMs,
      wallTimeMs,
    },
    terminal: {
      processStatus: processResult.status,
      processSignal: processResult.signal,
      resultEventCount: resultEvents.length,
      resultSessionId: resultEvents[0]?.sessionId ?? null,
      resultExitCode: resultEvents[0]?.exitCode ?? null,
    },
    returnBoundary: returnAndLeakage,
  };
}
