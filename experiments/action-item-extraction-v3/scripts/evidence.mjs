import { resolve } from "node:path";
import {
  exactParentWarning,
  ledgerSchemaErrors,
  runCandidateRoot,
  runs,
  sentinelText,
  tokenLimit,
  wallTimeLimitMs,
} from "./lib.mjs";

function toolName(event) {
  return event.data?.toolName ?? event.toolName ?? null;
}

function toolCallId(event) {
  return event.data?.toolCallId ?? event.toolCallId ?? null;
}

function eventSuccess(event) {
  return (event.data?.success ?? event.success) === true;
}

function eventModel(event) {
  return event.data?.model ?? event.model ?? null;
}

function parentToolCallId(event) {
  return event?.data?.parentToolCallId ?? event?.parentToolCallId ?? null;
}

function toolArguments(event) {
  return event.data?.arguments ?? event.arguments ?? {};
}

function pathEqual(left, right) {
  return typeof left === "string" && resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function stringsIn(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsIn(entry, output));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => stringsIn(entry, output));
  return output;
}

function unknownWarning(text) {
  return text.match(/Unknown tool name in the tool allowlist: "(?:builtin:)?[A-Za-z0-9_.:-]+"/u)?.[0] ?? null;
}

function completionsFor(start, completions) {
  const id = toolCallId(start);
  return id === null ? [] : completions.filter((event) =>
    toolCallId(event) === id
    && (event.agentId ?? null) === (start.agentId ?? null));
}

function successfulCompletion(start, completions) {
  const matches = completionsFor(start, completions);
  return matches.length === 1 && eventSuccess(matches[0]) ? matches[0] : null;
}

export function inspectToolEvents(events, run) {
  const taskStarts = events.filter((event) => event.type === "tool.execution_start"
    && !event.agentId && toolName(event) === "task");
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const workerStart = subagentStarts[0];
  const workerAgentId = workerStart?.agentId ?? workerStart?.data?.agentId ?? null;
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completions = events.filter((event) => event.type === "tool.execution_complete");
  const workerStarts = starts.filter((event) => event.agentId === workerAgentId);
  const views = workerStarts.filter((event) => toolName(event) === "view");
  const edits = workerStarts.filter((event) => toolName(event) === "edit");
  const parentFileCalls = starts.filter((event) =>
    !event.agentId && ["view", "edit", "read"].includes(toolName(event))).length;
  const otherWorkerTools = workerStarts.filter((event) => !["view", "edit"].includes(toolName(event))).map(toolName);
  const expectedTranscript = run ? resolve(runCandidateRoot(run), "input", "transcript.txt") : null;
  const expectedLedger = run ? resolve(runCandidateRoot(run), "output", "ledger.json") : null;
  const viewArgs = toolArguments(views[0] ?? {});
  const editArgs = toolArguments(edits[0] ?? {});
  const viewPath = viewArgs.path ?? viewArgs.filePath ?? viewArgs.file_path ?? viewArgs.target;
  const editPath = editArgs.path ?? editArgs.filePath ?? editArgs.file_path ?? editArgs.target;
  const editOldText = editArgs.old_str ?? editArgs.oldText ?? editArgs.old_text;
  const editNewText = editArgs.new_str ?? editArgs.newText ?? editArgs.new_text;
  const partialView = ["line_start", "line_end", "start_line", "end_line", "view_range"]
    .some((key) => viewArgs[key] !== undefined);
  const loadedSkills = events.flatMap((event) =>
    event.type === "session.skills_loaded" ? (event.data?.skills ?? event.skills ?? []) : []);
  const projectSkillLoads = loadedSkills.filter((skill) =>
    skill.name === "action-ledger-v3" && skill.source === "project").length;
  const taskCompletion = taskStarts.length === 1 ? successfulCompletion(taskStarts[0], completions) : null;
  const viewCompletion = views.length === 1 ? successfulCompletion(views[0], completions) : null;
  const editCompletion = edits.length === 1 ? successfulCompletion(edits[0], completions) : null;
  const workerCompletion = subagentCompletes.length === 1 ? subagentCompletes[0] : null;
  const workerCompletionMatches = Boolean(workerCompletion && workerAgentId
    && (workerCompletion.agentId ?? workerCompletion.data?.agentId) === workerAgentId);
  const taskId = taskStarts.length === 1 ? toolCallId(taskStarts[0]) : null;
  const linkedWorker = Boolean(taskId && workerAgentId === taskId
    && workerStart?.data?.toolCallId === taskId
    && workerCompletion?.data?.toolCallId === taskId);
  const workerEvents = [workerStart, workerCompletion, views[0], viewCompletion, edits[0], editCompletion].filter(Boolean);
  const linkedWorkerTools = Boolean(taskId && [views[0], viewCompletion, edits[0], editCompletion]
    .every((event) => parentToolCallId(event) === taskId));
  const exactEventModels = Boolean(taskStarts[0] && taskCompletion
    && eventModel(taskStarts[0]) === "gpt-5.6-sol"
    && eventModel(taskCompletion) === "gpt-5.6-sol"
    && workerEvents.every((event) => eventModel(event) === "claude-haiku-4.5"));
  const ordered = taskStarts.length === 1 && subagentStarts.length === 1 && views.length === 1 && edits.length === 1
    && taskCompletion && viewCompletion && editCompletion && workerCompletionMatches
    && events.indexOf(taskStarts[0]) < events.indexOf(subagentStarts[0])
    && events.indexOf(subagentStarts[0]) < events.indexOf(views[0])
    && events.indexOf(views[0]) < events.indexOf(viewCompletion)
    && events.indexOf(viewCompletion) < events.indexOf(edits[0])
    && events.indexOf(edits[0]) < events.indexOf(editCompletion)
    && events.indexOf(editCompletion) < events.indexOf(workerCompletion)
    && events.indexOf(workerCompletion) < events.indexOf(taskCompletion);
  const exactPathsAndArguments = Boolean(run)
    && pathEqual(viewPath, expectedTranscript)
    && !partialView
    && pathEqual(editPath, expectedLedger)
    && editOldText === sentinelText
    && typeof editNewText === "string"
    && editNewText.length > 0
    && editNewText !== sentinelText;
  const exactLifecycle = taskStarts.length === 1 && Boolean(taskCompletion)
    && subagentStarts.length === 1 && subagentCompletes.length === 1
    && workerCompletionMatches;
  const exactCalls = views.length === 1 && edits.length === 1
    && Boolean(viewCompletion) && Boolean(editCompletion)
    && workerStarts.length === 2 && parentFileCalls === 0 && otherWorkerTools.length === 0;
  return {
    workerAgentId,
    workerName: workerStart?.data?.agentName ?? workerStart?.agentName ?? null,
    workerModel: workerStart?.data?.model ?? workerStart?.model ?? null,
    projectSkillLoads,
    parentTaskStarts: taskStarts.length,
    parentTaskCompleted: Boolean(taskCompletion),
    subagentStarts: subagentStarts.length,
    subagentCompletes: subagentCompletes.length,
    workerViews: views.length,
    workerEdits: edits.length,
    successfulWorkerViews: Number(Boolean(viewCompletion)),
    successfulWorkerEdits: Number(Boolean(editCompletion)),
    parentFileCalls,
    otherWorkerTools,
    ordered,
    wholeTranscriptView: Boolean(run) && pathEqual(viewPath, expectedTranscript) && !partialView,
    exactSentinelEdit: Boolean(run) && pathEqual(editPath, expectedLedger)
      && editOldText === sentinelText && typeof editNewText === "string" && editNewText.length > 0 && editNewText !== sentinelText,
    exactLifecycle,
    exactCalls,
    exactPathsAndArguments,
    linkedWorker,
    linkedWorkerTools,
    exactEventModels,
    exactMechanism: projectSkillLoads === 1 && exactLifecycle && exactCalls && ordered
      && exactPathsAndArguments && linkedWorker && linkedWorkerTools && exactEventModels,
  };
}

export function toolsBlockEvidence(events, stderrText, workerAgentId) {
  const blocks = [];
  for (const event of events) {
    const texts = JSON.stringify(event).split("\\n");
    for (const text of texts.filter((entry) => /\bTools\s*:/iu.test(entry))) {
      blocks.push({ source: "event", workerAttributed: event.agentId === workerAgentId, text: text.slice(0, 20_000) });
    }
  }
  for (const line of stderrText.split(/\r?\n/u).filter((entry) => /\bTools\s*:/iu.test(entry))) {
    blocks.push({
      source: "stderr",
      workerAttributed: Boolean(workerAgentId && line.includes(workerAgentId)) || line.includes("action-ledger-v3-haiku"),
      text: line.slice(0, 20_000),
    });
  }
  return {
    informativeOnly: true,
    parentCaptured: blocks.some((block) => !block.workerAttributed),
    workerCaptured: blocks.some((block) => block.workerAttributed),
    distinctParentAndWorkerBlocks: blocks.some((block) => block.workerAttributed) && blocks.some((block) => !block.workerAttributed),
    blocks,
  };
}

export function warningRuleEvidence({ events, stderrText, ledger, sentinelReplaced, run, usageRows = [] }) {
  const tools = inspectToolEvents(events, run);
  const eventWarnings = events.flatMap((event, eventIndex) => {
    const texts = stringsIn(event.data ?? event);
    const unknown = texts.map(unknownWarning).filter(Boolean);
    if (unknown.length) return unknown.map((message) => ({ source: "event", eventIndex, event, message }));
    if (event.type === "warning" || event.type?.endsWith(".warning")
      || (event.type === "session.info" && texts.some((text) => /\bwarn(?:ing)?\b/iu.test(text)))) {
      const message = String(event.data?.message ?? event.message ?? texts.find((text) => text.trim()) ?? "unspecified warning").trim();
      return [{ source: "event", eventIndex, event, message }];
    }
    return [];
  });
  const stderrWarnings = stderrText.split(/\r?\n/u).flatMap((line, lineIndex) => {
    const exact = unknownWarning(line);
    if (exact) return [{ source: "stderr", lineIndex, event: null, message: exact, stderrLine: line }];
    return /\bwarn(?:ing)?\b/iu.test(line) ? [{ source: "stderr", lineIndex, event: null, message: line.trim(), stderrLine: line }] : [];
  });
  const mirroredStderrWarnings = stderrWarnings.filter((warning) => !eventWarnings.some((eventWarning) =>
    eventWarning.message === warning.message
    && (eventWarning.event?.agentId ?? eventWarning.event?.data?.agentId ?? null) === null));
  const observedWarnings = [...eventWarnings, ...mirroredStderrWarnings];
  const workerWarnings = observedWarnings.filter((warning) =>
    (warning.event?.agentId ?? warning.event?.data?.agentId ?? null) === tools.workerAgentId);
  const schemaValid = ledgerSchemaErrors(ledger, run).length === 0;
  const usageModels = [...new Set(usageRows.map((row) => row.model).filter(Boolean))].sort();
  const expectedActorsAndModels = tools.workerName === "action-ledger-v3-haiku"
    && tools.workerModel === "claude-haiku-4.5"
    && usageModels.join(",") === "claude-haiku-4.5,gpt-5.6-sol";
  const exactSingleParentWarning = observedWarnings.length === 1
    && observedWarnings[0].message === exactParentWarning
    && !(observedWarnings[0].event?.agentId ?? observedWarnings[0].event?.data?.agentId);
  const accepted = exactSingleParentWarning && workerWarnings.length === 0 && tools.exactMechanism
    && sentinelReplaced && schemaValid && expectedActorsAndModels;
  return {
    prospectiveRuleVersion: 3,
    exactSingleParentWarning,
    workerUnknownToolWarnings: workerWarnings.map((warning) => warning.message),
    exactCalls: tools.exactCalls,
    exactMechanism: tools.exactMechanism,
    sentinelReplaced,
    schemaValid,
    expectedActorsAndModels,
    accepted,
    fatal: !accepted,
    warnings: observedWarnings.map((warning) => ({
      source: warning.source,
      message: warning.message,
      agentId: warning.event?.agentId ?? warning.event?.data?.agentId ?? null,
    })),
    tools,
    toolsBlocks: toolsBlockEvidence(events, stderrText, tools.workerAgentId),
  };
}

export function summarizeUsage(rows) {
  const finite = (field) => rows.every((row) => Number.isFinite(row[field]));
  const sum = (field) => finite(field) ? rows.reduce((total, row) => total + row[field], 0) : null;
  const settled = rows.length > 0 && finite("input_tokens") && finite("output_tokens")
    && rows.every((row) => typeof row.finish_reason === "string" && row.finish_reason.length > 0);
  return {
    settlementRequired: true,
    settled,
    completions: rows.length,
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    reasoningTokens: sum("reasoning_tokens"),
    totalModelTokens: finite("input_tokens") && finite("output_tokens")
      ? rows.reduce((total, row) => total + row.input_tokens + row.output_tokens, 0) : null,
    activeTimeMs: sum("duration_ms"),
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  };
}

export function summarizeEvidence(evidence) {
  const meanF1 = evidence.reduce((sum, entry) => sum + (entry.quality?.tuple?.f1 ?? 0), 0) / runs.length;
  const passed = evidence.length === runs.length
    && evidence.every((entry) => entry.operationalSuccess && entry.treatmentAdherent)
    && evidence.every((entry) => entry.mechanism?.tools?.workerViews === 1
      && entry.mechanism?.tools?.workerEdits === 1
      && entry.mechanism?.tools?.successfulWorkerViews === 1
      && entry.mechanism?.tools?.successfulWorkerEdits === 1)
    && evidence.every((entry) => entry.quality?.unsupportedCriticalActions === 0)
    && evidence.every((entry) => entry.schema?.valid && entry.returnBoundary?.compact && entry.isolation?.valid)
    && evidence.every((entry) => entry.quality?.tuple?.f1 >= 0.75)
    && meanF1 >= 0.85
    && evidence.every((entry) => entry.quality?.sourceGrounding?.rate === 1)
    && evidence.every((entry) => entry.usage?.totalModelTokens <= tokenLimit)
    && evidence.every((entry) => entry.timing?.wallTimeMs <= wallTimeLimitMs);
  return {
    formatVersion: 3,
    protocolId: "action-item-extraction-v3",
    intentToTreat: true,
    disposition: passed ? "GO" : "NO-GO",
    retries: 0,
    thresholdChanges: 0,
    runOrder: runs.map((run) => run.runId),
    starts: evidence.length,
    meanTupleF1: meanF1,
    sourceGrounding100Percent: evidence.length === runs.length
      && evidence.every((entry) => entry.quality?.sourceGrounding?.rate === 1),
    authorizationBoundary: passed
      ? "GO authorizes only a separate five-arm main-study preregistration PR; it does not authorize main execution."
      : "NO-GO authorizes no further AI execution.",
  };
}
