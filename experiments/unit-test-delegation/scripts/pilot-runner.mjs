#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluatePilot, finalizeDuplicateFlags } from "./analysis.mjs";
import {
  aggregateTiming,
  aggregateTools,
  aggregateUsage,
  assertPrivacySafe,
  auditEvents,
  buildCopilotArgs,
  concisePilotSummary,
  deriveTrace,
  frozenPilotPlan,
  inspectCliSurface,
  NODE_VERSION,
  parseCopilotJsonl,
  privacyNormalize,
  sha256
} from "./pilot-contract.mjs";
import {
  canonical,
  evaluate,
  listFiles,
  materialize,
  readJson,
  root,
  sourceEntries,
  writeJson
} from "./lib.mjs";

const repositoryRoot = path.resolve(root, "..", "..");
const authorizationPath = path.join(root, "design", "authorization.json");
const preregistrationManifestPath = path.join(root, "design", "preregistration-source-manifest.json");
const sourceManifestPath = path.join(root, "design", "source-manifest.json");
const usageColumns = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "request_multiplier", "duration_ms",
  "time_to_first_token_ms", "inter_token_latency_ms", "initiator", "api_endpoint",
  "reasoning_effort", "finish_reason", "content_filter_triggered",
  "token_details_json", "created_at"
];
const usageQuery = `SELECT ${usageColumns.join(", ")} FROM assistant_usage_events WHERE session_id = ? ORDER BY id`;

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, path.resolve(command)]
    : [command];
}

function invoke(command, args, options = {}) {
  const [executable, ...prefix] = commandParts(command);
  return spawnSync(executable, [...prefix, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function parseMcpList(stdout) {
  const names = [];
  for (const line of String(stdout ?? "").split(/\r?\n/u)) {
    const match = /^\s{2}([A-Za-z0-9._-]+)\s+\((?:local|remote)\)\s*$/u.exec(line);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function readUsageRows(database, sessionId) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro', uri=True)",
    "db.row_factory = sqlite3.Row",
    `rows = [dict(row) for row in db.execute(${JSON.stringify(usageQuery)}, (sys.argv[2],))]`,
    "print(json.dumps(rows, separators=(',', ':')))"
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, path.resolve(database), sessionId], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`unable to export exact local usage: ${failures.join("; ")}`);
}

function settledUsage(database, sessionId, exporter = readUsageRows) {
  let latest = [];
  let previousHash = null;
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    latest = exporter(database, sessionId);
    const hash = sha256(JSON.stringify(latest));
    stable = hash === previousHash ? stable + 1 : 1;
    previousHash = hash;
    if (latest.length > 0 && stable >= 3) return latest;
    if (exporter !== readUsageRows) continue;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return latest;
}

function inspectUsageStore(database) {
  if (!database || !fs.existsSync(database)) return { ok: false, columns: [], reason: "session-store.db is missing" };
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro', uri=True)",
    "columns = [row[1] for row in db.execute(\"PRAGMA table_info('assistant_usage_events')\")]",
    "print(json.dumps(columns))"
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, path.resolve(database)], {
      encoding: "utf8",
      windowsHide: true
    });
    if (!result.error && result.status === 0) {
      const columns = JSON.parse(result.stdout);
      const missing = usageColumns.filter((column) => !columns.includes(column));
      return {
        ok: missing.length === 0,
        columns,
        reason: missing.length === 0 ? null : `assistant_usage_events is missing: ${missing.join(", ")}`
      };
    }
  }
  return { ok: false, columns: [], reason: "session store could not be inspected" };
}

function consumedSessionIds(database, sessionIds) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro', uri=True)",
    "ids = json.loads(sys.argv[2])",
    "used = set()",
    "tables = {row[0] for row in db.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}",
    "if 'sessions' in tables:",
    "    used.update(row[0] for row in db.execute('SELECT id FROM sessions WHERE id IN (' + ','.join('?' for _ in ids) + ')', ids))",
    "if 'assistant_usage_events' in tables:",
    "    used.update(row[0] for row in db.execute('SELECT DISTINCT session_id FROM assistant_usage_events WHERE session_id IN (' + ','.join('?' for _ in ids) + ')', ids))",
    "print(json.dumps(sorted(used)))"
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [
      ...prefix,
      "-c",
      script,
      path.resolve(database),
      JSON.stringify(sessionIds)
    ], {
      encoding: "utf8",
      windowsHide: true
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  }
  throw new Error("session store could not be checked for consumed pilot IDs");
}

function writeOnce(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function immutable(file) {
  fs.chmodSync(file, 0o444);
}

function verifyPreregistrationManifest(authorization) {
  const manifest = readJson(preregistrationManifestPath);
  assert.equal(manifest.rootHash, authorization.preregistrationSourceManifestRootHash,
    "authorization does not bind the preregistration source manifest");
  assert.equal(sha256(canonical(manifest.files)), manifest.rootHash, "preregistration root hash is invalid");
  const mutable = new Set(authorization.reviewedMutableFiles);
  for (const entry of manifest.files) {
    if (mutable.has(entry.path)) continue;
    const file = path.join(root, entry.path);
    assert(fs.existsSync(file), `frozen source is missing: ${entry.path}`);
    assert.equal(sha256(fs.readFileSync(file)), entry.sha256, `frozen source drift: ${entry.path}`);
  }
  return { rootHash: manifest.rootHash, frozenFiles: manifest.files.length - mutable.size };
}

function verifyCurrentManifest() {
  const manifest = readJson(sourceManifestPath);
  const actual = sourceEntries();
  assert.equal(canonical(actual), canonical(manifest.files), "current source manifest drift");
  assert.equal(sha256(canonical(actual)), manifest.rootHash, "current source root hash drift");
  return { rootHash: manifest.rootHash, files: actual.length };
}

function verifyReviewedExecutionFiles(authorization) {
  assert(Array.isArray(authorization.reviewedExecutionFiles)
    && authorization.reviewedExecutionFiles.length > 0,
  "authorization lacks reviewed execution files");
  for (const entry of authorization.reviewedExecutionFiles) {
    const file = path.join(root, entry.path);
    assert(fs.existsSync(file), `reviewed execution file is missing: ${entry.path}`);
    assert.equal(sha256(fs.readFileSync(file)), entry.sha256,
      `reviewed execution file drift: ${entry.path}`);
  }
  return authorization.reviewedExecutionFiles.length;
}

function candidateManifestHash(candidateRoot) {
  const manifest = readJson(path.join(candidateRoot, ".study", "candidate-manifest.json"));
  return sha256(canonical(manifest));
}

function verifyGeneratedCandidates(plan, authorization) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd-pilot-preflight-"));
  const hashes = {};
  try {
    for (const entry of plan) {
      const candidateRoot = path.join(parent, entry.worktreeId);
      materialize({
        taskId: entry.taskId,
        arm: entry.arm,
        runId: entry.observationId.toLowerCase(),
        out: candidateRoot
      });
      hashes[entry.observationId] = candidateManifestHash(candidateRoot);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.deepEqual(hashes, authorization.generatedCandidateManifestHashes,
    "generated pilot candidate hashes differ from reviewed authorization");
  return hashes;
}

function ensureExternalAbsentRoot(privateRoot) {
  const resolved = path.resolve(privateRoot);
  const relative = path.relative(repositoryRoot, resolved);
  assert(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "private evidence root must be outside the repository");
  assert(!fs.existsSync(resolved), "private evidence root must not exist before pilot lifecycle");
  return resolved;
}

export function collectStaticPreflight({
  cli,
  sessionStore,
  privateRoot,
  cliEvidence = null,
  gitEvidence = null,
  nodeVersion = process.versions.node
}) {
  const authorization = readJson(authorizationPath);
  assert.equal(authorization.pilot, "authorized", "excluded pilot is not authorized");
  assert.equal(authorization.main, "forbidden", "main execution must remain forbidden");
  assert.equal(authorization.requiresExecuteFlag, true, "authorization must require --execute");
  const plan = frozenPilotPlan();
  assert.deepEqual(plan.map(({ observationId, sessionId, worktreeId }) =>
    ({ observationId, sessionId, worktreeId })), authorization.pilotIdentities,
  "frozen pilot identities differ from authorization");
  assert.equal(nodeVersion, NODE_VERSION, `requires exact Node.js ${NODE_VERSION}`);
  const preregistration = verifyPreregistrationManifest(authorization);
  const current = verifyCurrentManifest();
  const reviewedExecutionFiles = verifyReviewedExecutionFiles(authorization);
  const generated = verifyGeneratedCandidates(plan, authorization);
  const privateEvidenceRoot = ensureExternalAbsentRoot(privateRoot);
  if (!gitEvidence) git(["merge-base", "--is-ancestor", authorization.authorizedAfterMerge, "HEAD"]);
  const observedGit = gitEvidence ?? {
    status: git(["status", "--porcelain"]),
    head: git(["rev-parse", "HEAD"])
  };
  assert.equal(observedGit.status, "", "repository must be clean before pilot execution");
  assert.match(observedGit.head, /^[a-f0-9]{40}$/u, "repository HEAD is unavailable");
  const observedCli = cliEvidence ?? (() => {
    const version = invoke(cli, ["--version"]);
    const help = invoke(cli, ["--help"]);
    const mcp = invoke(cli, ["mcp", "list"]);
    assert.equal(version.status, 0, "Copilot CLI version probe failed");
    assert.equal(help.status, 0, "Copilot CLI help probe failed");
    assert.equal(mcp.status, 0, "Copilot CLI MCP enumeration failed");
    return {
      version: version.stdout,
      help: help.stdout,
      configuredMcpServers: parseMcpList(mcp.stdout)
    };
  })();
  const cliSurface = inspectCliSurface(observedCli);
  assert(cliSurface.ok, cliSurface.reasons.join("; "));
  const usageStore = cliEvidence?.usageStore ?? inspectUsageStore(sessionStore);
  assert(usageStore.ok, usageStore.reason);
  const consumedIds = cliEvidence?.consumedIds
    ?? consumedSessionIds(sessionStore, plan.map((entry) => entry.sessionId));
  assert.deepEqual(consumedIds, [], `pilot session IDs were already consumed: ${consumedIds.join(", ")}`);
  return {
    ok: true,
    mode: "preflight-only",
    authorizationId: authorization.authorizationId,
    main: "forbidden",
    observationCount: plan.length,
    order: plan.map((entry) => entry.observationId),
    identities: plan.map(({ observationId, sessionId, worktreeId }) =>
      ({ observationId, sessionId, worktreeId })),
    repositoryHead: observedGit.head,
    preregistration,
    current,
    reviewedExecutionFiles,
    generated,
    cli: cliSurface,
    usageStore: { ok: true, columns: usageStore.columns },
    consumedIds,
    privateEvidenceRoot,
    rootsCreated: false,
    observationsStarted: 0
  };
}

function reserveIdentity(lockRoot, plan) {
  const file = path.join(lockRoot, `${String(plan.globalOrder).padStart(2, "0")}-${plan.observationId}.lock.json`);
  writeOnce(file, {
    schemaVersion: 1,
    observationId: plan.observationId,
    sessionId: plan.sessionId,
    worktreeId: plan.worktreeId,
    globalOrder: plan.globalOrder,
    reservedAt: new Date().toISOString()
  });
  immutable(file);
  return file;
}

export function reservePilotIdentity(lockRoot, plan) {
  return reserveIdentity(lockRoot, plan);
}

function candidateChanges(candidateRoot, arm) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: candidateRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`candidate git status failed: ${result.stderr.trim()}`);
  const changed = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) =>
    line.slice(3).replaceAll("\\", "/")).sort();
  const expected = ["src/feature.js", "test/feature.test.js"];
  const reasons = [];
  if (canonical(changed) !== canonical(expected)) reasons.push(`candidate changed paths differ: ${changed.join(", ")}`);
  if (arm === "A2" && !changed.includes("test/feature.test.js")) reasons.push("worker target test change is missing");
  return { changed, reasons };
}

export function classifyPilotStatus({ startDisposition, execution, result, auditReasons, evaluationError }) {
  if (startDisposition !== "started") return "pre-start-failure";
  const text = auditReasons.join(" ").toLowerCase();
  if (execution.error?.code === "ETIMEDOUT") return "timeout";
  if (/model|effort/u.test(text)) return "model-mismatch";
  if (/skill|delegat|fixed-haiku|worker usage/u.test(text)) return "delegation-failure";
  if (/forbidden tool|tool surface|parent accessed|worker read|worker edit|parent tool/u.test(text)) return "tool-misuse";
  if (!result || execution.status !== 0 || result.exitCode !== 0) return "malformed-result";
  if (evaluationError) return "infrastructure-failure";
  return auditReasons.length === 0 ? "complete" : "tool-misuse";
}

function startedFrom(events, usageRows) {
  return usageRows.some((row) =>
    row.agent_id === null && row.parent_tool_call_id === null)
    || events.some((event) =>
      event.type === "assistant.message" && !event.agentId && event.data?.model);
}

function integrityStop(observation) {
  return ["model-mismatch", "tool-misuse"].includes(observation.status)
    || observation.diagnostics.some((reason) => /privacy|evidence corruption|candidate changed paths/u.test(reason));
}

export function retainedNotStartedObservation(plan, candidateCommitSha, reason) {
  const zeroWorker = plan.arm === "A1"
    ? { credits: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, completions: 0 }
    : { credits: null, nanoAiu: null, inputTokens: null, outputTokens: null, completions: null };
  return {
    schemaVersion: 1,
    observationId: plan.observationId,
    sessionId: plan.sessionId,
    worktreeId: plan.worktreeId,
    candidateCommitSha,
    blockId: plan.blockId,
    taskId: plan.taskId,
    repetition: plan.repetition,
    arm: plan.arm,
    startDisposition: "not-started",
    status: "pre-start-failure",
    usage: {
      parent: { credits: null, nanoAiu: null, inputTokens: null, outputTokens: null, completions: null },
      worker: zeroWorker,
      combinedCredits: null,
      combinedNanoAiu: null,
      totalModelTokens: null
    },
    parentContext: { cumulativeInputTokens: null, peakInputTokens: null },
    timing: { parentActiveMs: null, workerActiveMs: plan.arm === "A1" ? 0 : null, parentWaitMs: plan.arm === "A1" ? 0 : null, wallMs: null },
    tools: { parentCalls: null, workerCalls: plan.arm === "A1" ? 0 : null, resultBytes: null, byActorAndName: {} },
    evaluation: null,
    diagnostics: [reason]
  };
}

function materializePilot(privateRoot, plan, authorization) {
  const candidatesRoot = path.join(privateRoot, "candidates");
  const materialized = new Map();
  for (const entry of plan) {
    const candidateRoot = path.join(candidatesRoot, entry.worktreeId);
    const candidate = materialize({
      taskId: entry.taskId,
      arm: entry.arm,
      runId: entry.observationId.toLowerCase(),
      out: candidateRoot
    });
    assert.equal(candidateManifestHash(candidateRoot),
      authorization.generatedCandidateManifestHashes[entry.observationId],
    `${entry.observationId} generated candidate hash drift`);
    materialized.set(entry.observationId, candidate);
  }
  return materialized;
}

function runObservation({
  cli,
  sessionStore,
  privateRoot,
  plan,
  candidate,
  disabledMcpServers,
  spawn = invoke,
  usageExporter = settledUsage
}) {
  const rawRoot = path.join(privateRoot, "raw-private", plan.observationId);
  const lockRoot = path.join(privateRoot, "lifecycle-locks");
  fs.mkdirSync(rawRoot, { recursive: true });
  reserveIdentity(lockRoot, plan);
  const prompt = fs.readFileSync(path.join(candidate.output, "PROMPT.md"), "utf8");
  const envelope = readJson(path.join(candidate.output, ".study", "envelope.json"));
  const args = buildCopilotArgs({
    prompt,
    plan,
    candidateRoot: candidate.output,
    disabledMcpServers
  });
  writeOnce(path.join(rawRoot, "command.json"), {
    cli,
    args,
    promptSha256: sha256(prompt),
    candidateRoot: "<candidate-root>"
  });
  writeOnce(path.join(rawRoot, "attempt-start.json"), {
    schemaVersion: 1,
    observationId: plan.observationId,
    sessionId: plan.sessionId,
    launchedAt: new Date().toISOString()
  });
  immutable(path.join(rawRoot, "attempt-start.json"));
  const execution = spawn(cli, args, {
    cwd: candidate.output,
    timeout: 300000
  });
  writeOnce(path.join(rawRoot, "events.jsonl"), Buffer.from(execution.stdout ?? "", "utf8"));
  writeOnce(path.join(rawRoot, "stderr.txt"), Buffer.from(execution.stderr ?? "", "utf8"));
  const diagnostics = [];
  let events = [];
  let result = null;
  try {
    events = parseCopilotJsonl(execution.stdout ?? "");
    const results = events.filter((event) => event.type === "result");
    if (results.length !== 1) throw new Error(`expected one result event, found ${results.length}`);
    [result] = results;
  } catch (error) {
    diagnostics.push(error.message);
  }
  let usageRows = [];
  try {
    usageRows = usageExporter(sessionStore, plan.sessionId);
  } catch (error) {
    diagnostics.push(`usage settlement failed: ${error.message}`);
  }
  writeOnce(path.join(rawRoot, "usage.json"), {
    schemaVersion: 1,
    source: "assistant_usage_events",
    sessionId: plan.sessionId,
    rows: usageRows
  });
  const trace = deriveTrace(events);
  const audit = auditEvents({
    events,
    usageRows,
    prompt,
    plan,
    workspace: candidate.output,
    envelope
  });
  diagnostics.push(...audit.reasons);
  const aggregated = aggregateUsage(usageRows, { arm: plan.arm, workerCallId: audit.workerCallId });
  if (aggregated.unattributedRows.length > 0) diagnostics.push("usage contains unattributed actor rows");
  const timing = aggregateTiming(events, aggregated.actorRows);
  const tools = aggregateTools(events, audit.workerCallId);
  const changes = candidateChanges(candidate.output, plan.arm);
  diagnostics.push(...changes.reasons);
  let evaluation = null;
  let evaluationError = null;
  try {
    evaluation = evaluate({
      workspace: candidate.output,
      taskId: plan.taskId,
      arm: plan.arm,
      trace
    });
    evaluation.adherence = {
      adherent: audit.adherent && evaluation.adherence.adherent,
      reasons: [...new Set([...audit.reasons, ...evaluation.adherence.reasons])]
    };
  } catch (error) {
    evaluationError = error.message;
    diagnostics.push(`evaluation failed: ${error.message}`);
  }
  const startDisposition = startedFrom(events, usageRows) ? "started" : "not-started";
  const status = classifyPilotStatus({
    startDisposition,
    execution,
    result,
    auditReasons: diagnostics,
    evaluationError
  });
  const observation = {
    schemaVersion: 1,
    observationId: plan.observationId,
    sessionId: plan.sessionId,
    worktreeId: plan.worktreeId,
    candidateCommitSha: candidate.candidateCommitSha,
    blockId: plan.blockId,
    taskId: plan.taskId,
    repetition: plan.repetition,
    arm: plan.arm,
    startDisposition,
    status,
    usage: aggregated.usage,
    parentContext: aggregated.parentContext,
    timing,
    tools,
    evaluation,
    diagnostics: [...new Set(diagnostics)]
  };
  writeOnce(path.join(rawRoot, "observation.json"), observation);
  return observation;
}

function evidenceManifest(privateRoot) {
  const entries = listFiles(privateRoot)
    .filter((file) => file !== "evidence-manifest.json")
    .map((file) => ({
      path: file,
      sha256: sha256(fs.readFileSync(path.join(privateRoot, file))),
      bytes: fs.statSync(path.join(privateRoot, file)).size
    }));
  const manifest = {
    schemaVersion: 1,
    algorithm: "sha256",
    files: entries,
    rootHash: sha256(canonical(entries))
  };
  writeOnce(path.join(privateRoot, "evidence-manifest.json"), manifest);
  immutable(path.join(privateRoot, "evidence-manifest.json"));
  return manifest;
}

export function executePilot({
  cli,
  sessionStore,
  privateRoot,
  execute,
  cliEvidence = null,
  gitEvidence = null,
  nodeVersion = process.versions.node,
  spawn = invoke,
  usageExporter = settledUsage
}) {
  assert.equal(execute, true, "pilot lifecycle requires explicit --execute");
  const preflight = collectStaticPreflight({
    cli,
    sessionStore,
    privateRoot,
    cliEvidence,
    gitEvidence,
    nodeVersion
  });
  const authorization = readJson(authorizationPath);
  const plan = frozenPilotPlan();
  fs.mkdirSync(privateRoot, { recursive: false });
  writeOnce(path.join(privateRoot, "preflight.json"), preflight);
  const candidates = materializePilot(privateRoot, plan, authorization);
  const observations = [];
  let stopReason = null;
  for (const entry of plan) {
    if (stopReason) {
      observations.push(retainedNotStartedObservation(
        entry,
        candidates.get(entry.observationId).candidateCommitSha,
        `not started because lifecycle stopped: ${stopReason}`
      ));
      continue;
    }
    let observation;
    try {
      observation = runObservation({
        cli,
        sessionStore,
        privateRoot,
        plan: entry,
        candidate: candidates.get(entry.observationId),
        disabledMcpServers: preflight.cli.configuredMcpServers,
        spawn,
        usageExporter
      });
    } catch (error) {
      const candidate = candidates.get(entry.observationId);
      const rawRoot = path.join(privateRoot, "raw-private", entry.observationId);
      const launched = fs.existsSync(path.join(rawRoot, "attempt-start.json"));
      observation = retainedNotStartedObservation(
        entry,
        candidate.candidateCommitSha,
        `${launched ? "post-start" : "pre-start"} infrastructure failure: ${error.message}`
      );
      if (launched) {
        observation.startDisposition = "started";
        observation.status = "infrastructure-failure";
      }
      const fallback = path.join(rawRoot, "observation.json");
      if (!fs.existsSync(fallback)) writeOnce(fallback, observation);
    }
    observations.push(observation);
    if (integrityStop(observation)) stopReason = `${observation.observationId} ${observation.status}`;
  }
  const finalized = finalizeDuplicateFlags(observations);
  const gate = evaluatePilot(finalized);
  const summary = assertPrivacySafe(privacyNormalize(
    concisePilotSummary(finalized, gate),
    [[path.resolve(privateRoot), "<private-root>"], [os.homedir(), "<home>"]]
  ));
  const sanitizedRoot = path.join(privateRoot, "sanitized");
  writeOnce(path.join(sanitizedRoot, "pilot-summary.json"), summary);
  writeOnce(path.join(sanitizedRoot, "pilot-gate.json"), gate);
  writeOnce(path.join(sanitizedRoot, "observation-hashes.json"), {
    schemaVersion: 1,
    observations: finalized.map((observation) => ({
      observationId: observation.observationId,
      sha256: sha256(canonical(observation))
    }))
  });
  const disposition = {
    schemaVersion: 1,
    authorizationId: authorization.authorizationId,
    stoppedEarly: stopReason !== null,
    stopReason,
    decision: gate.decision,
    mainRemainsForbidden: true
  };
  writeOnce(path.join(sanitizedRoot, "disposition.json"), disposition);
  const manifest = evidenceManifest(privateRoot);
  return { summary, gate, disposition, evidenceRootHash: manifest.rootHash };
}

function main(args) {
  const cli = argument(args, "--cli");
  const sessionStore = argument(args, "--session-store");
  const privateRoot = argument(args, "--private-root");
  if (!cli || !sessionStore || !privateRoot) {
    throw new Error("usage: pilot-runner.mjs --cli <copilot> --session-store <session-store.db> --private-root <absent-external-root> [--execute]");
  }
  const execute = args.includes("--execute");
  const result = execute
    ? executePilot({ cli, sessionStore, privateRoot, execute })
    : collectStaticPreflight({ cli, sessionStore, privateRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
