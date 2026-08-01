#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
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
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDraft } from "../evaluator/evaluate.mjs";
import {
  assert,
  availableTools,
  canonicalJson,
  canonicalTools,
  deriveEvidence,
  evidenceRoot,
  experimentRoot,
  filesUnder,
  jsonBytes,
  parseEvents,
  protocolId,
  readJson,
  repositoryRoot,
  sha256,
  tokenLimit,
  v2Root,
  wallTimeLimitMs,
} from "./lib.mjs";

const sourceRuns = [
  {
    phase: "development-smoke",
    runId: "DEV-V2-A4-01",
    dossierId: "dev-v2-release-discussions",
    sourceDossierId: "dev-release-discussions",
    sourcePartition: "development",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-V2-A4-01",
    dossierId: "pilot-v2-feature-repo-delete",
    sourceDossierId: "pilot-feature-repo-delete",
    sourcePartition: "excluded-pilot",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-V2-A4-02",
    dossierId: "pilot-v2-bugfix-rest-errors",
    sourceDossierId: "pilot-bugfix-rest-errors",
    sourcePartition: "excluded-pilot",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-V2-A4-03",
    dossierId: "pilot-v2-mixed-repo-create",
    sourceDossierId: "pilot-mixed-repo-create",
    sourcePartition: "excluded-pilot",
  },
];
const secretEnvironmentNames = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const usageColumns = [
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

function sessionIdFor(runId, dossierId) {
  const bytes = createHash("sha256")
    .update(`${protocolId}\0${runId}\0${dossierId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceDossier(run) {
  const path = resolve(
    experimentRoot,
    "fixtures",
    "dossiers",
    run.sourcePartition,
    `${run.sourceDossierId}.json`,
  );
  const dossier = readJson(path);
  assert(dossier.dossierId === run.sourceDossierId, `source dossier mismatch for ${run.runId}`);
  return { ...dossier, dossierId: run.dossierId };
}

function sourceInventory(run) {
  return readJson(resolve(experimentRoot, "evaluator", "gold", `${run.sourceDossierId}.json`));
}

function taskEnvelope(run, dossierSha256) {
  return {
    formatVersion: 1,
    protocolId,
    phase: run.phase,
    arm: "A4",
    runId: run.runId,
    dossierId: run.dossierId,
    dossierSha256,
    outputPath: `drafts/${run.dossierId}.md`,
    instruction: [
      "Produce exactly one grounded customer-facing Markdown release-note draft from the",
      "configured frozen dossier. Invoke the release-note-synthesis Skill exactly once and",
      "delegate exactly once to release-note-haiku. The worker must call each canonical",
      "release-notes MCP tool exactly once in read-then-write order. Do not browse, search,",
      "use general tools, inspect other paths, or add facts absent from the dossier. Return",
      "only the exact compact status envelope. Preserve any failure without retrying.",
    ].join(" "),
  };
}

function mcpConfig(workspaceRoot) {
  return {
    mcpServers: {
      "release-notes": {
        command: process.execPath,
        args: [resolve(workspaceRoot, "tools", "release-note-mcp", "v2-server.mjs")],
        tools: ["read_release_dossier", "write_release_note_draft"],
      },
    },
  };
}

function runConfig({ run, dossierPath, dossierSha256, workspaceRoot, token, envelopeSha256 }) {
  return {
    version: 1,
    runId: run.runId,
    arm: "A4",
    taskEnvelopeSha256: envelopeSha256,
    sandboxKind: "container",
    sandboxTokenHash: `sha256:${sha256(Buffer.from(token, "utf8"))}`,
    dossier: { path: dossierPath, sha256: dossierSha256 },
    output: {
      path: resolve(workspaceRoot, "output", "draft.md"),
      relativePath: `drafts/${run.dossierId}.md`,
    },
    audit: { path: resolve(workspaceRoot, "audit", "mcp-audit.jsonl") },
    limits: { maxDossierBytes: 64 * 1024, maxDraftBytes: 8 * 1024 },
  };
}

function materializeWorkspace(runRoot, run, forbiddenPaths) {
  const workspaceRoot = resolve(runRoot, "workspace");
  const candidateRoot = resolve(v2Root, "candidate");
  cpSync(candidateRoot, workspaceRoot, { recursive: true, errorOnExist: true, force: false });
  const mcpRoot = resolve(workspaceRoot, "tools", "release-note-mcp");
  for (const name of ["lib.mjs", "protocol.mjs"]) {
    copyFileSync(resolve(repositoryRoot, "tools", "release-note-mcp", name), resolve(mcpRoot, name));
  }
  copyFileSync(
    resolve(repositoryRoot, "tools", "release-note-mcp", "server.mjs"),
    resolve(mcpRoot, "server-core.mjs"),
  );
  mkdirSync(resolve(workspaceRoot, "contract"), { recursive: true });
  mkdirSync(resolve(workspaceRoot, "output"), { recursive: true });
  mkdirSync(resolve(workspaceRoot, "audit"), { recursive: true });
  const dossier = sourceDossier(run);
  const dossierBytes = jsonBytes(dossier);
  const dossierPath = resolve(workspaceRoot, "contract", "dossier.json");
  writeOnce(dossierPath, dossierBytes);
  const isolation = {
    version: 1,
    attestationPath: resolve(workspaceRoot, "audit", "isolation-attestation.json"),
    forbiddenPaths,
    workspaceRoot,
  };
  const isolationPath = resolve(workspaceRoot, "contract", "isolation-config.json");
  writeOnce(isolationPath, jsonBytes(isolation));
  return { workspaceRoot, dossier, dossierBytes, dossierPath, isolationPath };
}

function createIsolatedHome(workRoot, actualUserProfile, forbiddenPaths) {
  const isolatedProfile = resolve(workRoot, "isolated-profile");
  const copilotHome = resolve(isolatedProfile, ".copilot");
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
          deniedPaths: forbiddenPaths,
          clearPolicyOnExit: true,
        },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    },
  };
  writeOnce(resolve(copilotHome, "settings.json"), jsonBytes(settings));
  assert(resolve(actualUserProfile) !== resolve(isolatedProfile), "isolated profile must differ");
  return { isolatedProfile, copilotHome, settings };
}

function cliArgs({ prompt, sessionId, workspaceRoot, mcpPath }) {
  return [
    "-p", prompt,
    "--session-id", sessionId,
    "--model", "gpt-5.6-sol",
    "--output-format", "json",
    "-C", workspaceRoot,
    "--allow-all-tools",
    `--available-tools=${availableTools.join(",")}`,
    "--additional-mcp-config", `@${mcpPath}`,
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--experimental",
    "--context", "default",
    "--effort", "medium",
    `--secret-env-vars=${secretEnvironmentNames.join(",")}`,
  ];
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
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = runCommand(command, [...prefix, "-c", script, database, sessionId], {
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
    failures.push(result.error?.message ?? result.stderr?.trim());
  }
  throw new Error(`isolated usage export failed: ${failures.join("; ")}`);
}

function writeRuntimeResearch() {
  const runtimeRoot = resolve(evidenceRoot, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const commands = [
    ["version", ["--version"]],
    ["help", ["--help"]],
    ["environment-help", ["help", "environment"]],
    ["sandbox-help", ["help", "sandbox"]],
    ["skill-help", ["skill", "--help"]],
  ];
  const records = [];
  for (const [name, args] of commands) {
    const result = runCommand("copilot", args, { cwd: repositoryRoot });
    assert(result.status === 0, `copilot ${args.join(" ")} failed`);
    const bytes = result.stdout;
    writeFileSync(resolve(runtimeRoot, `${name}.txt`), bytes);
    records.push({ name, args, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const help = readFileSync(resolve(runtimeRoot, "help.txt"), "utf8");
  const environment = readFileSync(resolve(runtimeRoot, "environment-help.txt"), "utf8");
  const sandbox = readFileSync(resolve(runtimeRoot, "sandbox-help.txt"), "utf8");
  for (const flag of [
    "--available-tools", "--additional-mcp-config", "--disable-builtin-mcps",
    "--disallow-temp-dir", "--secret-env-vars", "--no-custom-instructions",
    "--session-id", "--model", "--output-format",
  ]) assert(help.includes(flag), `CLI help lacks required ${flag}`);
  assert(environment.includes("COPILOT_HOME"), "CLI environment help lacks COPILOT_HOME");
  for (const term of ["Windows", "sandboxMcpServers", "deniedPaths", "allowBypass"]) {
    assert(sandbox.includes(term), `CLI sandbox help lacks ${term}`);
  }
  const summary = {
    formatVersion: 1,
    protocolId,
    capturedBeforeAnyV2LifecycleMarker: true,
    copilotVersion: readFileSync(resolve(runtimeRoot, "version.txt"), "utf8").trim(),
    supportedControls: {
      isolatedConfigurationHome: "COPILOT_HOME",
      closedModelToolSurface: "--available-tools",
      builtInMcpDisablement: "--disable-builtin-mcps",
      tempDirectoryDenial: "--disallow-temp-dir",
      localMcpSandboxing: "sandbox.sandboxMcpServers",
      filesystemDenial: "sandbox.userPolicy.filesystem.deniedPaths",
      bypassDisabled: "sandbox.allowBypass=false",
    },
    documentedLimitations: [
      "The CLI has no documented flag that disables built-in Skills individually.",
      "Built-in file edits are described as best-effort rather than OS-sandboxed; no file-edit tool is exposed.",
      "The AI-credit limit is post-call and is not a hard token ceiling; token usage is checked after the run.",
    ],
    commandEvidence: records,
  };
  replaceJson(resolve(runtimeRoot, "research-summary.json"), summary);
  return summary;
}

export function candidateManifest() {
  const paths = [
    ...filesUnder(resolve(v2Root, "candidate")),
    ...["lib.mjs", "protocol.mjs", "server.mjs"].map((name) =>
      resolve(repositoryRoot, "tools", "release-note-mcp", name)),
  ];
  const files = paths.sort().map((path) => {
    const bytes = readFileSync(path);
    return {
      source: relative(repositoryRoot, path).replaceAll("\\", "/"),
      target: path.includes(`${resolve(v2Root, "candidate")}`)
        ? relative(resolve(v2Root, "candidate"), path).replaceAll("\\", "/")
        : path.endsWith("server.mjs")
          ? "tools/release-note-mcp/server-core.mjs"
          : `tools/release-note-mcp/${basename(path)}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const aggregate = files.map((file) =>
    `${file.target}\0${file.bytes}\0${file.sha256}\n`).join("");
  return {
    formatVersion: 1,
    protocolId,
    canonicalTools,
    files,
    fileSetSha256: sha256(Buffer.from(aggregate, "utf8")),
  };
}

function probeMcpSurface(workRoot) {
  const probeRoot = resolve(workRoot, "preflight");
  mkdirSync(resolve(probeRoot, "output"), { recursive: true });
  mkdirSync(resolve(probeRoot, "audit"), { recursive: true });
  mkdirSync(resolve(probeRoot, "contract"), { recursive: true });
  mkdirSync(resolve(probeRoot, "tools", "release-note-mcp"), { recursive: true });
  for (const name of ["lib.mjs", "protocol.mjs", "server.mjs"]) {
    const target = name === "server.mjs" ? "server-core.mjs" : name;
    copyFileSync(
      resolve(repositoryRoot, "tools", "release-note-mcp", name),
      resolve(probeRoot, "tools", "release-note-mcp", target),
    );
  }
  const dossierBytes = jsonBytes({ formatVersion: 1, dossierId: "dev-v2-preflight", sources: [] });
  const dossierPath = resolve(probeRoot, "contract", "dossier.json");
  writeOnce(dossierPath, dossierBytes);
  const token = randomBytes(32).toString("base64url");
  const config = {
    version: 1,
    runId: "DEV-V2-PREFLIGHT",
    arm: "A4",
    taskEnvelopeSha256: "0".repeat(64),
    sandboxKind: "container",
    sandboxTokenHash: `sha256:${sha256(Buffer.from(token, "utf8"))}`,
    dossier: { path: dossierPath, sha256: sha256(dossierBytes) },
    output: { path: resolve(probeRoot, "output", "draft.md"), relativePath: "drafts/preflight.md" },
    audit: { path: resolve(probeRoot, "audit", "mcp-audit.jsonl") },
    limits: { maxDossierBytes: 64 * 1024, maxDraftBytes: 8 * 1024 },
  };
  const configPath = resolve(probeRoot, "contract", "run-config.json");
  writeOnce(configPath, jsonBytes(config));
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = runCommand(
    process.execPath,
    [resolve(probeRoot, "tools", "release-note-mcp", "server-core.mjs")],
    {
      cwd: probeRoot,
      input,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        RELEASE_NOTE_RUN_CONFIG: configPath,
        RELEASE_NOTE_SANDBOX_TOKEN: token,
      },
    },
  );
  assert(result.status === 0, `MCP schema preflight failed: ${result.stderr.trim()}`);
  const responses = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  const tools = responses.find((response) => response.id === 2)?.result?.tools;
  assert(Array.isArray(tools), "MCP schema preflight lacks tools/list");
  assert(
    JSON.stringify(tools.map((tool) => `release-notes/${tool.name}`)) === JSON.stringify(canonicalTools),
    "MCP schema names differ from canonical tools",
  );
  rmSync(probeRoot, { recursive: true, force: true });
  return tools;
}

function validateCandidateSchema(manifest, toolSchemas) {
  const agent = readFileSync(
    resolve(v2Root, "candidate", ".github", "agents", "release-note-haiku.agent.md"),
    "utf8",
  );
  const skill = readFileSync(
    resolve(v2Root, "candidate", ".github", "skills", "release-note-synthesis", "SKILL.md"),
    "utf8",
  );
  assert(!/^target:/mu.test(agent), "candidate agent uses a CLI-unsupported target field");
  assert(agent.includes("model: claude-haiku-4.5"), "candidate worker model is not fixed");
  for (const tool of canonicalTools) {
    assert(agent.includes(`- ${tool}`), `candidate agent lacks ${tool}`);
  }
  assert(skill.includes("release-note-haiku"), "candidate Skill does not route to release-note-haiku");
  assert(manifest.canonicalTools.every((tool) => tool.includes("/")), "canonical tools must be slash-qualified");
  assert(toolSchemas.length === 2, "MCP schema count differs from two");
  const v2Text = filesUnder(v2Root).map((path) => readFileSync(path, "utf8")).join("\n");
  assert(!/release-notes-(?:read|write)_release_/u.test(v2Text), "v2 contains a normalized MCP alias");
}

function safeReadJson(path, fallback = []) {
  try {
    return readJson(path);
  } catch {
    return fallback;
  }
}

function executeRun({
  workRoot,
  copilotHome,
  isolatedProfile,
  run,
  startIndex,
  forbiddenPaths,
  candidate,
}) {
  const runRoot = resolve(workRoot, "runs", run.runId);
  mkdirSync(runRoot, { recursive: true });
  const materialized = materializeWorkspace(runRoot, run, forbiddenPaths);
  const dossierSha256 = sha256(materialized.dossierBytes);
  const envelope = taskEnvelope(run, dossierSha256);
  const prompt = canonicalJson(envelope);
  const envelopeSha256 = sha256(Buffer.from(prompt, "utf8"));
  const token = randomBytes(32).toString("base64url");
  const config = runConfig({
    run,
    dossierPath: materialized.dossierPath,
    dossierSha256,
    workspaceRoot: materialized.workspaceRoot,
    token,
    envelopeSha256,
  });
  const configPath = resolve(materialized.workspaceRoot, "contract", "run-config.json");
  const mcpPath = resolve(materialized.workspaceRoot, "contract", "mcp-config.json");
  writeOnce(configPath, jsonBytes(config));
  writeOnce(mcpPath, jsonBytes(mcpConfig(materialized.workspaceRoot)));
  const sessionId = sessionIdFor(run.runId, run.dossierId);
  const args = cliArgs({
    prompt,
    sessionId,
    workspaceRoot: materialized.workspaceRoot,
    mcpPath,
  });
  const startedAt = new Date().toISOString();
  const capture = {
    phase: run.phase,
    runId: run.runId,
    dossierId: run.dossierId,
    sourceDossierId: run.sourceDossierId,
    sessionId,
    startedAt,
    disposition: "started",
    dossierSha256,
    taskEnvelopeSha256: envelopeSha256,
    candidateFileSetSha256: candidate.fileSetSha256,
  };
  startIndex.captures.push(capture);
  replaceJson(resolve(evidenceRoot, "start-index.json"), startIndex);

  const env = {
    ...process.env,
    HOME: isolatedProfile,
    USERPROFILE: isolatedProfile,
    COPILOT_HOME: copilotHome,
    RELEASE_NOTE_RUN_CONFIG: configPath,
    RELEASE_NOTE_ISOLATION_CONFIG: materialized.isolationPath,
    RELEASE_NOTE_SANDBOX_TOKEN: token,
  };
  const result = runCommand("copilot", args, {
    cwd: materialized.workspaceRoot,
    timeout: wallTimeLimitMs,
    env,
  });
  const endedAt = new Date().toISOString();
  const rawBytes = result.stdout ?? Buffer.alloc(0);
  const stderrBytes = result.stderr ?? Buffer.alloc(0);
  for (const name of secretEnvironmentNames) {
    const value = process.env[name];
    assert(!value || (!rawBytes.includes(value) && !stderrBytes.includes(value)), `${name} leaked to captured output`);
  }
  let events = [];
  let parseFailure = null;
  try {
    events = parseEvents(rawBytes);
  } catch (error) {
    parseFailure = error.message;
  }
  let usageRows = [];
  let usageFailure = null;
  try {
    usageRows = exportUsage(resolve(copilotHome, "session-store.db"), sessionId);
  } catch (error) {
    usageFailure = error.message;
  }
  const auditPath = config.audit.path;
  const attestationPath = resolve(materialized.workspaceRoot, "audit", "isolation-attestation.json");
  const draftPath = config.output.path;
  const audit = existsSync(auditPath)
    ? readFileSync(auditPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)
    : [];
  const attestation = safeReadJson(attestationPath, null);
  const draftBytes = existsSync(draftPath) ? readFileSync(draftPath) : null;
  let evidence;
  if (parseFailure) {
    evidence = {
      formatVersion: 1,
      protocolId,
      phase: run.phase,
      permanentlyExcludedFromConfirmation: true,
      runId: run.runId,
      dossierId: run.dossierId,
      sessionId,
      startedAt,
      endedAt,
      disposition: "measured-failure",
      operationalSuccess: false,
      treatmentAdherent: false,
      failureReasons: [parseFailure, ...(usageFailure ? [usageFailure] : [])],
      usage: { total: { modelTokens: null } },
      timing: { wallTimeMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  } else {
    evidence = deriveEvidence({
      run: { ...run, sessionId },
      events,
      rawBytes,
      usageRows,
      audit,
      attestation,
      draftBytes,
      processResult: result,
      startedAt,
      endedAt,
      expectedDossierSha256: dossierSha256,
    });
    if (usageFailure) {
      evidence.failureReasons.push(usageFailure);
      evidence.disposition = "measured-failure";
      evidence.operationalSuccess = false;
      evidence.treatmentAdherent = false;
    }
  }
  evidence.launch = {
    executable: "copilot",
    args,
    environment: {
      COPILOT_HOME: "<isolated-profile>/.copilot",
      HOME: "<isolated-profile>",
      USERPROFILE: "<isolated-profile>",
      RELEASE_NOTE_RUN_CONFIG: "contract/run-config.json",
      RELEASE_NOTE_ISOLATION_CONFIG: "contract/isolation-config.json",
      RELEASE_NOTE_SANDBOX_TOKEN: "<ephemeral-secret-not-preserved>",
    },
  };
  const checkedRunRoot = resolve(evidenceRoot, "runs", run.runId);
  mkdirSync(checkedRunRoot, { recursive: true });
  writeOnce(resolve(checkedRunRoot, "copilot-events.jsonl"), rawBytes);
  writeOnce(resolve(checkedRunRoot, "copilot-stderr.txt"), stderrBytes);
  writeOnce(resolve(checkedRunRoot, "run-evidence.json"), jsonBytes(evidence));
  writeOnce(resolve(checkedRunRoot, "usage.json"), jsonBytes({
    formatVersion: 1,
    source: "isolated COPILOT_HOME assistant_usage_events",
    sessionId,
    rows: usageRows,
    error: usageFailure,
  }));
  for (const [source, target] of [
    [configPath, "run-config.json"],
    [mcpPath, "mcp-config.json"],
    [materialized.isolationPath, "isolation-config.json"],
    [auditPath, "mcp-audit.jsonl"],
    [attestationPath, "isolation-attestation.json"],
  ]) {
    if (existsSync(source)) copyFileSync(source, resolve(checkedRunRoot, target));
  }
  if (draftBytes) {
    const draftTarget = resolve(evidenceRoot, "drafts", `${run.dossierId}.md`);
    mkdirSync(dirname(draftTarget), { recursive: true });
    writeOnce(draftTarget, draftBytes);
  }
  return { evidence, dossier: materialized.dossier, draftBytes };
}

function frozenDevelopmentGate(candidate, research, toolSchemas) {
  return {
    formatVersion: 1,
    protocolId,
    phase: "development-smoke",
    permanentlyExcludedFromConfirmation: true,
    frozenBeforeStart: true,
    runId: sourceRuns[0].runId,
    dossierId: sourceRuns[0].dossierId,
    parentModel: "gpt-5.6-sol",
    workerModel: "claude-haiku-4.5",
    canonicalTools,
    availableTools,
    candidateFileSetSha256: candidate.fileSetSha256,
    toolSchemaSha256: sha256(Buffer.from(canonicalJson(toolSchemas), "utf8")),
    copilotVersion: research.copilotVersion,
    required: {
      exactCustomAgentSchema: true,
      unknownToolWarnings: 0,
      canonicalWorkerToolStarts: 2,
      canonicalWorkerToolCompletes: 2,
      auditSequence: ["service.started", "dossier.read", "draft.written", "run.completed"],
      exactCompactEnvelope: true,
      parentModel: "gpt-5.6-sol",
      workerModel: "claude-haiku-4.5",
      unexpectedActors: 0,
      unexpectedSurfaces: 0,
      forbiddenRootsAccessible: 0,
      totalModelTokensMaximum: tokenLimit,
      wallTimeMsMaximum: wallTimeLimitMs,
    },
    abandonmentRule: [
      "Abandon v2 on this runtime if both canonical structured worker calls are not observed.",
      "Abandon v2 on this runtime if unrelated surfaces are not excluded.",
      "Abandon v2 on this runtime if a successful development run exceeds either ceiling.",
      "Never retry or tune the consumed development run ID.",
    ],
  };
}

function freezePilotGate(smokeEvidence, candidate, research) {
  const runs = sourceRuns.filter((run) => run.phase === "excluded-pilot");
  const gate = {
    formatVersion: 1,
    protocolId,
    phase: "excluded-pilot",
    permanentlyExcludedFromConfirmation: true,
    frozenBeforeAnyPilotStart: true,
    frozenAt: new Date().toISOString(),
    authorizedBySmoke: {
      runId: smokeEvidence.runId,
      evidenceSha256: sha256(jsonBytes(smokeEvidence)),
      disposition: smokeEvidence.disposition,
    },
    copilotVersion: research.copilotVersion,
    candidateFileSetSha256: candidate.fileSetSha256,
    runOrder: runs.map((run) => ({ runId: run.runId, dossierId: run.dossierId })),
    required: {
      operationalSuccess: 3,
      treatmentAdherent: 3,
      unsupportedCriticalClaims: 0,
      readsPerRun: 1,
      writesPerRun: 1,
      compactReturn: true,
      isolatedSurface: true,
    },
    limits: {
      canonicalMcpCallsPerRun: 2,
      totalModelTokensPerRun: tokenLimit,
      wallTimeMsPerRun: wallTimeLimitMs,
    },
    retryPolicy: "none-after-start",
  };
  writeOnce(resolve(evidenceRoot, "pilot-gate.json"), jsonBytes(gate));
  return gate;
}

function evaluatePilot(run, dossier, draftBytes) {
  if (!draftBytes) return null;
  const inventory = sourceInventory(run);
  const evaluation = evaluateDraft({ dossier, inventory, draftBytes });
  const path = resolve(evidenceRoot, "evaluations", `${run.dossierId}.json`);
  writeOnce(path, jsonBytes(evaluation));
  return evaluation;
}

function summarize(smokeEvidence, pilotRecords) {
  const smokePassed = smokeEvidence.operationalSuccess && smokeEvidence.treatmentAdherent;
  const operationalSuccess = pilotRecords.filter((record) => record.evidence.operationalSuccess).length;
  const treatmentAdherent = pilotRecords.filter((record) => record.evidence.treatmentAdherent).length;
  const evaluationsAvailable = pilotRecords.length === 3
    && pilotRecords.every((record) => record.evaluation);
  const unsupportedCriticalClaims = evaluationsAvailable
    ? pilotRecords.reduce((total, record) =>
      total + record.evaluation.deterministicScreen.unsupportedCriticalClaims.length, 0)
    : null;
  const pilotsPassed = pilotRecords.length === 3
    && operationalSuccess === 3
    && treatmentAdherent === 3
    && unsupportedCriticalClaims === 0;
  const disposition = smokePassed && pilotsPassed ? "GO" : "NO-GO";
  const abandonedAfterSmoke = !smokePassed;
  return {
    formatVersion: 1,
    protocolId,
    permanentlyExcludedFromConfirmation: true,
    disposition,
    recommendation: disposition === "GO"
      ? "Proceed only to a separate confirmatory preregistration; do not treat these excluded units as confirmation."
      : "Abandon the release-note Agent Skill Pattern candidate on the current runtime; do not retry, tune, or run confirmation.",
    smoke: {
      runId: smokeEvidence.runId,
      disposition: smokeEvidence.disposition,
      failureReasons: smokeEvidence.failureReasons,
      modelTokens: smokeEvidence.usage?.total?.modelTokens ?? null,
      wallTimeMs: smokeEvidence.timing?.wallTimeMs ?? null,
    },
    pilot: {
      authorized: smokePassed,
      started: pilotRecords.length,
      operationalSuccess,
      treatmentAdherent,
      unsupportedCriticalClaims,
      evaluationsAvailable,
      runs: pilotRecords.map((record) => ({
        runId: record.evidence.runId,
        dossierId: record.evidence.dossierId,
        disposition: record.evidence.disposition,
        failureReasons: record.evidence.failureReasons,
        modelTokens: record.evidence.usage?.total?.modelTokens ?? null,
        wallTimeMs: record.evidence.timing?.wallTimeMs ?? null,
        unsupportedCriticalClaims:
          record.evaluation?.deterministicScreen.unsupportedCriticalClaims.length ?? null,
      })),
    },
    semanticQualityTested: evaluationsAvailable,
    semanticQualityStatement: evaluationsAvailable
      ? "Release-note semantic quality was tested on all three permanently excluded v2 pilot units."
      : "Release-note semantic quality was not tested because the frozen development abandonment rule stopped the pilot.",
    abandonmentRuleFired: abandonedAfterSmoke,
    confirmationRunsExecuted: 0,
  };
}

function report(summary) {
  const runRows = [
    `| ${summary.smoke.runId} | development smoke | ${summary.smoke.disposition} | ${summary.smoke.modelTokens ?? "unavailable"} | ${summary.smoke.wallTimeMs ?? "unavailable"} |`,
    ...summary.pilot.runs.map((run) =>
      `| ${run.runId} | excluded pilot | ${run.disposition} | ${run.modelTokens ?? "unavailable"} | ${run.wallTimeMs ?? "unavailable"} |`),
  ];
  return [
    "# Release-note v2 repair disposition",
    "",
    `**${summary.disposition}.** ${summary.recommendation}`,
    "",
    summary.semanticQualityStatement,
    "",
    "| Run | Phase | Disposition | Model tokens | Wall time (ms) |",
    "|---|---|---|---:|---:|",
    ...runRows,
    "",
    `- Smoke abandonment rule fired: ${summary.abandonmentRuleFired}`,
    `- Pilot authorized: ${summary.pilot.authorized}`,
    `- Pilot operational success: ${summary.pilot.operationalSuccess}/3`,
    `- Pilot treatment adherence: ${summary.pilot.treatmentAdherent}/3`,
    `- Pilot unsupported critical claims: ${summary.pilot.unsupportedCriticalClaims ?? "not tested"}`,
    "- Main/confirmatory units executed: 0",
    "",
    "The v0 evidence and identifiers remain immutable and are not part of this v2 disposition.",
    "",
  ].join("\n");
}

export function buildEvidenceManifest() {
  const manifestPath = resolve(evidenceRoot, "manifest.json");
  const files = filesUnder(evidenceRoot, new Set([manifestPath])).map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(experimentRoot, path).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const aggregate = files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join("");
  return {
    formatVersion: 1,
    protocolId,
    permanentlyExcludedFromConfirmation: true,
    fileSetSha256: sha256(Buffer.from(aggregate, "utf8")),
    files,
  };
}

function packageEvidence() {
  writeFileSync(resolve(evidenceRoot, "manifest.json"), jsonBytes(buildEvidenceManifest()));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.includes("--execute"), "v2 repair requires explicit --execute");
  assert(argument("--evidence-root") === undefined, "v2 evidence root cannot be overridden");
  assert(!existsSync(resolve(evidenceRoot, "start-index.json")), "v2 lifecycle ledger already exists; retries are forbidden");
  const workRootArg = argument("--work-root");
  assert(workRootArg && resolve(workRootArg) === workRootArg, "--work-root must be an absolute path");
  const workRoot = resolve(workRootArg);
  assert(!resolve(workRoot).startsWith(`${resolve(repositoryRoot)}\\`), "work root must be outside the repository");
  if (existsSync(workRoot)) {
    assert(statSync(workRoot).isDirectory(), "work root must be a directory");
    assert(readdirSync(workRoot).length === 0, "work root must be empty");
  } else {
    mkdirSync(workRoot, { recursive: true });
  }
  mkdirSync(evidenceRoot, { recursive: true });
  const actualUserProfile = os.homedir();
  const forbiddenPaths = [
    repositoryRoot,
    resolve(experimentRoot, "evaluator"),
    resolve(experimentRoot, "results", "excluded-pilot"),
    actualUserProfile,
  ];
  const research = writeRuntimeResearch();
  const candidate = candidateManifest();
  replaceJson(resolve(evidenceRoot, "candidate-manifest.json"), candidate);
  const toolSchemas = probeMcpSurface(workRoot);
  validateCandidateSchema(candidate, toolSchemas);
  const { isolatedProfile, copilotHome } = createIsolatedHome(
    workRoot,
    actualUserProfile,
    forbiddenPaths,
  );
  const developmentGate = frozenDevelopmentGate(candidate, research, toolSchemas);
  replaceJson(resolve(evidenceRoot, "development-gate.json"), developmentGate);
  const startIndex = {
    formatVersion: 1,
    protocolId,
    permanentlyExcludedFromConfirmation: true,
    planned: sourceRuns.map(({ phase, runId, dossierId }) => ({ phase, runId, dossierId })),
    captures: [],
  };
  const smoke = executeRun({
    workRoot,
    copilotHome,
    isolatedProfile,
    run: sourceRuns[0],
    startIndex,
    forbiddenPaths,
    candidate,
  });
  const pilotRecords = [];
  if (smoke.evidence.operationalSuccess && smoke.evidence.treatmentAdherent) {
    freezePilotGate(smoke.evidence, candidate, research);
    for (const run of sourceRuns.filter((item) => item.phase === "excluded-pilot")) {
      const result = executeRun({
        workRoot,
        copilotHome,
        isolatedProfile,
        run,
        startIndex,
        forbiddenPaths,
        candidate,
      });
      pilotRecords.push({
        ...result,
        evaluation: evaluatePilot(run, result.dossier, result.draftBytes),
      });
    }
  }
  const summary = summarize(smoke.evidence, pilotRecords);
  writeOnce(resolve(evidenceRoot, "summary.json"), jsonBytes(summary));
  writeOnce(resolve(evidenceRoot, "report.md"), Buffer.from(report(summary), "utf8"));
  packageEvidence();
  process.stdout.write(
    `V2 disposition: ${summary.disposition}; smoke=${summary.smoke.disposition}; pilots=${summary.pilot.started}\n`,
  );
}
