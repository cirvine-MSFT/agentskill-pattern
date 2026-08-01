#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRunEvidence, parseEvents } from "./pilot-evidence.mjs";
import {
  assert,
  canonicalJson,
  jsonBytes,
  readJson,
  repositoryRoot,
  root,
  sha256,
} from "./lib.mjs";

const MCP_TOOL_NAMES = [
  "release-notes/read_release_dossier",
  "release-notes/write_release_note_draft",
];
const USAGE_COLUMNS = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "request_multiplier", "duration_ms",
  "time_to_first_token_ms", "inter_token_latency_ms", "initiator", "api_endpoint",
  "reasoning_effort", "finish_reason", "content_filter_triggered",
  "token_details_json", "created_at",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sessionIdFor(dossierId) {
  const bytes = createHash("sha256")
    .update(`release-note-pilot\0A4\0${dossierId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeOnce(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

function replaceJson(path, value) {
  const pending = `${path}.pending`;
  writeFileSync(pending, jsonBytes(value), { flag: "wx" });
  renameSync(pending, path);
}

function exportUsage(database, sessionId) {
  const query = `SELECT ${USAGE_COLUMNS.join(", ")} FROM assistant_usage_events WHERE session_id = ? ORDER BY id`;
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "db.row_factory = sqlite3.Row",
    `rows = [dict(row) for row in db.execute(${JSON.stringify(query)}, (sys.argv[2],))]`,
    "print(json.dumps(rows, separators=(',', ':')))",
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, database, sessionId], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`exact-session usage export failed: ${failures.join("; ")}`);
}

function sessionExists(database, sessionId) {
  const script = [
    "import sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "print(1 if db.execute('SELECT 1 FROM sessions WHERE id = ? LIMIT 1', (sys.argv[2],)).fetchone() else 0)",
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, database, sessionId], {
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) return result.stdout.trim() === "1";
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`exact-session existence check failed: ${failures.join("; ")}`);
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

function materializeWorkspace(workRoot) {
  const workspaceRoot = resolve(workRoot, "isolated-workspace");
  mkdirSync(resolve(workspaceRoot, ".github", "skills", "release-note-synthesis"), { recursive: true });
  mkdirSync(resolve(workspaceRoot, ".github", "agents"), { recursive: true });
  mkdirSync(resolve(workspaceRoot, "tools", "release-note-mcp"), { recursive: true });
  const copies = [
    [resolve(repositoryRoot, ".github", "skills", "release-note-synthesis", "SKILL.md"), resolve(workspaceRoot, ".github", "skills", "release-note-synthesis", "SKILL.md")],
    [resolve(repositoryRoot, ".github", "agents", "release-note-haiku.agent.md"), resolve(workspaceRoot, ".github", "agents", "release-note-haiku.agent.md")],
    [resolve(repositoryRoot, "tools", "release-note-mcp", "lib.mjs"), resolve(workspaceRoot, "tools", "release-note-mcp", "lib.mjs")],
    [resolve(repositoryRoot, "tools", "release-note-mcp", "protocol.mjs"), resolve(workspaceRoot, "tools", "release-note-mcp", "protocol.mjs")],
    [resolve(repositoryRoot, "tools", "release-note-mcp", "server.mjs"), resolve(workspaceRoot, "tools", "release-note-mcp", "server.mjs")],
  ];
  for (const [source, target] of copies) copyFileSync(source, target);
  return workspaceRoot;
}

function probeMcpSurface(workRoot, workspaceRoot) {
  const probeRoot = resolve(workRoot, "mcp-preflight");
  mkdirSync(resolve(probeRoot, "output"), { recursive: true });
  mkdirSync(resolve(probeRoot, "audit"), { recursive: true });
  const dossierPath = resolve(probeRoot, "dossier.json");
  const dossierBytes = jsonBytes({ formatVersion: 1, dossierId: "preflight", sources: [] });
  writeOnce(dossierPath, dossierBytes);
  const token = randomBytes(32).toString("base64url");
  const configPath = resolve(probeRoot, "config.json");
  writeOnce(configPath, jsonBytes({
    version: 1,
    runId: "DEV-MCP-PREFLIGHT",
    arm: "A4",
    taskEnvelopeSha256: "0".repeat(64),
    sandboxKind: "closed-tool-surface",
    sandboxTokenHash: `sha256:${sha256(Buffer.from(token, "utf8"))}`,
    dossier: { path: dossierPath, sha256: sha256(dossierBytes) },
    output: { path: resolve(probeRoot, "output", "draft.md"), relativePath: "drafts/preflight.md" },
    audit: { path: resolve(probeRoot, "audit", "audit.jsonl") },
    limits: { maxDossierBytes: 64 * 1024, maxDraftBytes: 8 * 1024 },
  }));
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [resolve(workspaceRoot, "tools", "release-note-mcp", "server.mjs")],
    {
      cwd: workspaceRoot,
      input,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        RELEASE_NOTE_RUN_CONFIG: configPath,
        RELEASE_NOTE_SANDBOX_TOKEN: token,
      },
    },
  );
  assert(result.status === 0, `MCP preflight failed: ${result.stderr.trim()}`);
  const responses = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  const tools = responses.find((response) => response.id === 2)?.result?.tools;
  assert(Array.isArray(tools), "MCP preflight did not return tools/list");
  assert(
    JSON.stringify(tools.map((tool) => `release-notes/${tool.name}`)) === JSON.stringify(MCP_TOOL_NAMES),
    "MCP tools/list differs from the worker allowlist",
  );
  rmSync(probeRoot, { recursive: true, force: true });
  return tools;
}

function validatePreflight({ sessionStore, evidenceRoot, workRoot, workspaceRoot, gate, startIndex }) {
  assert(process.argv.includes("--execute"), "pilot requires explicit --execute");
  assert(
    startIndex.captures.length === 0 && !existsSync(resolve(evidenceRoot, "execution-summary.json")),
    "protocol-scoped pilot ledger records an outcome; retries are forbidden",
  );
  assert(existsSync(sessionStore), "local session store is required for pilot usage evidence");
  for (const dossierId of gate.runOrder) {
    const sessionId = sessionIdFor(dossierId);
    assert(!sessionExists(sessionStore, sessionId), `deterministic pilot session already exists for ${dossierId}`);
    assert(
      exportUsage(sessionStore, sessionId).length === 0,
      `deterministic pilot session already exists for ${dossierId}`,
    );
  }
  const agent = readFileSync(resolve(workspaceRoot, ".github", "agents", "release-note-haiku.agent.md"), "utf8");
  assert(agent.includes("model: claude-haiku-4.5"), "isolated worker profile does not fix Claude Haiku 4.5");
  for (const tool of MCP_TOOL_NAMES) assert(agent.includes(`- ${tool}`), `worker profile lacks ${tool}`);
  const toolSchemas = probeMcpSurface(workRoot, workspaceRoot);
  const help = runCommand("copilot", ["--help"]);
  assert(help.status === 0, "copilot --help failed");
  const helpText = help.stdout.toString("utf8");
  for (const flag of ["--session-id", "--model", "--output-format", "--available-tools", "--additional-mcp-config"]) {
    assert(helpText.includes(flag), `Copilot CLI lacks required ${flag}`);
  }
  const version = runCommand("copilot", ["--version"]);
  assert(version.status === 0, "copilot --version failed");
  return {
    copilotVersion: version.stdout.toString("utf8").trim(),
    sessionStore: "session-store.db",
    workRoot,
    evidenceRoot,
    checkedAt: new Date().toISOString(),
    isolatedWorkspace: true,
    workerModel: "claude-haiku-4.5",
    workerTools: MCP_TOOL_NAMES,
    toolSchemaSha256: sha256(Buffer.from(canonicalJson(toolSchemas), "utf8")),
  };
}

function exactEnvelope(runId, dossierId, dossierSha256, outputPath) {
  const commonTask = readFileSync(resolve(root, "design", "common-task.txt"), "utf8");
  return {
    formatVersion: 1,
    protocolId: "release-note-synthesis-v0-foundation",
    phase: "excluded-pilot",
    arm: "A4",
    runId,
    dossierId,
    dossierSha256,
    outputPath,
    instruction: commonTask,
  };
}

function configFor({ runId, dossierPath, dossierSha256, runRoot, token, taskEnvelopeSha256 }) {
  return {
    version: 1,
    runId,
    arm: "A4",
    taskEnvelopeSha256,
    sandboxKind: "closed-tool-surface",
    sandboxTokenHash: `sha256:${sha256(Buffer.from(token, "utf8"))}`,
    dossier: { path: dossierPath, sha256: dossierSha256 },
    output: {
      path: resolve(runRoot, "staging", "draft.md"),
      relativePath: `drafts/${readJson(dossierPath).dossierId}.md`,
    },
    audit: { path: resolve(runRoot, "audit", "mcp-audit.jsonl") },
    limits: { maxDossierBytes: 64 * 1024, maxDraftBytes: 8 * 1024 },
  };
}

function mcpConfig(workspaceRoot) {
  return {
    mcpServers: {
      "release-notes": {
        command: process.execPath,
        args: [resolve(workspaceRoot, "tools", "release-note-mcp", "server.mjs")],
        tools: ["read_release_dossier", "write_release_note_draft"],
      },
    },
  };
}

function executeRun({ dossierId, sequence, workRoot, evidenceRoot, sessionStore, startIndex, workspaceRoot }) {
  const runId = `PILOT-A4-${String(sequence).padStart(2, "0")}`;
  const dossierPath = resolve(root, "fixtures", "dossiers", "excluded-pilot", `${dossierId}.json`);
  const dossierBytes = readFileSync(dossierPath);
  const dossierSha256 = sha256(dossierBytes);
  const manifest = readJson(resolve(root, "fixtures", "manifest.json"));
  const frozen = manifest.dossiers.find((entry) => entry.dossierId === dossierId);
  assert(frozen?.partition === "excluded-pilot", `${dossierId} is not a frozen excluded-pilot dossier`);
  assert(frozen.sha256 === dossierSha256, `${dossierId} differs from its frozen hash`);
  const runRoot = resolve(workRoot, runId);
  mkdirSync(resolve(runRoot, "contract"), { recursive: true });
  mkdirSync(resolve(runRoot, "staging"), { recursive: true });
  mkdirSync(resolve(runRoot, "audit"), { recursive: true });
  const confinedDossierPath = resolve(runRoot, "contract", "dossier.json");
  copyFileSync(dossierPath, confinedDossierPath);
  assert(sha256(readFileSync(confinedDossierPath)) === dossierSha256, "confined dossier copy differs");
  const outputRelative = `drafts/${dossierId}.md`;
  const envelope = exactEnvelope(runId, dossierId, dossierSha256, outputRelative);
  const envelopeBytes = Buffer.from(canonicalJson(envelope), "utf8");
  const taskEnvelopeSha256 = sha256(envelopeBytes);
  const token = randomBytes(32).toString("base64url");
  const config = configFor({
    runId,
    dossierPath: confinedDossierPath,
    dossierSha256,
    runRoot,
    token,
    taskEnvelopeSha256,
  });
  const configPath = resolve(runRoot, "run-config.json");
  const mcpPath = resolve(runRoot, "mcp-config.json");
  writeOnce(configPath, jsonBytes(config));
  writeOnce(mcpPath, jsonBytes(mcpConfig(workspaceRoot)));
  const sessionId = sessionIdFor(dossierId);
  const startedAt = new Date().toISOString();
  const startCapture = {
    runId,
    dossierId,
    sequence,
    sessionId,
    startedAt,
    taskEnvelopeSha256,
    dossierSha256,
    disposition: "started",
  };
  startIndex.captures.push(startCapture);
  // The protocol-scoped ledger update is the single durable start marker.
  replaceJson(resolve(evidenceRoot, "start-index.json"), startIndex);

  const prompt = JSON.stringify(envelope);
  const args = [
    "-p", prompt,
    "--session-id", sessionId,
    "--model", "gpt-5.6-sol",
    "--output-format", "json",
    "-C", workspaceRoot,
    "--allow-all-tools",
    `--available-tools=skill,task,${MCP_TOOL_NAMES.join(",")}`,
    "--additional-mcp-config", `@${mcpPath}`,
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", "default",
    "--effort", "medium",
  ];
  const result = runCommand("copilot", args, {
    cwd: workspaceRoot,
    timeout: 300000,
    env: {
      ...process.env,
      RELEASE_NOTE_RUN_CONFIG: configPath,
      RELEASE_NOTE_SANDBOX_TOKEN: token,
    },
  });
  const endedAt = new Date().toISOString();
  const rawBytes = result.stdout ?? Buffer.alloc(0);
  const stderrBytes = result.stderr ?? Buffer.alloc(0);
  writeOnce(resolve(runRoot, "copilot-events.jsonl"), rawBytes);
  writeOnce(resolve(runRoot, "copilot-stderr.txt"), stderrBytes);
  let events = [];
  let eventError = null;
  try {
    events = parseEvents(rawBytes);
  } catch (error) {
    eventError = error.message;
  }
  let usageRows = [];
  let usageError = null;
  try {
    usageRows = exportUsage(sessionStore, sessionId);
  } catch (error) {
    usageError = error.message;
  }
  writeOnce(resolve(runRoot, "usage.json"), jsonBytes({
    formatVersion: 1,
    source: "assistant_usage_events",
    sessionId,
    rows: usageRows,
    error: usageError,
  }));
  const run = { runId, dossierId, sessionId, taskEnvelopeSha256 };
  const dossier = readJson(dossierPath);
  const forbiddenFactIds = readdirSync(resolve(root, "evaluator", "gold"))
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => readJson(resolve(root, "evaluator", "gold", name)).facts.map((fact) => fact.id));
  const configuredToolSchemas = [
    { name: "read_release_dossier", arguments: {} },
    { name: "write_release_note_draft", arguments: { draft: "string", dossierSha256: "sha256" } },
  ];
  let evidence;
  if (eventError) {
    evidence = {
      formatVersion: 1,
      ...run,
      arm: "A4",
      startedAt,
      endedAt,
      disposition: "measured-failure",
      operationalSuccess: false,
      treatmentAdherent: false,
      strictSuccess: false,
      failureReasons: [eventError, ...(usageError ? [usageError] : [])],
    };
  } else {
    evidence = deriveRunEvidence({
      run,
      events,
      rawBytes,
      usageRows,
      auditPath: config.audit.path,
      draftPath: config.output.path,
      processResult: result,
      startedAt,
      endedAt,
      configuredToolSchemas,
      allowedUrls: dossier.sources.map((source) => source.publicUrl),
      forbiddenFactIds,
    });
    if (usageError) {
      evidence.failureReasons.push(usageError);
      evidence.disposition = "measured-failure";
      evidence.operationalSuccess = false;
      evidence.treatmentAdherent = false;
      evidence.strictSuccess = false;
    }
  }
  writeOnce(resolve(runRoot, "run-evidence.json"), jsonBytes(evidence));

  const checkedRunRoot = resolve(evidenceRoot, "runs", runId);
  mkdirSync(checkedRunRoot, { recursive: true });
  for (const name of [
    "run-config.json",
    "mcp-config.json",
    "copilot-events.jsonl",
    "copilot-stderr.txt",
    "usage.json",
    "run-evidence.json",
  ]) {
    copyFileSync(resolve(runRoot, name), resolve(checkedRunRoot, name), 0);
  }
  if (existsSync(config.audit.path)) copyFileSync(config.audit.path, resolve(checkedRunRoot, "mcp-audit.jsonl"));
  if (existsSync(config.output.path)) {
    const draftTarget = resolve(evidenceRoot, "drafts", `${dossierId}.md`);
    mkdirSync(dirname(draftTarget), { recursive: true });
    copyFileSync(config.output.path, draftTarget);
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(argument("--evidence-root") === undefined, "evidence root is protocol-scoped and cannot be overridden");
  const evidenceRoot = resolve(root, "results", "excluded-pilot");
  const workRoot = resolve(argument("--work-root") ?? resolve(os.tmpdir(), "release-note-excluded-pilot"));
  const sessionStore = resolve(argument("--session-store") ?? resolve(os.homedir(), ".copilot", "session-store.db"));
  mkdirSync(evidenceRoot, { recursive: true });
  const gate = readJson(resolve(root, "design", "pilot-gate.json"));
  const indexPath = resolve(evidenceRoot, "start-index.json");
  const startIndex = existsSync(indexPath)
    ? readJson(indexPath)
    : {
        formatVersion: 1,
        protocolId: gate.protocolId,
        phase: "excluded-pilot",
        arm: "A4",
        plannedOrder: gate.runOrder,
        captures: [],
      };
  assert(
    startIndex.captures.length === 0 && !existsSync(resolve(evidenceRoot, "execution-summary.json")),
    "protocol-scoped pilot ledger records an outcome; retries are forbidden",
  );
  if (existsSync(workRoot)) {
    assert(statSync(workRoot).isDirectory(), "work root must be a directory");
    assert(readdirSync(workRoot).length === 0, "work root must be empty");
  } else {
    mkdirSync(workRoot, { recursive: true });
  }
  const workspaceRoot = materializeWorkspace(workRoot);
  const preflight = validatePreflight({
    sessionStore,
    evidenceRoot,
    workRoot,
    workspaceRoot,
    gate,
    startIndex,
  });
  const preflightPath = resolve(evidenceRoot, "preflight.json");
  // Only a zero-capture, zero-session preflight may discard interrupted pre-start writes.
  for (const pending of [`${preflightPath}.pending`, `${indexPath}.pending`]) {
    if (existsSync(pending)) rmSync(pending);
  }
  if (existsSync(preflightPath)) replaceJson(preflightPath, preflight);
  else writeOnce(preflightPath, jsonBytes(preflight));
  if (!existsSync(indexPath)) writeOnce(indexPath, jsonBytes(startIndex));
  const results = [];
  for (const [index, dossierId] of gate.runOrder.entries()) {
    results.push(executeRun({
      dossierId,
      sequence: index + 1,
      workRoot,
      evidenceRoot,
      sessionStore,
      startIndex,
      workspaceRoot,
    }));
  }
  writeOnce(resolve(evidenceRoot, "execution-summary.json"), jsonBytes({
    formatVersion: 1,
    protocolId: gate.protocolId,
    phase: "excluded-pilot",
    completedAt: new Date().toISOString(),
    runs: results.map((run) => ({
      runId: run.runId,
      dossierId: run.dossierId,
      disposition: run.disposition,
      failureReasons: run.failureReasons,
    })),
  }));
  process.stdout.write(`Preserved ${results.length} excluded-pilot outcomes; run pilot:check for frozen disposition\n`);
}
