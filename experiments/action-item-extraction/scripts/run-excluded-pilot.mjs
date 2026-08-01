#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import {
  assert,
  availableTools,
  candidateManifest,
  candidateRoot,
  cliArgs,
  evidenceFileManifest,
  evidenceRoot,
  exactStatus,
  experimentRoot,
  goldPath,
  jsonBytes,
  ledgerSchemaErrors,
  parseEvents,
  protocolId,
  readJson,
  repositoryRoot,
  runCandidateRoot,
  runs,
  runtimeRoot,
  sessionIdFor,
  sha256,
  taskEnvelope,
  tokenLimit,
  toolName,
  toolPath,
  transcriptPath,
  wallTimeLimitMs,
} from "./lib.mjs";

const usageColumns = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "request_multiplier", "duration_ms",
  "time_to_first_token_ms", "inter_token_latency_ms", "initiator", "api_endpoint",
  "reasoning_effort", "finish_reason", "content_filter_triggered",
  "token_details_json", "created_at",
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

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
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
    reasoningTokens: sum(rows, "reasoning_tokens"),
    modelTokens: rows.every((row) => Number.isFinite(row.input_tokens) && Number.isFinite(row.output_tokens))
      ? rows.reduce((total, row) => total + row.input_tokens + row.output_tokens, 0)
      : null,
    nanoAiu: sum(rows, "total_nano_aiu"),
    activeTimeMs: sum(rows, "duration_ms"),
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  };
}

function exportUsage(database, sessionId) {
  assert(existsSync(database), "isolated session store is missing");
  const query = `SELECT ${usageColumns.join(", ")} FROM assistant_usage_events WHERE session_id = ? ORDER BY id`;
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "db.row_factory = sqlite3.Row",
    `rows = [dict(row) for row in db.execute(${JSON.stringify(query)}, (sys.argv[2],))]`,
    "print(json.dumps(rows, separators=(',', ':')))",
  ].join("\n");
  for (const [command, ...prefix] of process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]]) {
    const result = runCommand(command, [...prefix, "-c", script, database, sessionId], { encoding: "utf8" });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  }
  throw new Error("exact-session usage export failed");
}

function createProfile() {
  const profile = resolve(runtimeRoot, "profile");
  const copilotHome = resolve(profile, ".copilot");
  mkdirSync(copilotHome, { recursive: true });
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
  writeOnce(resolve(copilotHome, "settings.json"), jsonBytes(settings));
  return { profile, copilotHome, settings };
}

function materialize(run) {
  const root = runCandidateRoot(run);
  assert(!existsSync(root), `${run.runId} candidate root already exists; retries are forbidden`);
  mkdirSync(resolve(root, ".github", "skills", "action-item-extraction"), { recursive: true });
  mkdirSync(resolve(root, ".github", "agents"), { recursive: true });
  mkdirSync(resolve(root, "input"), { recursive: true });
  mkdirSync(resolve(root, "output"), { recursive: true });
  copyFileSync(
    resolve(candidateRoot, ".github", "skills", "action-item-extraction", "SKILL.md"),
    resolve(root, ".github", "skills", "action-item-extraction", "SKILL.md"),
  );
  copyFileSync(
    resolve(candidateRoot, ".github", "agents", "action-item-haiku.agent.md"),
    resolve(root, ".github", "agents", "action-item-haiku.agent.md"),
  );
  copyFileSync(transcriptPath(run), resolve(root, "input", "transcript.txt"));
  const files = [
    resolve(root, ".github", "skills", "action-item-extraction", "SKILL.md"),
    resolve(root, ".github", "agents", "action-item-haiku.agent.md"),
    resolve(root, "input", "transcript.txt"),
  ];
  assert(files.every(existsSync), `${run.runId} candidate materialization is incomplete`);
  assert(readdirSync(resolve(root, "output")).length === 0, `${run.runId} output is not empty`);
  return root;
}

function exactToolCompletion(start, completes) {
  return completes.find((event) =>
    event.data?.toolCallId === start?.data?.toolCallId && event.data?.success === true);
}

function pathEquals(left, right) {
  if (typeof left !== "string") return false;
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function deriveEvidence({ run, events, rawBytes, stderrBytes, processResult, usageRows, startedAt, endedAt, ledger }) {
  const failures = [];
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completes = events.filter((event) => event.type === "tool.execution_complete");
  const skillStarts = starts.filter((event) =>
    toolName(event) === "skill" && event.data?.arguments?.skill === "action-item-extraction");
  const taskStarts = starts.filter((event) => toolName(event) === "task");
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const workerCallId = subagentStarts[0]?.data?.toolCallId ?? subagentStarts[0]?.agentId ?? null;
  const transcript = resolve(runCandidateRoot(run), "input", "transcript.txt");
  const ledgerPath = resolve(runCandidateRoot(run), "output", "ledger.json");
  const reads = starts.filter((event) => toolName(event) === "read");
  const edits = starts.filter((event) => toolName(event) === "edit");
  const workerReads = reads.filter((event) => event.agentId === workerCallId);
  const workerEdits = edits.filter((event) => event.agentId === workerCallId);
  const parentReads = reads.filter((event) => !event.agentId);
  const parentEdits = edits.filter((event) => !event.agentId);
  const workerReadComplete = exactToolCompletion(workerReads[0], completes);
  const workerEditComplete = exactToolCompletion(workerEdits[0], completes);
  const unknownToolWarnings = events.filter((event) =>
    /unknown tool name in the tool allowlist/iu.test(event.data?.message ?? ""));
  if (skillStarts.length !== 1) failures.push("Skill start count is not exactly one");
  if (taskStarts.length !== 1) failures.push("delegation task count is not exactly one");
  if (subagentStarts.length !== 1 || subagentCompletes.length !== 1) {
    failures.push("custom-agent lifecycle is not exactly one start and one complete");
  }
  if (subagentStarts[0]?.data?.agentName !== "action-item-haiku") failures.push("worker agent mismatch");
  if (subagentStarts[0]?.data?.model !== "claude-haiku-4.5") failures.push("worker model mismatch");
  if (unknownToolWarnings.length !== 0) failures.push("unknown-tool warnings were emitted");
  if (workerReads.length !== 1 || !pathEquals(toolPath(workerReads[0]), transcript) || !workerReadComplete) {
    failures.push("worker transcript read is not exactly one successful structured call");
  }
  const readArgs = workerReads[0]?.data?.arguments ?? {};
  if (readArgs.line_start !== undefined || readArgs.line_end !== undefined
    || readArgs.start_line !== undefined || readArgs.end_line !== undefined) {
    failures.push("worker transcript read used a partial range");
  }
  if (workerEdits.length !== 1 || !pathEquals(toolPath(workerEdits[0]), ledgerPath) || !workerEditComplete) {
    failures.push("worker ledger edit is not exactly one successful structured call");
  }
  if (parentReads.some((event) => pathEquals(toolPath(event), transcript))) failures.push("parent read transcript");
  if (parentEdits.some((event) => pathEquals(toolPath(event), ledgerPath))) failures.push("parent edited ledger");
  if (parentReads.length !== 0 || parentEdits.length !== 0) failures.push("parent used a file tool");
  const otherFileAccesses = [...reads, ...edits].filter((event) => {
    const path = toolPath(event);
    return !(toolName(event) === "read" && pathEquals(path, transcript))
      && !(toolName(event) === "edit" && pathEquals(path, ledgerPath));
  });
  if (otherFileAccesses.length !== 0) failures.push("unexpected file path accessed");
  const observedToolNames = [...new Set(starts.map(toolName).filter(Boolean))].sort();
  if (observedToolNames.some((name) => !availableTools.includes(name))) failures.push("unexpected tool invoked");
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  if (schemaErrors.length !== 0) failures.push("ledger schema invalid");
  const parentMessages = events.filter((event) =>
    event.type === "assistant.message" && !event.agentId && event.data?.content?.trim());
  const workerMessages = events.filter((event) =>
    event.type === "assistant.message" && event.agentId === workerCallId && event.data?.content?.trim());
  const itemCount = Array.isArray(ledger?.items) ? ledger.items.length : 0;
  const parentStatus = exactStatus(parentMessages.at(-1)?.data?.content, run, ledgerPath, itemCount);
  const workerStatus = exactStatus(workerMessages.at(-1)?.data?.content, run, ledgerPath, itemCount);
  if (!parentStatus || !workerStatus || parentStatus !== workerStatus) failures.push("compact return mismatch");
  const agentSurface = events.filter((event) => event.type === "session.custom_agents_updated").at(-1)?.data ?? {};
  const agent = agentSurface.agents?.find((entry) => entry.name === "action-item-haiku");
  if (agentSurface.errors?.length || agentSurface.warnings?.length || !agent
    || JSON.stringify(agent.tools) !== JSON.stringify(["read", "edit"])) {
    failures.push("custom-agent surface mismatch");
  }
  const loadedSkills = events.filter((event) => event.type === "session.skills_loaded").at(-1)?.data?.skills ?? [];
  const skill = loadedSkills.find((entry) => entry.name === "action-item-extraction");
  if (!skill || skill.source !== "project") failures.push("project Skill was not loaded");
  const parentRows = usageRows.filter((row) => row.agent_id === null);
  const workerRows = usageRows.filter((row) => row.agent_id === workerCallId);
  const unexpectedRows = usageRows.filter((row) => row.agent_id !== null && row.agent_id !== workerCallId);
  const parentUsage = usageFor(parentRows);
  const workerUsage = usageFor(workerRows);
  const totalUsage = usageFor(usageRows);
  if (JSON.stringify(parentUsage.models) !== JSON.stringify(["gpt-5.6-sol"])) failures.push("parent model usage mismatch");
  if (JSON.stringify(workerUsage.models) !== JSON.stringify(["claude-haiku-4.5"])) failures.push("worker model usage mismatch");
  if (unexpectedRows.length !== 0) failures.push("unexpected model actor");
  if (totalUsage.modelTokens === null || totalUsage.modelTokens > tokenLimit) failures.push("total model-token ceiling failed");
  const wallTimeMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(wallTimeMs) || wallTimeMs > wallTimeLimitMs) failures.push("wall-time ceiling failed");
  const results = events.filter((event) => event.type === "result");
  if (processResult.status !== 0 || results.length !== 1 || results[0]?.exitCode !== 0
    || results[0]?.sessionId !== sessionIdFor(run)) {
    failures.push("terminal process/session identity failed");
  }
  if (stderrBytes.length !== 0) failures.push("Copilot emitted stderr");
  const evaluation = evaluateLedger({
    ledger,
    gold: readJson(goldPath(run)),
    transcript: readFileSync(transcriptPath(run), "utf8"),
    run,
  });
  return {
    formatVersion: 1,
    protocolId,
    phase: run.phase,
    permanentlyExcludedFromConfirmation: true,
    runId: run.runId,
    transcriptId: run.transcriptId,
    sessionId: sessionIdFor(run),
    startedAt,
    endedAt,
    disposition: failures.length === 0 ? "success" : "measured-failure",
    operationalSuccess: failures.length === 0,
    treatmentAdherent: failures.length === 0,
    failureReasons: [...new Set(failures)],
    mechanism: {
      parentModel: "gpt-5.6-sol",
      workerAgent: subagentStarts[0]?.data?.agentName ?? null,
      workerModel: subagentStarts[0]?.data?.model ?? null,
      workerCallId,
      skillStarts: skillStarts.length,
      taskStarts: taskStarts.length,
      customAgentStarts: subagentStarts.length,
      customAgentCompletes: subagentCompletes.length,
    },
    boundary: {
      workerTranscriptReads: workerReads.length,
      workerLedgerEdits: workerEdits.length,
      parentReads: parentReads.length,
      parentEdits: parentEdits.length,
      unexpectedFileAccesses: otherFileAccesses.map((event) => ({ tool: toolName(event), path: toolPath(event) })),
      observedToolNames,
      unknownToolWarnings: unknownToolWarnings.map((event) => event.data?.message),
      candidateRoot: runCandidateRoot(run),
      transcriptSha256: sha256(readFileSync(transcript)),
      ledgerSha256: existsSync(ledgerPath) ? sha256(readFileSync(ledgerPath)) : null,
      ledgerBytes: existsSync(ledgerPath) ? readFileSync(ledgerPath).length : null,
      rawEventBytes: rawBytes.length,
    },
    loadedSurfaces: {
      skills: loadedSkills,
      customAgents: agentSurface,
      mcpServers: [...new Set(events
        .filter((event) => event.type === "session.mcp_server_status_changed")
        .map((event) => event.data?.serverName)
        .filter(Boolean))],
    },
    isolation: {
      forbiddenRootAccesses: otherFileAccesses.filter((event) => {
        const path = toolPath(event)?.toLowerCase() ?? "";
        return [repositoryRoot, evidenceRoot, resolve(experimentRoot, "evaluator")]
          .some((root) => path.startsWith(root.toLowerCase()));
      }).length,
      toolRestrictionAndContextMinimizationOnly: true,
      complianceClaimed: false,
      limitation: "Built-in read/edit path controls on Windows are best-effort CLI controls, not an independently enforced security boundary.",
    },
    returnBoundary: { parentStatus, workerStatus, expectedItemCount: itemCount },
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    usage: { parent: parentUsage, worker: workerUsage, unexpectedActors: usageFor(unexpectedRows), total: totalUsage },
    timing: { wallTimeMs },
    terminal: {
      processStatus: processResult.status,
      processSignal: processResult.signal,
      resultEventCount: results.length,
      resultSessionId: results[0]?.sessionId ?? null,
      resultExitCode: results[0]?.exitCode ?? null,
    },
    quality: evaluation,
  };
}

function executeRun(run, profile, startIndex, candidate) {
  const root = materialize(run);
  const transcriptBytes = readFileSync(resolve(root, "input", "transcript.txt"));
  const capture = {
    phase: run.phase,
    runId: run.runId,
    transcriptId: run.transcriptId,
    sessionId: sessionIdFor(run),
    startedAt: new Date().toISOString(),
    disposition: "started",
    transcriptSha256: sha256(transcriptBytes),
    candidateFileSetSha256: candidate.fileSetSha256,
    taskEnvelopeSha256: sha256(Buffer.from(JSON.stringify(taskEnvelope(run)), "utf8")),
  };
  startIndex.captures.push(capture);
  replaceJson(resolve(evidenceRoot, "start-index.json"), startIndex);
  const args = cliArgs(run);
  const env = {
    ...process.env,
    HOME: profile.profile,
    USERPROFILE: profile.profile,
    COPILOT_HOME: profile.copilotHome,
  };
  const result = runCommand("copilot", args, {
    cwd: root,
    timeout: wallTimeLimitMs,
    env,
  });
  const endedAt = new Date().toISOString();
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  let events = [];
  let parseFailure = null;
  try {
    events = parseEvents(stdout);
  } catch (error) {
    parseFailure = error.message;
  }
  let ledger = null;
  let ledgerFailure = null;
  const ledgerPath = resolve(root, "output", "ledger.json");
  try {
    ledger = readJson(ledgerPath);
  } catch (error) {
    ledgerFailure = error.message;
  }
  let usageRows = [];
  let usageFailure = null;
  try {
    usageRows = exportUsage(resolve(profile.copilotHome, "session-store.db"), sessionIdFor(run));
  } catch (error) {
    usageFailure = error.message;
  }
  let evidence;
  try {
    evidence = deriveEvidence({
      run,
      events,
      rawBytes: stdout,
      stderrBytes: stderr,
      processResult: result,
      usageRows,
      startedAt: capture.startedAt,
      endedAt,
      ledger,
    });
  } catch (error) {
    evidence = {
      formatVersion: 1,
      protocolId,
      phase: run.phase,
      permanentlyExcludedFromConfirmation: true,
      runId: run.runId,
      transcriptId: run.transcriptId,
      sessionId: sessionIdFor(run),
      startedAt: capture.startedAt,
      endedAt,
      disposition: "measured-failure",
      operationalSuccess: false,
      treatmentAdherent: false,
      failureReasons: [`evidence derivation failed: ${error.message}`],
      quality: null,
    };
  }
  if (parseFailure) evidence.failureReasons.push(`event parse failed: ${parseFailure}`);
  if (ledgerFailure) evidence.failureReasons.push(`ledger read failed: ${ledgerFailure}`);
  if (usageFailure) evidence.failureReasons.push(`usage export failed: ${usageFailure}`);
  evidence.failureReasons = [...new Set(evidence.failureReasons)];
  if (evidence.failureReasons.length !== 0) {
    evidence.disposition = "measured-failure";
    evidence.operationalSuccess = false;
    evidence.treatmentAdherent = false;
  }
  evidence.launch = {
    executable: "copilot",
    args,
    environment: {
      HOME: "<isolated-profile>",
      USERPROFILE: "<isolated-profile>",
      COPILOT_HOME: "<isolated-profile>/.copilot",
    },
  };
  const runEvidenceRoot = resolve(evidenceRoot, "runs", run.runId);
  writeOnce(resolve(runEvidenceRoot, "copilot-events.jsonl"), stdout);
  writeOnce(resolve(runEvidenceRoot, "copilot-stderr.txt"), stderr);
  writeOnce(resolve(runEvidenceRoot, "run-evidence.json"), jsonBytes(evidence));
  writeOnce(resolve(runEvidenceRoot, "usage.json"), jsonBytes({
    formatVersion: 1,
    source: "isolated COPILOT_HOME assistant_usage_events",
    sessionId: sessionIdFor(run),
    rows: usageRows,
    error: usageFailure,
  }));
  writeOnce(resolve(runEvidenceRoot, "run-config.json"), jsonBytes({
    formatVersion: 1,
    protocolId,
    run,
    candidateRoot: root,
    transcriptSha256: sha256(transcriptBytes),
    taskEnvelope: taskEnvelope(run),
    taskEnvelopeSha256: capture.taskEnvelopeSha256,
    exactCliArgs: args,
  }));
  if (existsSync(ledgerPath)) writeOnce(resolve(runEvidenceRoot, "ledger.json"), readFileSync(ledgerPath));
  if (evidence.quality) writeOnce(resolve(runEvidenceRoot, "score.json"), jsonBytes(evidence.quality));
  capture.endedAt = endedAt;
  capture.disposition = evidence.disposition;
  replaceJson(resolve(evidenceRoot, "start-index.json"), startIndex);
  return evidence;
}

function freezePilotGate(candidate) {
  const pilotRuns = runs.slice(1);
  const gate = {
    formatVersion: 1,
    protocolId,
    phase: "excluded-pilot",
    permanentlyExcludedFromConfirmation: true,
    frozenAfterPassingSmokeAndBeforeAnyPilotStart: true,
    runOrder: pilotRuns.map((run) => run.runId),
    runs: pilotRuns.map((run) => ({
      runId: run.runId,
      transcriptId: run.transcriptId,
      transcriptSha256: sha256(readFileSync(transcriptPath(run))),
      sessionId: sessionIdFor(run),
      taskEnvelope: taskEnvelope(run),
      exactCliArgs: cliArgs(run),
    })),
    candidateFileSetSha256: candidate.fileSetSha256,
    thresholds: {
      operationalAndAdherent: "3/3",
      exactOneReadOneWrite: "3/3",
      unsupportedCriticalActionsMaximum: 0,
      validSchemaCompactReturnIsolation: "3/3",
      meanTupleF1Minimum: 0.85,
      perRunTupleF1Minimum: 0.75,
      perRunTotalModelTokensMaximum: tokenLimit,
      perRunWallTimeMsMaximum: wallTimeLimitMs,
    },
    authorizationBoundary: "GO authorizes only a separate confirmatory preregistration pull request, never main execution.",
  };
  writeOnce(resolve(evidenceRoot, "pilot-gate.json"), jsonBytes(gate));
  return gate;
}

function finalize(runEvidence, smokePassed) {
  const pilot = runEvidence.filter((entry) => entry.phase === "excluded-pilot");
  const meanF1 = pilot.length === 0
    ? null
    : pilot.reduce((sumValue, entry) => sumValue + (entry.quality?.tuple?.f1 ?? 0), 0) / pilot.length;
  const pilotPassed = smokePassed
    && pilot.length === 3
    && pilot.every((entry) => entry.operationalSuccess && entry.treatmentAdherent)
    && pilot.every((entry) => entry.boundary?.workerTranscriptReads === 1 && entry.boundary?.workerLedgerEdits === 1)
    && pilot.every((entry) => entry.quality?.unsupportedCriticalActions === 0)
    && pilot.every((entry) => entry.schema?.valid && entry.returnBoundary?.parentStatus && entry.isolation?.forbiddenRootAccesses === 0)
    && pilot.every((entry) => entry.quality?.tuple?.f1 >= 0.75)
    && meanF1 >= 0.85
    && pilot.every((entry) => entry.usage?.total?.modelTokens <= tokenLimit)
    && pilot.every((entry) => entry.timing?.wallTimeMs <= wallTimeLimitMs);
  const summary = {
    formatVersion: 1,
    protocolId,
    permanentlyExcludedFromConfirmation: true,
    disposition: pilotPassed ? "GO" : "NO-GO",
    smoke: {
      runId: runs[0].runId,
      passed: smokePassed,
      abandonmentRuleFired: !smokePassed,
      evidence: runEvidence[0] ?? null,
    },
    pilot: {
      authorized: smokePassed,
      starts: pilot.length,
      passed: pilotPassed,
      meanTupleF1: meanF1,
      runs: pilot.map((entry) => ({
        runId: entry.runId,
        operationalSuccess: entry.operationalSuccess,
        treatmentAdherent: entry.treatmentAdherent,
        tupleF1: entry.quality?.tuple?.f1 ?? null,
        unsupportedCriticalActions: entry.quality?.unsupportedCriticalActions ?? null,
        totalModelTokens: entry.usage?.total?.modelTokens ?? null,
        wallTimeMs: entry.timing?.wallTimeMs ?? null,
        workerTranscriptReads: entry.boundary?.workerTranscriptReads ?? null,
        workerLedgerEdits: entry.boundary?.workerLedgerEdits ?? null,
        failureReasons: entry.failureReasons,
      })),
    },
    confirmationRunsExecuted: 0,
    mainRunsExecuted: 0,
    authorizationBoundary: pilotPassed
      ? "Only a separate confirmatory preregistration pull request is authorized."
      : "No confirmatory or main execution is authorized.",
    limitations: [
      "Synthetic excluded inputs do not estimate production performance.",
      "Local evidence is unsigned.",
      "Tool restriction and context minimization are measured; security or compliance isolation is not claimed.",
      "Blinded usefulness and clarity review is deferred to confirmation.",
    ],
  };
  writeOnce(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
  writeOnce(resolve(evidenceRoot, "manifest.json"), jsonBytes(evidenceFileManifest(evidenceRoot)));
  return summary;
}

function main() {
  assert(process.argv.includes("--execute"), "explicit --execute is required");
  assert(!existsSync(evidenceRoot), "excluded-pilot evidence already exists; retries are forbidden");
  assert(!existsSync(runtimeRoot), "runtime root already exists; retries are forbidden");
  const gate = readJson(resolve(experimentRoot, "design", "development-gate.json"));
  const candidate = candidateManifest();
  assert(gate.candidateFileSetSha256 === candidate.fileSetSha256, "candidate differs from frozen smoke gate");
  assert(JSON.stringify(gate.exactCliArgs) === JSON.stringify(cliArgs(runs[0])), "CLI args differ from frozen smoke gate");
  const help = runCommand("copilot", ["--help"]);
  assert(help.status === 0, "copilot --help failed");
  for (const flag of ["--available-tools", "--session-id", "--model", "--output-format", "--disallow-temp-dir"]) {
    assert(help.stdout.toString("utf8").includes(flag), `current CLI lacks ${flag}`);
  }
  const version = runCommand("copilot", ["--version"]);
  assert(version.status === 0, "copilot --version failed");
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const profile = createProfile();
  writeOnce(resolve(evidenceRoot, "preflight.json"), jsonBytes({
    formatVersion: 1,
    protocolId,
    completedBeforeAnyLifecycleMarker: true,
    copilotVersion: version.stdout.toString("utf8").trim(),
    exactToolFilter: availableTools,
    candidateManifest: candidate,
    candidateRootLocation: runtimeRoot,
    candidateRootOutsideExperimentTree: !runtimeRoot.toLowerCase().startsWith(experimentRoot.toLowerCase()),
    loadedSurfacePlan: {
      projectSkills: ["action-item-extraction"],
      projectAgents: [{ name: "action-item-haiku", model: "claude-haiku-4.5", tools: ["read", "edit"] }],
      builtInMcpDisabled: true,
      customMcpServers: [],
    },
    controls: profile.settings,
    limitations: [
      "Current CLI options are used without invented container isolation.",
      "Built-in read/edit controls on Windows are best-effort CLI restrictions.",
      "Token ceilings are evaluated after each model call/session rather than enforced as a hard token interrupt.",
    ],
  }));
  const startIndex = { formatVersion: 1, protocolId, captures: [] };
  writeOnce(resolve(evidenceRoot, "start-index.json"), jsonBytes(startIndex));
  const evidence = [];
  const smoke = executeRun(runs[0], profile, startIndex, candidate);
  evidence.push(smoke);
  const smokePassed = smoke.operationalSuccess && smoke.treatmentAdherent;
  if (smokePassed) {
    freezePilotGate(candidate);
    for (const run of runs.slice(1)) evidence.push(executeRun(run, profile, startIndex, candidate));
  }
  const summary = finalize(evidence, smokePassed);
  process.stdout.write(`${summary.disposition}: smoke=${summary.smoke.passed}; pilot=${summary.pilot.passed}\n`);
}

try {
  main();
} catch (error) {
  if (existsSync(evidenceRoot) && !existsSync(resolve(evidenceRoot, "summary.json"))) {
    writeOnce(resolve(evidenceRoot, "harness-failure.json"), jsonBytes({
      formatVersion: 1,
      protocolId,
      disposition: "NO-GO",
      error: error.message,
      confirmationRunsExecuted: 0,
      mainRunsExecuted: 0,
    }));
    writeOnce(resolve(evidenceRoot, "manifest.json"), jsonBytes(evidenceFileManifest(evidenceRoot)));
  }
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
