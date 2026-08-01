#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import { validateFoundation } from "./validate-foundation.mjs";
import {
  acceptedParentWarnings,
  candidateRoot,
  cliArgs,
  cliVersion,
  evidenceManifest,
  evidenceRoot,
  expectedCompactStatus,
  experimentRoot,
  filesUnder,
  globalToolFilter,
  goldPath,
  invariant,
  jsonBytes,
  ledgerSchemaErrors,
  manifestFor,
  parseJsonl,
  posixRelative,
  protocolId,
  readJson,
  repositoryRoot,
  runCandidateRoot,
  runs,
  runtimeRoot,
  sentinelText,
  sessionIdFor,
  sha256,
  taskEnvelope,
  tokenLimit,
  toolArguments,
  toolName,
  toolPath,
  transcriptPath,
  wallTimeLimitMs,
} from "./lib.mjs";

const usageColumns = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "duration_ms", "reasoning_effort",
  "finish_reason", "created_at",
];

function writeOnce(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

function replaceJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.pending`;
  writeFileSync(pending, jsonBytes(value), { flag: "wx" });
  renameSync(pending, path);
}

function command(executable, args, options = {}) {
  return spawnSync(executable, args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

function createProfile() {
  const profile = resolve(runtimeRoot, "profile");
  const home = resolve(profile, ".copilot");
  mkdirSync(home, { recursive: true });
  const settings = {
    autoUpdate: false,
    memory: false,
    customAgents: { defaultLocalOnly: true },
    sandbox: {
      enabled: true,
      addCurrentWorkingDirectory: true,
      allowBypass: false,
      gitAuth: false,
      ghAuth: false,
      sandboxMcpServers: true,
      sandboxLspServers: true,
      userPolicy: {
        filesystem: {
          readwritePaths: [],
          readonlyPaths: [],
          deniedPaths: [repositoryRoot, evidenceRoot, resolve(experimentRoot, "evaluator")],
          clearPolicyOnExit: true,
        },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    },
  };
  writeOnce(resolve(home, "settings.json"), jsonBytes(settings));
  return { profile, home, settings };
}

function materialize(run) {
  const root = runCandidateRoot(run);
  invariant(!existsSync(root), `${run.runId} runtime already exists; retries are forbidden`);
  const files = [
    [resolve(candidateRoot, ".github", "skills", "action-ledger-v2", "SKILL.md"), resolve(root, ".github", "skills", "action-ledger-v2", "SKILL.md")],
    [resolve(candidateRoot, ".github", "agents", "action-ledger-v2-haiku.agent.md"), resolve(root, ".github", "agents", "action-ledger-v2-haiku.agent.md")],
    [transcriptPath(run), resolve(root, "input", "transcript.txt")],
  ];
  for (const [source, destination] of files) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  writeOnce(resolve(root, "output", "ledger.json"), Buffer.from(sentinelText, "utf8"));
  assertCandidateFiles(root);
  return root;
}

function assertCandidateFiles(root) {
  const expected = [
    ".github/agents/action-ledger-v2-haiku.agent.md",
    ".github/skills/action-ledger-v2/SKILL.md",
    "input/transcript.txt",
    "output/ledger.json",
  ];
  const actual = filesUnder(root).map((path) => posixRelative(root, path));
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `candidate root contains unexpected files: ${actual.join(",")}`);
  invariant(!existsSync(resolve(root, ".git")), "candidate git metadata is forbidden");
}

function exportUsage(database, sessionId) {
  invariant(existsSync(database), "isolated session store is missing");
  const sql = `SELECT ${usageColumns.join(",")} FROM assistant_usage_events WHERE session_id = ? ORDER BY id`;
  const script = [
    "import json,sqlite3,sys",
    "db=sqlite3.connect(sys.argv[1])",
    "db.row_factory=sqlite3.Row",
    `print(json.dumps([dict(r) for r in db.execute(${JSON.stringify(sql)},(sys.argv[2],))],separators=(',',':')))`,
  ].join("\n");
  const variants = process.platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]];
  for (const [executable, ...prefix] of variants) {
    const result = command(executable, [...prefix, "-c", script, database, sessionId], { encoding: "utf8" });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  }
  throw new Error("exact-session usage export failed");
}

function usageSummary(rows) {
  const sum = (field) => rows.every((row) => Number.isFinite(row[field]))
    ? rows.reduce((total, row) => total + row[field], 0) : null;
  return {
    completions: rows.length,
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    reasoningTokens: sum("reasoning_tokens"),
    totalModelTokens: rows.every((row) => Number.isFinite(row.input_tokens) && Number.isFinite(row.output_tokens))
      ? rows.reduce((total, row) => total + row.input_tokens + row.output_tokens, 0) : null,
    nanoAiu: sum("total_nano_aiu"),
    activeTimeMs: sum("duration_ms"),
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  };
}

function toolCallId(event) {
  return event.data?.toolCallId ?? event.toolCallId ?? null;
}

function completed(start, completions) {
  const id = toolCallId(start);
  return Boolean(start && id !== null && completions.some((event) =>
    toolCallId(event) === id && (event.data?.success ?? event.success) === true));
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

export function schemaEvidence(events, stderrText, workerAgentId) {
  const blocks = [];
  for (const event of events) {
    for (const text of stringsIn(event)) {
      if (/\bTools\s*:/iu.test(text)) {
        blocks.push({
          source: "event",
          agentId: event.agentId ?? null,
          positivelyWorkerAttributed: event.agentId === workerAgentId,
          text: text.slice(0, 20_000),
        });
      }
    }
  }
  const stderrLines = stderrText.split(/\r?\n/u);
  const workerMarkers = [workerAgentId, "action-ledger-v2-haiku"]
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const workerMarker = new RegExp(`(?:${workerMarkers.join("|")})`, "iu");
  const workerRegistryStderrIndex = stderrLines.findIndex((line) => workerMarker.test(line));
  for (const [index, line] of stderrLines.entries()) {
    if (!/\bTools\s*:/iu.test(line)) continue;
    const positivelyWorkerAttributed = workerMarker.test(line);
    blocks.push({
      source: "stderr",
      sourceIndex: index,
      agentId: positivelyWorkerAttributed ? workerAgentId : null,
      positivelyWorkerAttributed,
      text: stderrLines.slice(index, index + 120).join("\n").slice(0, 20_000),
    });
  }
  const has = (block, name) => new RegExp(`(?:^|[^\\w])(?:builtin:)?${name}(?:[^\\w]|$)`, "iu").test(block.text);
  const parent = blocks.find((block) => !block.positivelyWorkerAttributed
    && globalToolFilter.every((name) => has(block, name))) ?? null;
  const worker = blocks.find((block) => block.positivelyWorkerAttributed
    && has(block, "view") && has(block, "edit")) ?? null;
  return {
    parentCaptured: Boolean(parent),
    workerCaptured: Boolean(worker),
    parentExcerpt: parent?.text ?? null,
    workerExcerpt: worker?.text ?? null,
    workerContainsStructuredView: Boolean(worker && has(worker, "view")
      && /view[\s\S]{0,200}(?:path|file|target)/iu.test(worker.text)),
    workerContainsBuiltinEdit: Boolean(worker && has(worker, "edit")
      && /(?:builtin[\s\S]{0,80}edit|edit[\s\S]{0,200}(?:old_str|new_str|patch|file|path))/iu.test(worker.text)),
    workerSource: worker?.source ?? null,
    workerSourceIndex: worker?.sourceIndex ?? null,
    workerRegistryStderrIndex: workerRegistryStderrIndex >= 0 ? workerRegistryStderrIndex : null,
    distinctParentAndWorkerBlocks: Boolean(parent && worker && parent !== worker),
    blocksObserved: blocks.length,
  };
}

export function warningEvidence(events, stderrText, subagentEventIndex, workerAgentId, schemas, workerEditSucceeded) {
  const observed = [];
  for (const [eventIndex, event] of events.entries()) {
    for (const text of stringsIn(event.data ?? event)) {
      if (/unknown tool name in the tool allowlist/iu.test(text)) {
        const message = text.match(/Unknown tool name in the tool allowlist: "(?:builtin:)?[A-Za-z0-9_.:-]+"/iu)?.[0] ?? text.trim();
        observed.push({ source: "event", eventIndex, agentId: event.agentId ?? null, message });
      }
    }
  }
  for (const [lineIndex, line] of stderrText.split(/\r?\n/u).entries()) {
    if (!/unknown tool name in the tool allowlist/iu.test(line)) continue;
    const message = line.match(/Unknown tool name in the tool allowlist: "(?:builtin:)?[A-Za-z0-9_.:-]+"/iu)?.[0] ?? line.trim();
    observed.push({ source: "stderr", eventIndex: null, lineIndex, agentId: line.includes(workerAgentId) ? workerAgentId : null, message });
  }
  const accepted = observed.filter((warning) =>
    acceptedParentWarnings.includes(warning.message)
    && warning.agentId === null
    && (warning.eventIndex === null || warning.eventIndex < subagentEventIndex)
    && (warning.source !== "stderr" || (Number.isInteger(schemas.workerRegistryStderrIndex)
      && warning.lineIndex < schemas.workerRegistryStderrIndex))
    && schemas.workerContainsStructuredView
    && schemas.workerContainsBuiltinEdit
    && workerEditSucceeded);
  return {
    observed,
    accepted,
    rejected: observed.filter((warning) => !accepted.includes(warning)),
    acceptanceRule: "Only exact bare/source-qualified parent edit warning before child registry; worker schema and successful edit required.",
  };
}

function finalMessage(events, agentId) {
  return events.filter((event) => event.type === "assistant.message"
    && (event.agentId ?? null) === agentId)
    .map((event) => event.data?.content ?? event.content)
    .filter((content) => typeof content === "string" && content.trim()).at(-1)?.trim() ?? null;
}

export function inspectToolEvents(events) {
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completions = events.filter((event) => event.type === "tool.execution_complete");
  const subagent = events.find((event) => event.type === "subagent.started");
  const workerAgentId = subagent?.agentId ?? null;
  const workerViews = starts.filter((event) => event.agentId === workerAgentId && toolName(event) === "view");
  const workerEdits = starts.filter((event) => event.agentId === workerAgentId && toolName(event) === "edit");
  return {
    workerAgentId,
    workerViews: workerViews.length,
    workerEdits: workerEdits.length,
    successfulWorkerViews: workerViews.filter((event) => completed(event, completions)).length,
    successfulWorkerEdits: workerEdits.filter((event) => completed(event, completions)).length,
    parentFileCalls: starts.filter((event) => !event.agentId && ["view", "edit"].includes(toolName(event))).length,
  };
}

export function analyzeRun({ run, events, stdoutBytes, stderrBytes, processResult, usageRows, startedAt, endedAt, ledger, sentinelBefore }) {
  const failures = [];
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completions = events.filter((event) => event.type === "tool.execution_complete");
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const workerAgentId = subagentStarts[0]?.agentId ?? null;
  const subagentEventIndex = events.indexOf(subagentStarts[0]);
  if (!workerAgentId) failures.push("worker agentId missing from subagent.started");
  const taskStarts = starts.filter((event) => toolName(event) === "task" && !event.agentId);
  const taskToolCallId = toolCallId(taskStarts[0]);
  const views = starts.filter((event) => toolName(event) === "view");
  const edits = starts.filter((event) => toolName(event) === "edit");
  const workerViews = views.filter((event) => event.agentId === workerAgentId);
  const workerEdits = edits.filter((event) => event.agentId === workerAgentId);
  const parentViews = views.filter((event) => !event.agentId);
  const parentEdits = edits.filter((event) => !event.agentId);
  const transcript = resolve(runCandidateRoot(run), "input", "transcript.txt");
  const ledgerPath = resolve(runCandidateRoot(run), "output", "ledger.json");
  const workerViewSucceeded = workerViews.length === 1 && completed(workerViews[0], completions);
  const workerEditSucceeded = workerEdits.length === 1 && completed(workerEdits[0], completions);
  const schemas = schemaEvidence(events, stderrBytes.toString("utf8"), workerAgentId ?? "");
  const warnings = warningEvidence(events, stderrBytes.toString("utf8"), subagentEventIndex, workerAgentId ?? "", schemas, workerEditSucceeded);
  const loadedSkills = events.flatMap((event) =>
    event.type === "session.skills_loaded" ? (event.data?.skills ?? event.skills ?? []) : []);
  const loadedV2Skills = loadedSkills.filter((skill) => skill.name === "action-ledger-v2" && skill.source === "project");
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  const ledgerBytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.alloc(0);
  const sentinelReplaced = sentinelBefore === sentinelText && ledgerBytes.toString("utf8") !== sentinelText
    && !ledgerBytes.toString("utf8").includes("ACTION_ITEM_EXTRACTION_V2_REPLACE_ME");
  const itemCount = Array.isArray(ledger?.items) ? ledger.items.length : 0;
  const expectedStatus = expectedCompactStatus(run, itemCount);
  const workerStatus = finalMessage(events, workerAgentId)
    ?? subagentCompletes.map((event) => event.data?.result ?? event.data?.content).filter((value) => typeof value === "string").at(-1)?.trim()
    ?? null;
  const parentStatus = finalMessage(events, null);
  const workerUsageIds = new Set([workerAgentId, taskToolCallId].filter(Boolean));
  const parentRows = usageRows.filter((row) => row.agent_id === null);
  const workerRows = usageRows.filter((row) => workerUsageIds.has(row.agent_id));
  const unexpectedRows = usageRows.filter((row) => row.agent_id !== null && !workerUsageIds.has(row.agent_id));
  const usage = { parent: usageSummary(parentRows), worker: usageSummary(workerRows), unexpectedActors: usageSummary(unexpectedRows), total: usageSummary(usageRows), rows: usageRows };
  const wallTimeMs = Date.parse(endedAt) - Date.parse(startedAt);
  const resultEvents = events.filter((event) => event.type === "result");
  const allFileStarts = [...views, ...edits];
  const expectedFileStarts = allFileStarts.filter((event) =>
    (toolName(event) === "view" && pathEqual(toolPath(event), transcript))
    || (toolName(event) === "edit" && pathEqual(toolPath(event), ledgerPath)));
  const candidateFiles = filesUnder(runCandidateRoot(run)).map((path) => posixRelative(runCandidateRoot(run), path));
  const exactCandidateFiles = [
    ".github/agents/action-ledger-v2-haiku.agent.md",
    ".github/skills/action-ledger-v2/SKILL.md",
    "input/transcript.txt",
    "output/ledger.json",
  ];
  if (loadedV2Skills.length !== 1) failures.push("project Skill was not loaded exactly once");
  if (taskStarts.length !== 1 || !completed(taskStarts[0], completions)) failures.push("parent delegation was not one successful task");
  if (subagentStarts.length !== 1 || subagentCompletes.length !== 1) failures.push("worker lifecycle was not exactly one start/complete");
  if (subagentStarts[0]?.data?.agentName !== "action-ledger-v2-haiku") failures.push("worker agent mismatch");
  if (subagentStarts[0]?.data?.model !== "claude-haiku-4.5") failures.push("worker model mismatch");
  if (!workerViewSucceeded || !pathEqual(toolPath(workerViews[0]), transcript)) failures.push("worker did not make one successful whole-transcript view");
  const viewArgs = toolArguments(workerViews[0] ?? {});
  if (["line_start", "line_end", "start_line", "end_line", "view_range"].some((key) => viewArgs[key] !== undefined)) failures.push("worker used a partial transcript view");
  if (!workerEditSucceeded || !pathEqual(toolPath(workerEdits[0]), ledgerPath)) failures.push("worker did not make one successful ledger edit");
  if (parentViews.length || parentEdits.length) failures.push("parent used view/edit");
  if (allFileStarts.length !== expectedFileStarts.length) failures.push("unexpected file path accessed");
  if (JSON.stringify(candidateFiles) !== JSON.stringify(exactCandidateFiles)) failures.push("candidate root file isolation failed");
  if (!sentinelReplaced) failures.push("sentinel ledger was not replaced");
  if (schemaErrors.length) failures.push("ledger schema invalid");
  if (parentStatus !== expectedStatus || workerStatus !== expectedStatus) failures.push("compact status mismatch");
  if (!schemas.parentCaptured || !schemas.workerCaptured || !schemas.distinctParentAndWorkerBlocks
    || !schemas.workerContainsStructuredView || !schemas.workerContainsBuiltinEdit) {
    failures.push("debug parent/worker Tools schemas missing or incomplete");
  }
  if (warnings.rejected.length) failures.push("fatal unknown-tool warning observed");
  if (usage.parent.models.join(",") !== "gpt-5.6-sol") failures.push("parent usage model mismatch");
  if (usage.worker.models.join(",") !== "claude-haiku-4.5") failures.push("worker usage model mismatch");
  if (unexpectedRows.length) failures.push("unexpected model actor");
  if (usage.total.totalModelTokens === null || usage.total.totalModelTokens > tokenLimit) failures.push("total token ceiling failed");
  if (!Number.isFinite(wallTimeMs) || wallTimeMs > wallTimeLimitMs) failures.push("wall-time ceiling failed");
  if (processResult.status !== 0 || resultEvents.length !== 1
    || (resultEvents[0].sessionId ?? resultEvents[0].data?.sessionId) !== sessionIdFor(run)) failures.push("process/result/session identity failed");
  const score = evaluateLedger({ ledger, gold: readJson(goldPath(run)), transcript: readFileSync(transcriptPath(run), "utf8"), run });
  const operationalFailures = failures.filter((failure) =>
    /process|sentinel|schema|token|wall-time|usage/.test(failure));
  const treatmentFailures = failures.filter((failure) => !operationalFailures.includes(failure));
  return {
    formatVersion: 2,
    protocolId,
    phase: run.phase,
    runId: run.runId,
    transcriptId: run.transcriptId,
    sessionId: sessionIdFor(run),
    startedAt,
    endedAt,
    disposition: failures.length ? "measured-failure" : "success",
    operationalSuccess: operationalFailures.length === 0,
    treatmentAdherent: treatmentFailures.length === 0,
    failureReasons: [...new Set(failures)],
    mechanism: {
      projectSkillLoads: loadedV2Skills.length,
      parentModel: "gpt-5.6-sol",
      taskStarts: taskStarts.length,
      taskToolCallId,
      workerAgentId,
      workerUsageIds: [...workerUsageIds],
      workerAgent: subagentStarts[0]?.data?.agentName ?? null,
      workerModel: subagentStarts[0]?.data?.model ?? null,
      workerStarts: subagentStarts.length,
      workerCompletes: subagentCompletes.length,
    },
    boundary: {
      workerTranscriptViewStarts: workerViews.length,
      workerTranscriptViewCompleted: workerViewSucceeded,
      workerLedgerEditStarts: workerEdits.length,
      workerLedgerEditCompleted: workerEditSucceeded,
      parentViews: parentViews.length,
      parentEdits: parentEdits.length,
      unexpectedFileCalls: allFileStarts.length - expectedFileStarts.length,
      candidateFiles,
      sentinelSha256: sha256(Buffer.from(sentinelText)),
      ledgerSha256: ledgerBytes.length ? sha256(ledgerBytes) : null,
      ledgerBytes: ledgerBytes.length,
      rawEventBytes: stdoutBytes.length,
      stderrDebugBytes: stderrBytes.length,
    },
    debugToolSchemas: schemas,
    unknownToolWarnings: warnings,
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    returnBoundary: { expectedStatus, workerStatus, parentStatus, compact: parentStatus === expectedStatus && workerStatus === expectedStatus },
    isolation: {
      valid: allFileStarts.length === expectedFileStarts.length && parentViews.length === 0 && parentEdits.length === 0
        && JSON.stringify(candidateFiles) === JSON.stringify(exactCandidateFiles),
      candidateHasOnlyFourFiles: JSON.stringify(candidateFiles) === JSON.stringify(exactCandidateFiles),
      limitation: "CLI tool restrictions and context minimization are measured; no independent Windows security boundary is claimed.",
    },
    contextAndUsage: usage,
    timing: { wallTimeMs },
    terminal: { processStatus: processResult.status, processSignal: processResult.signal, resultEventCount: resultEvents.length },
    quality: score,
  };
}

function executeRun(run, profile, index, candidateManifest) {
  const root = materialize(run);
  const capture = {
    runId: run.runId,
    phase: run.phase,
    sessionId: sessionIdFor(run),
    startedAt: new Date().toISOString(),
    disposition: "started",
    transcriptSha256: sha256(readFileSync(resolve(root, "input", "transcript.txt"))),
    candidateFileSetSha256: candidateManifest.fileSetSha256,
  };
  index.captures.push(capture);
  replaceJson(resolve(evidenceRoot, "start-index.json"), index);
  const args = cliArgs(run);
  const result = command("copilot", args, {
    cwd: root,
    timeout: wallTimeLimitMs,
    env: { ...process.env, HOME: profile.profile, USERPROFILE: profile.profile, COPILOT_HOME: profile.home },
  });
  const endedAt = new Date().toISOString();
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  let events = [];
  let ledger = null;
  let usageRows = [];
  const captureFailures = [];
  try { events = parseJsonl(stdout); } catch (error) { captureFailures.push(`JSONL parse: ${error.message}`); }
  try { ledger = readJson(resolve(root, "output", "ledger.json")); } catch (error) { captureFailures.push(`ledger parse: ${error.message}`); }
  try { usageRows = exportUsage(resolve(profile.home, "session-store.db"), sessionIdFor(run)); } catch (error) { captureFailures.push(`usage export: ${error.message}`); }
  let evidence;
  try {
    evidence = analyzeRun({
      run, events, stdoutBytes: stdout, stderrBytes: stderr, processResult: result, usageRows,
      startedAt: capture.startedAt, endedAt, ledger, sentinelBefore: sentinelText,
    });
  } catch (error) {
    evidence = {
      formatVersion: 2, protocolId, phase: run.phase, runId: run.runId, transcriptId: run.transcriptId,
      startedAt: capture.startedAt, endedAt, disposition: "measured-failure", operationalSuccess: false,
      treatmentAdherent: false, failureReasons: [`evidence analysis: ${error.message}`], quality: null,
    };
  }
  evidence.failureReasons = [...new Set([...evidence.failureReasons, ...captureFailures])];
  if (evidence.failureReasons.length) {
    evidence.disposition = "measured-failure";
    evidence.operationalSuccess = false;
    evidence.treatmentAdherent = false;
  }
  evidence.launch = { executable: "copilot", exactArgs: args, cliVersion, environment: { HOME: "<isolated-profile>", USERPROFILE: "<isolated-profile>", COPILOT_HOME: "<isolated-profile>/.copilot" } };
  const output = resolve(evidenceRoot, "runs", run.runId);
  writeOnce(resolve(output, "copilot-events.jsonl"), stdout);
  writeOnce(resolve(output, "copilot-stderr-debug.txt"), stderr);
  writeOnce(resolve(output, "usage.json"), jsonBytes({ formatVersion: 2, sessionId: sessionIdFor(run), source: "isolated assistant_usage_events", rows: usageRows }));
  writeOnce(resolve(output, "run-config.json"), jsonBytes({
    formatVersion: 2,
    protocolId,
    run,
    taskEnvelope: taskEnvelope(run),
    exactCliArgs: args,
    sessionId: sessionIdFor(run),
    transcriptSha256: sha256(readFileSync(resolve(root, "input", "transcript.txt"))),
    candidateFileSetSha256: candidateManifest.fileSetSha256,
    sentinelSha256: sha256(Buffer.from(sentinelText)),
  }));
  if (existsSync(resolve(root, "output", "ledger.json"))) writeOnce(resolve(output, "ledger.json"), readFileSync(resolve(root, "output", "ledger.json")));
  if (evidence.quality) writeOnce(resolve(output, "score.json"), jsonBytes(evidence.quality));
  writeOnce(resolve(output, "run-evidence.json"), jsonBytes(evidence));
  capture.endedAt = endedAt;
  capture.disposition = evidence.disposition;
  replaceJson(resolve(evidenceRoot, "start-index.json"), index);
  return evidence;
}

function freezePilotGate(plan, fixtureManifest, candidateManifest) {
  const pilotRuns = runs.slice(1);
  const gate = {
    formatVersion: 2,
    protocolId,
    frozenAfterPassingDevelopmentBeforePilotStart: true,
    permanentlyExcludedFromConfirmation: true,
    runOrder: pilotRuns.map((run) => run.runId),
    runs: pilotRuns.map((run) => ({
      ...plan.runs.find((entry) => entry.runId === run.runId),
      transcriptSha256: fixtureManifest.fixtures.find((fixture) => fixture.runId === run.runId).transcriptSha256,
      goldSha256: fixtureManifest.fixtures.find((fixture) => fixture.runId === run.runId).goldSha256,
    })),
    candidateFileSetSha256: candidateManifest.fileSetSha256,
    thresholds: plan.thresholds,
    authorizationBoundary: "A GO authorizes only a separate confirmatory preregistration PR.",
  };
  writeOnce(resolve(evidenceRoot, "pilot-gate.json"), jsonBytes(gate));
  return gate;
}

function finalSummary(evidence, developmentPassed) {
  const pilot = evidence.filter((entry) => entry.phase === "excluded-pilot");
  const meanF1 = pilot.length === 3 ? pilot.reduce((sum, entry) => sum + (entry.quality?.tuple?.f1 ?? 0), 0) / 3 : null;
  const passed = developmentPassed
    && pilot.length === 3
    && pilot.every((entry) => entry.operationalSuccess && entry.treatmentAdherent)
    && pilot.every((entry) => entry.boundary?.workerTranscriptViewStarts === 1 && entry.boundary?.workerTranscriptViewCompleted
      && entry.boundary?.workerLedgerEditStarts === 1 && entry.boundary?.workerLedgerEditCompleted)
    && pilot.every((entry) => entry.quality?.unsupportedCriticalActions === 0)
    && pilot.every((entry) => entry.schema?.valid && entry.returnBoundary?.compact && entry.isolation?.valid)
    && pilot.every((entry) => entry.quality?.tuple?.f1 >= 0.75)
    && meanF1 >= 0.85
    && pilot.every((entry) => entry.contextAndUsage?.total?.totalModelTokens <= tokenLimit)
    && pilot.every((entry) => entry.timing?.wallTimeMs <= wallTimeLimitMs);
  return {
    formatVersion: 2,
    protocolId,
    disposition: passed ? "GO" : "NO-GO",
    intentToTreat: true,
    thresholdSoftening: false,
    retries: 0,
    development: { runId: runs[0].runId, passed: developmentPassed, starts: evidence.filter((entry) => entry.runId === runs[0].runId).length, abandonmentRuleFired: !developmentPassed },
    pilot: {
      authorized: developmentPassed,
      starts: pilot.length,
      passed,
      meanTupleF1: meanF1,
      operationalAndTreatmentCount: pilot.filter((entry) => entry.operationalSuccess && entry.treatmentAdherent).length,
      exactOneViewOneEditCount: pilot.filter((entry) =>
        entry.boundary?.workerTranscriptViewStarts === 1 && entry.boundary?.workerTranscriptViewCompleted
        && entry.boundary?.workerLedgerEditStarts === 1 && entry.boundary?.workerLedgerEditCompleted).length,
      validSchemaCompactReturnIsolationCount: pilot.filter((entry) =>
        entry.schema?.valid && entry.returnBoundary?.compact && entry.isolation?.valid).length,
      runs: pilot.map((entry) => ({
        runId: entry.runId,
        operationalSuccess: entry.operationalSuccess,
        treatmentAdherent: entry.treatmentAdherent,
        oneViewOneEdit: entry.boundary?.workerTranscriptViewStarts === 1 && entry.boundary?.workerLedgerEditStarts === 1,
        tupleF1: entry.quality?.tuple?.f1 ?? null,
        unsupportedCriticalActions: entry.quality?.unsupportedCriticalActions ?? null,
        totalModelTokens: entry.contextAndUsage?.total?.totalModelTokens ?? null,
        wallTimeMs: entry.timing?.wallTimeMs ?? null,
        failures: entry.failureReasons,
      })),
    },
    a0ToA3AiRunsExecuted: 0,
    confirmatoryRunsExecuted: 0,
    mainRunsExecuted: 0,
    authorizationBoundary: passed
      ? "Only a separate confirmatory preregistration pull request is authorized."
      : "No confirmatory or main execution is authorized.",
  };
}

function reportText(summary) {
  return [
    "# Action-item extraction v2 feasibility report",
    "",
    `**Status: ${summary.disposition}.**`,
    "",
    `Development passed: ${summary.development.passed}. Excluded pilot starts: ${summary.pilot.starts}; pilot passed: ${summary.pilot.passed}.`,
    "",
    "Immutable v1 remains NO-GO at merge `4900bdde8250292c86d4040d242359359ac050a0` / PR #26.",
    "",
    summary.authorizationBoundary,
    "",
  ].join("\n");
}

function runMain() {
  invariant(process.argv.includes("--execute"), "explicit --execute is required; this command performs live Copilot units");
  invariant(!existsSync(evidenceRoot), "v2 evidence already exists; retries are forbidden");
  invariant(!existsSync(runtimeRoot), "v2 runtime already exists; retries are forbidden");
  const fixtureManifest = readJson(resolve(experimentRoot, "design", "fixture-manifest.json"));
  const plan = readJson(resolve(experimentRoot, "design", "execution-plan.json"));
  const foundationValidation = validateFoundation();
  const candidateManifest = manifestFor(candidateRoot);
  invariant(candidateManifest.fileSetSha256 === fixtureManifest.candidate.fileSetSha256, "candidate differs from freeze");
  invariant(JSON.stringify(plan.runs.map((entry) => entry.exactCliArgs)) === JSON.stringify(runs.map(cliArgs)), "CLI args differ from freeze");
  const help = command("copilot", ["--help"]);
  const version = command("copilot", ["--version"]);
  invariant(help.status === 0 && version.status === 0, "Copilot CLI preflight failed");
  const versionText = version.stdout.toString("utf8").trim();
  invariant(new RegExp(`(?:^|\\D)${cliVersion.replaceAll(".", "\\.")}(?:\\D|$)`, "u").test(versionText), `Copilot CLI must be exactly ${cliVersion}`);
  for (const flag of ["--available-tools", "--allow-all-tools", "--disable-builtin-mcps", "--log-level", "--session-id", "--output-format"]) {
    invariant(help.stdout.toString("utf8").includes(flag), `Copilot CLI lacks ${flag}`);
  }
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const profile = createProfile();
  writeOnce(resolve(evidenceRoot, "preflight.json"), jsonBytes({
    formatVersion: 2, protocolId, completedBeforeStartIndexAndLifecycle: true,
    copilotVersion: versionText, exactGlobalToolFilter: globalToolFilter,
    exactCliArgsHash: sha256(jsonBytes(plan.runs.map((entry) => entry.exactCliArgs))),
    candidateManifest, foundationValidation, controls: profile.settings,
  }));
  writeOnce(resolve(evidenceRoot, "development-gate.json"),
    readFileSync(resolve(experimentRoot, "design", "development-gate.json")));
  const index = { formatVersion: 2, protocolId, durableBeforeAnyLifecycle: true, captures: [] };
  writeOnce(resolve(evidenceRoot, "start-index.json"), jsonBytes(index));
  const evidence = [executeRun(runs[0], profile, index, candidateManifest)];
  const developmentPassed = evidence[0].operationalSuccess && evidence[0].treatmentAdherent;
  if (developmentPassed) {
    freezePilotGate(plan, fixtureManifest, candidateManifest);
    for (const run of runs.slice(1)) evidence.push(executeRun(run, profile, index, candidateManifest));
  }
  const summary = finalSummary(evidence, developmentPassed);
  writeOnce(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
  writeOnce(resolve(evidenceRoot, "report.md"), Buffer.from(reportText(summary), "utf8"));
  writeFileSync(resolve(experimentRoot, "report.md"), reportText(summary));
  writeOnce(resolve(evidenceRoot, "manifest.json"), jsonBytes(evidenceManifest()));
  process.stdout.write(`${summary.disposition}: development=${summary.development.passed}; pilot=${summary.pilot.passed}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runMain();
  } catch (error) {
    if (existsSync(evidenceRoot) && !existsSync(resolve(evidenceRoot, "summary.json"))) {
      const captures = existsSync(resolve(evidenceRoot, "start-index.json"))
        ? readJson(resolve(evidenceRoot, "start-index.json")).captures : [];
      const developmentEvidencePath = resolve(evidenceRoot, "runs", runs[0].runId, "run-evidence.json");
      const developmentPassed = existsSync(developmentEvidencePath)
        && readJson(developmentEvidencePath).operationalSuccess
        && readJson(developmentEvidencePath).treatmentAdherent;
      const pilotCaptures = captures.filter((capture) => capture.phase === "excluded-pilot");
      const summary = {
        formatVersion: 2, protocolId, disposition: "NO-GO", intentToTreat: true,
        development: {
          runId: runs[0].runId,
          passed: Boolean(developmentPassed),
          starts: captures.filter((capture) => capture.runId === runs[0].runId).length,
          abandonmentRuleFired: !developmentPassed,
        },
        pilot: {
          authorized: Boolean(developmentPassed),
          starts: pilotCaptures.length,
          passed: false,
          runs: pilotCaptures.map((capture) => ({ runId: capture.runId, disposition: capture.disposition })),
        },
        a0ToA3AiRunsExecuted: 0, confirmatoryRunsExecuted: 0, mainRunsExecuted: 0,
        harnessFailure: error.message, authorizationBoundary: "No confirmatory or main execution is authorized.",
      };
      writeOnce(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
      writeOnce(resolve(evidenceRoot, "report.md"), Buffer.from(reportText(summary), "utf8"));
      writeFileSync(resolve(experimentRoot, "report.md"), reportText(summary));
      writeOnce(resolve(evidenceRoot, "manifest.json"), jsonBytes(evidenceManifest()));
    }
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
