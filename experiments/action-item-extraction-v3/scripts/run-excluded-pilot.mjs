#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import {
  inspectToolEvents,
  summarizeEvidence,
  summarizeUsage,
  warningRuleEvidence,
} from "./evidence.mjs";
import { reportText } from "./generate-report.mjs";
import {
  candidateRoot,
  cliArgs,
  cliVersion,
  evidenceManifest,
  evidenceRoot,
  expectedCompactStatus,
  filesUnder,
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
  transcriptPath,
  wallTimeLimitMs,
} from "./lib.mjs";
import { validateFoundation } from "./validate-foundation.mjs";

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

export function parseCliVersion(output) {
  return String(output).match(/(?:GitHub Copilot CLI\s+)?(\d+\.\d+\.\d+)(?:\.|\s|$)/u)?.[1] ?? null;
}

function createProfile() {
  const profile = resolve(runtimeRoot, "profile");
  const home = resolve(profile, ".copilot");
  mkdirSync(home, { recursive: true });
  writeOnce(resolve(home, "settings.json"), jsonBytes({
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
          deniedPaths: [repositoryRoot, evidenceRoot, resolve(repositoryRoot, "experiments", "action-item-extraction-v3", "evaluator")],
          clearPolicyOnExit: true,
        },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    },
  }));
  return { profile, home };
}

function materialize(run) {
  const root = runCandidateRoot(run);
  invariant(!existsSync(root), `${run.runId} runtime already exists; retries are forbidden`);
  const files = [
    [resolve(candidateRoot, ".github", "skills", "action-ledger-v3", "SKILL.md"), resolve(root, ".github", "skills", "action-ledger-v3", "SKILL.md")],
    [resolve(candidateRoot, ".github", "agents", "action-ledger-v3-haiku.agent.md"), resolve(root, ".github", "agents", "action-ledger-v3-haiku.agent.md")],
    [transcriptPath(run), resolve(root, "input", "transcript.txt")],
  ];
  for (const [source, destination] of files) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  writeOnce(resolve(root, "output", "ledger.json"), Buffer.from(sentinelText, "utf8"));
  const expected = [
    ".github/agents/action-ledger-v3-haiku.agent.md",
    ".github/skills/action-ledger-v3/SKILL.md",
    "input/transcript.txt",
    "output/ledger.json",
  ];
  const actual = filesUnder(root).map((path) => posixRelative(root, path));
  invariant(JSON.stringify(actual) === JSON.stringify(expected), "candidate layout is not exact");
  return root;
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
  for (const [executable, ...prefix] of [["python"], ["py", "-3"]]) {
    const result = command(executable, [...prefix, "-c", script, database, sessionId], { encoding: "utf8" });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  }
  throw new Error("exact-session usage export failed");
}

function finalMessage(events, agentId) {
  return events.filter((event) => event.type === "assistant.message" && (event.agentId ?? null) === agentId)
    .map((event) => event.data?.content ?? event.content)
    .filter((content) => typeof content === "string" && content.trim()).at(-1)?.trim() ?? null;
}

export function analyzeRun({
  run,
  events,
  stderrText,
  ledger,
  ledgerBytes: suppliedLedgerBytes,
  usageRows,
  startedAt,
  endedAt,
  processResult,
  candidateFiles,
}) {
  const failures = [];
  const tools = inspectToolEvents(events, run);
  const ledgerPath = resolve(runCandidateRoot(run), "output", "ledger.json");
  const ledgerBytes = suppliedLedgerBytes ?? (existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.alloc(0));
  const sentinelReplaced = ledgerBytes.length > 0
    && ledgerBytes.toString("utf8") !== sentinelText
    && !ledgerBytes.toString("utf8").includes("ACTION_ITEM_EXTRACTION_V3_REPLACE_ME");
  const warningRule = warningRuleEvidence({ events, stderrText, ledger, sentinelReplaced, run, usageRows });
  const usage = summarizeUsage(usageRows);
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  const itemCount = Array.isArray(ledger?.items) ? ledger.items.length : 0;
  const expectedStatus = expectedCompactStatus(run, itemCount);
  const workerStatus = finalMessage(events, tools.workerAgentId);
  const parentStatus = finalMessage(events, null);
  const wallTimeMs = Date.parse(endedAt) - Date.parse(startedAt);
  const score = evaluateLedger({
    ledger,
    gold: readJson(goldPath(run)),
    transcript: readFileSync(transcriptPath(run), "utf8"),
    run,
  });
  if (!warningRule.accepted) failures.push("prospective warning rule failed");
  if (!score.ambiguity.completeAndExactlyGrounded) failures.push("ambiguity policy failed");
  if (schemaErrors.length) failures.push("ledger schema invalid");
  if (!usage.settled) failures.push("usage did not settle");
  if (usage.models.sort().join(",") !== "claude-haiku-4.5,gpt-5.6-sol") failures.push("actor model set mismatch");
  if (usage.totalModelTokens === null || usage.totalModelTokens > tokenLimit) failures.push("total token ceiling failed");
  if (!Number.isFinite(wallTimeMs) || wallTimeMs > wallTimeLimitMs) failures.push("wall-time ceiling failed");
  if (processResult.status !== 0) failures.push("process failed");
  if (workerStatus !== expectedStatus || parentStatus !== expectedStatus) failures.push("compact return mismatch");
  const expectedFiles = [
    ".github/agents/action-ledger-v3-haiku.agent.md",
    ".github/skills/action-ledger-v3/SKILL.md",
    "input/transcript.txt",
    "output/ledger.json",
  ];
  const isolated = JSON.stringify(candidateFiles) === JSON.stringify(expectedFiles);
  if (!isolated) failures.push("candidate isolation failed");
  return {
    formatVersion: 3,
    protocolId,
    runId: run.runId,
    sessionId: sessionIdFor(run),
    intentToTreat: true,
    startedAt,
    endedAt,
    disposition: failures.length ? "measured-failure" : "success",
    operationalSuccess: processResult.status === 0 && sentinelReplaced && schemaErrors.length === 0 && usage.settled,
    treatmentAdherent: warningRule.accepted && isolated && parentStatus === expectedStatus && workerStatus === expectedStatus,
    failureReasons: failures,
    mechanism: warningRule,
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    returnBoundary: { expectedStatus, workerStatus, parentStatus, compact: workerStatus === expectedStatus && parentStatus === expectedStatus },
    isolation: { valid: isolated, candidateFiles },
    usage,
    timing: { wallTimeMs },
    quality: score,
  };
}

function executeRun(run, profile, index, candidateManifest) {
  const root = materialize(run);
  const capture = {
    order: run.order,
    runId: run.runId,
    sessionId: sessionIdFor(run),
    startedAt: new Date().toISOString(),
    disposition: "started",
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
  const output = resolve(evidenceRoot, "runs", run.runId);
  const captureFailures = [];
  let events = [];
  let ledger = null;
  let usageRows = [];
  const ledgerBytes = existsSync(resolve(root, "output", "ledger.json"))
    ? readFileSync(resolve(root, "output", "ledger.json"))
    : Buffer.alloc(0);
  const candidateFiles = filesUnder(root).map((path) => posixRelative(root, path));
  try { events = parseJsonl(stdout); } catch (error) { captureFailures.push(`JSONL parse: ${error.message}`); }
  try { ledger = readJson(resolve(root, "output", "ledger.json")); } catch (error) { captureFailures.push(`ledger parse: ${error.message}`); }
  try { usageRows = exportUsage(resolve(profile.home, "session-store.db"), sessionIdFor(run)); } catch (error) { captureFailures.push(`usage export: ${error.message}`); }
  let evidence;
  try {
    evidence = analyzeRun({
      run,
      events,
      stderrText: stderr.toString("utf8"),
      ledger,
      ledgerBytes,
      usageRows,
      startedAt: capture.startedAt,
      endedAt,
      processResult: result,
      candidateFiles,
    });
  } catch (error) {
    evidence = {
      formatVersion: 3,
      protocolId,
      runId: run.runId,
      sessionId: sessionIdFor(run),
      intentToTreat: true,
      startedAt: capture.startedAt,
      endedAt,
      disposition: "measured-failure",
      operationalSuccess: false,
      treatmentAdherent: false,
      failureReasons: [`evidence analysis: ${error.message}`],
      quality: null,
    };
  }
  evidence.failureReasons = [...new Set([...evidence.failureReasons, ...captureFailures])];
  if (evidence.failureReasons.length) {
    evidence.disposition = "measured-failure";
    evidence.operationalSuccess = false;
    evidence.treatmentAdherent = false;
  }
  writeOnce(resolve(output, "copilot-events.jsonl"), stdout);
  writeOnce(resolve(output, "copilot-stderr-debug.txt"), stderr);
  writeOnce(resolve(output, "usage.json"), jsonBytes({ formatVersion: 3, sessionId: sessionIdFor(run), rows: usageRows }));
  writeOnce(resolve(output, "run-config.json"), jsonBytes({
    formatVersion: 3,
    protocolId,
    run,
    sessionId: sessionIdFor(run),
    taskEnvelope: taskEnvelope(run),
    exactCliArgs: args,
    candidateFileSetSha256: candidateManifest.fileSetSha256,
  }));
  writeOnce(resolve(output, "process.json"), jsonBytes({
    formatVersion: 3,
    protocolId,
    runId: run.runId,
    sessionId: sessionIdFor(run),
    startedAt: capture.startedAt,
    endedAt,
    processStatus: result.status,
    processSignal: result.signal,
    candidateFiles,
    captureFailures,
  }));
  if (existsSync(resolve(root, "output", "ledger.json"))) writeOnce(resolve(output, "ledger.json"), readFileSync(resolve(root, "output", "ledger.json")));
  if (evidence.quality) writeOnce(resolve(output, "score.json"), jsonBytes(evidence.quality));
  writeOnce(resolve(output, "run-evidence.json"), jsonBytes(evidence));
  capture.endedAt = endedAt;
  capture.disposition = evidence.disposition;
  replaceJson(resolve(evidenceRoot, "start-index.json"), index);
  return evidence;
}

export function runExcludedPilot() {
  invariant(process.argv.includes("--execute"), "Design-only guard: pass --execute only after merge and explicit operator authorization.");
  validateFoundation();
  invariant(!existsSync(evidenceRoot), "v3 evidence root already exists; retries are forbidden");
  invariant(!existsSync(runtimeRoot), "v3 runtime root already exists; retries are forbidden");
  const version = command("copilot", ["--version"], { encoding: "utf8" });
  const versionOutput = version.stdout ?? "";
  invariant(version.status === 0 && parseCliVersion(versionOutput) === cliVersion, `Copilot CLI must be exactly ${cliVersion}`);
  const candidateManifest = manifestFor(candidateRoot);
  const profile = createProfile();
  mkdirSync(evidenceRoot, { recursive: true });
  writeOnce(resolve(evidenceRoot, "preflight.json"), jsonBytes({
    formatVersion: 3,
    protocolId,
    frozenFoundationValidated: true,
    cliVersion,
    cliVersionOutput: versionOutput.trim(),
    runOrder: runs.map((run) => run.runId),
    candidateFileSetSha256: candidateManifest.fileSetSha256,
    startedAt: new Date().toISOString(),
  }));
  const index = {
    formatVersion: 3,
    protocolId,
    intentToTreat: true,
    noRetries: true,
    runOrder: runs.map((run) => run.runId),
    captures: [],
  };
  writeOnce(resolve(evidenceRoot, "start-index.json"), jsonBytes(index));
  const evidence = runs.map((run) => executeRun(run, profile, index, candidateManifest));
  const summary = summarizeEvidence(evidence);
  writeOnce(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
  writeOnce(resolve(evidenceRoot, "report.md"), Buffer.from(reportText(summary), "utf8"));
  writeOnce(resolve(evidenceRoot, "manifest.json"), jsonBytes(evidenceManifest()));
  return evidence;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runExcludedPilot();
}
