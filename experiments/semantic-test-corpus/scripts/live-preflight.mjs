#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRequestHash } from "../../../tools/semantic-corpus-mcp/lib.mjs";
import { auditDelegatedEventSequence } from "./collect-local-evidence.mjs";
import {
  COPILOT_VERSION,
  MCP_TOOL_NAMES,
  availableToolsForArm,
  buildCopilotArgs,
  parseCopilotJsonl,
  predeterminedSessionId,
  resultEvent
} from "./copilot-cli-v5.mjs";
import { exportLocalUsage } from "./export-local-usage.mjs";
import { materializeCandidate } from "./materialize-candidate.mjs";
import { probeGeneratedMcp, EXPECTED_TOOLS } from "./mcp-live-probe.mjs";
import { preflightExecution } from "./preflight-execution.mjs";
import { createSandbox } from "./run-controlled-harness.mjs";
import {
  currentLiveBuilderBindings,
  PILOT_TASK,
  validateLivePreflight
} from "./validate-live-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "arm-contract.json"), "utf8")
);
const conditions = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "condition-instructions.json"), "utf8")
);
export const PILOT_NAMESPACE = contract.commonContract.livePreflight.namespace;

const EXPECTED_TERMINAL = "corpus-staging/manifest.json - 1 scenarios - SUCCESS";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, resolve(command)]
    : [command];
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function pilotRequest() {
  const request = {
    version: 1,
    targetCount: 1,
    scenarios: [{ scenarioId: "pilot-scenario-001", category: "pilot-only" }],
    categories: [{ category: "pilot-only", minQuota: 1 }],
    maxSizes: {
      contractFileBytes: 262144,
      scenarioBytes: 65536,
      manifestBytes: 262144
    },
    v1ConfigSchema: {
      type: "object",
      additionalProperties: false,
      required: ["version", "id", "enabled"],
      properties: {
        version: { type: "integer", const: 1 },
        id: { type: "string", minLength: 1, maxLength: 40 },
        enabled: { type: "boolean" }
      }
    }
  };
  request.requestHash = computeRequestHash(request);
  return request;
}

function preparePilotCandidate(candidateRoot) {
  materializeCandidate(candidateRoot, { blockId: "B01" });
  const requestPath = resolve(candidateRoot, "corpus-contract", "request.json");
  const taskPath = resolve(candidateRoot, contract.commonContract.taskArtifact);
  chmodSync(requestPath, 0o666);
  chmodSync(taskPath, 0o666);
  writeFileSync(requestPath, jsonBytes(pilotRequest()));
  writeFileSync(taskPath, Buffer.from(PILOT_TASK, "utf8"));
  git(candidateRoot, ["add", "corpus-contract/request.json", contract.commonContract.taskArtifact]);
  git(candidateRoot, [
    "-c", "user.name=Semantic Benchmark Coordinator",
    "-c", "user.email=benchmark.invalid",
    "commit", "--quiet", "-m", "Prepare pilot-only live preflight"
  ]);
  return {
    terminalCommit: git(candidateRoot, ["rev-parse", "HEAD"]),
    taskBytes: readFileSync(taskPath)
  };
}

function mcpName(event) {
  const server = event.data?.mcpServerName;
  const tool = event.data?.mcpToolName;
  return typeof server === "string" && typeof tool === "string"
    ? `${server}/${tool}`
    : null;
}

function usageSummary(rows, workerCallId) {
  const numeric = (field) => rows.reduce((sum, row) =>
    sum + (typeof row[field] === "number" && Number.isFinite(row[field]) ? row[field] : 0), 0);
  return {
    parentCompletions: rows.filter((row) =>
      row.agent_id === null && row.parent_tool_call_id === null).length,
    workerCompletions: workerCallId === null || workerCallId === undefined
      ? 0
      : rows.filter((row) =>
          row.agent_id === workerCallId && row.parent_tool_call_id === workerCallId).length,
    inputTokens: numeric("input_tokens"),
    outputTokens: numeric("output_tokens"),
    reasoningTokens: numeric("reasoning_tokens"),
    nanoAiu: numeric("total_nano_aiu"),
    durationMs: numeric("duration_ms")
  };
}

function auditMcp(events, { delegated, workerCallId }) {
  const reasons = [];
  const starts = events.filter((event) =>
    event.type === "tool.execution_start"
    && MCP_TOOL_NAMES.includes(`semantic-corpus-${event.data?.mcpToolName}`));
  const required = [
    "semantic-corpus/list_contract_files",
    "semantic-corpus/read_contract_file",
    "semantic-corpus/write_scenario_input",
    "semantic-corpus/write_scenario_manifest"
  ];
  for (const name of required) {
    if (!starts.some((event) => mcpName(event) === name)) reasons.push(`missing ${name}`);
  }
  for (const start of starts) {
    const complete = events.filter((event) =>
      event.type === "tool.execution_complete"
      && event.data?.toolCallId === start.data?.toolCallId);
    if (complete.length !== 1 || complete[0].data?.success !== true) {
      reasons.push(`${mcpName(start)} lacks one successful completion`);
    }
    if (delegated && (start.agentId !== workerCallId
      || start.data?.parentToolCallId !== workerCallId)) {
      reasons.push(`${mcpName(start)} is not worker-attributed`);
    }
    if (!delegated && (start.agentId || start.data?.parentToolCallId)) {
      reasons.push(`${mcpName(start)} is not parent-attributed`);
    }
  }
  return reasons;
}

function terminalReturn(events, delegated) {
  if (!delegated) {
    return events.filter((event) =>
      event.type === "assistant.message" && !event.agentId).at(-1)?.data?.content ?? null;
  }
  const task = events.find((event) =>
    event.type === "tool.execution_start" && event.data?.toolName === "task");
  return events.find((event) =>
    event.type === "tool.execution_complete"
    && event.data?.toolCallId === task?.data?.toolCallId)?.data?.result?.content ?? null;
}

function auditInline({ events, usageRows, kickoff, arm }) {
  const reasons = [];
  const external = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source !== "skill-semantic-test-corpus");
  if (external.length !== 1 || external[0].data?.content !== kickoff) {
    reasons.push("external user steering differs from the pilot kickoff");
  }
  if (events.some((event) =>
    event.type === "tool.execution_start"
    && ["skill", "task"].includes(event.data?.toolName))) {
    reasons.push("inline smoke invoked Skill or task");
  }
  const models = [...new Set(events
    .filter((event) => !event.agentId
      && ["model.call_start", "assistant.message"].includes(event.type))
    .map((event) => event.data?.model)
    .filter(Boolean))];
  if (models.length !== 1 || models[0] !== arm.model) {
    reasons.push("inline event model attribution is missing or incorrect");
  }
  const parentRows = usageRows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  if (parentRows.length === 0 || parentRows.some((row) => row.model !== arm.model)) {
    reasons.push("inline usage model attribution is missing or incorrect");
  }
  return { reasons, workerCallId: null };
}

function exportUsageWithRetry(sessionStore, sessionId) {
  let exported;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    exported = exportLocalUsage({ database: sessionStore, cliSessionId: sessionId });
    if (exported.rows.length > 0) return exported;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return exported;
}

export function runLivePreflight({
  cli,
  sessionStore,
  workRoot,
  pilotSeries = "R1",
  capturedAt = new Date().toISOString()
}) {
  if (!/^R[1-9][0-9]*$/u.test(pilotSeries)) {
    throw new Error("Pilot series must match R1, R2, and so on");
  }
  const staticPreflight = preflightExecution(cli, { sessionStore, capturedAt });
  const commonReasons = staticPreflight.arms
    .filter((arm) => arm.armId !== 0 && arm.status !== "available")
    .flatMap((arm) => arm.reasons);
  if (commonReasons.length > 0) {
    throw new Error(`Static preflight failed before live smoke: ${[...new Set(commonReasons)].join("; ")}`);
  }
  const base = resolve(workRoot);
  if (existsSync(base) && readdirSync(base).length > 0) {
    throw new Error("Live preflight work root must be absent or empty");
  }
  mkdirSync(base, { recursive: true });
  const arms = [];
  for (const armId of [1, 2, 3, 4, 5]) {
    const arm = contract.arms.find((item) => item.id === armId);
    const condition = conditions.conditions.find((item) => item.armId === armId);
    const pilotId = `P5-SMOKE-${pilotSeries}-A${armId}`;
    const sessionId = predeterminedSessionId(PILOT_NAMESPACE, pilotId);
    const candidateRoot = resolve(base, pilotId, "candidate");
    const artifactRoot = resolve(base, pilotId, "artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    const reasons = [];
    const treatmentObservations = [];
    let handshake = "fail";
    let eventsBytes = null;
    let usageBytes = null;
    let stagingBytes = null;
    let commandBytes = null;
    let terminal = null;
    let workerCallId = null;
    let usage = usageSummary([], null);
    try {
      const candidate = preparePilotCandidate(candidateRoot);
      const sandbox = createSandbox(candidateRoot);
      probeGeneratedMcp(sandbox);
      handshake = "pass";
      const kickoff = `${condition.kickoff}\n\n${PILOT_TASK}`;
      const args = buildCopilotArgs({
        prompt: kickoff,
        sessionId,
        model: arm.model,
        reasoningEffort: arm.reasoningEffort,
        topLevelAgent: arm.topLevelAgent,
        candidateRoot,
        mcpConfigPath: sandbox.mcpConfigPath,
        disabledMcpServers: staticPreflight.configuredMcpServers,
        availableTools: availableToolsForArm(arm)
      });
      const [executable, ...prefix] = commandParts(cli);
      commandBytes = jsonBytes({
        args,
        candidateRoot,
        mcpConfigPath: sandbox.mcpConfigPath,
        disabledMcpServers: staticPreflight.configuredMcpServers,
        availableTools: availableToolsForArm(arm)
      });
      writeFileSync(resolve(artifactRoot, "command.json"), commandBytes);
      const execution = spawnSync(executable, [...prefix, ...args], {
        cwd: candidateRoot,
        env: {
          ...process.env,
          SEMANTIC_CORPUS_SANDBOX_CONFIG: sandbox.configPath,
          SEMANTIC_CORPUS_SANDBOX_TOKEN: sandbox.token
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10 * 60_000,
        maxBuffer: 64 * 1024 * 1024
      });
      writeFileSync(resolve(artifactRoot, "stdout.jsonl"), execution.stdout ?? "");
      writeFileSync(resolve(artifactRoot, "stderr.txt"), execution.stderr ?? "");
      eventsBytes = Buffer.from(execution.stdout ?? "", "utf8");
      const events = parseCopilotJsonl(eventsBytes);
      const result = resultEvent(events, sessionId);
      if (execution.error || execution.status !== 0 || result.exitCode !== 0) {
        treatmentObservations.push(`Copilot exited process=${execution.status} result=${result.exitCode}: ${
          execution.error?.message ?? execution.stderr?.trim() ?? "unknown failure"
        }`);
      }
      const usageExport = exportUsageWithRetry(sessionStore, sessionId);
      usageBytes = jsonBytes(usageExport);
      writeFileSync(resolve(artifactRoot, "usage.json"), usageBytes);
      const audit = arm.delegated
        ? auditDelegatedEventSequence({
            events,
            usageRows: usageExport.rows,
            expectedKickoff: kickoff,
            expectedTaskBytes: candidate.taskBytes,
            expectedParentModel: arm.model,
            expectedWorkerModel: arm.workerModel,
            expectedAgent: arm.agentName
          })
        : auditInline({ events, usageRows: usageExport.rows, kickoff, arm });
      treatmentObservations.push(...audit.reasons);
      workerCallId = audit.workerCallId;
      treatmentObservations.push(...auditMcp(events, { delegated: arm.delegated, workerCallId }));
      terminal = terminalReturn(events, arm.delegated);
      if (terminal !== EXPECTED_TERMINAL) {
        treatmentObservations.push("terminal return differs from pilot contract");
      }
      const stagingRoot = sandbox.stagingRoot;
      const scenarioPath = resolve(stagingRoot, "scenarios", "pilot-scenario-001.json");
      const manifestPath = resolve(stagingRoot, "manifest.json");
      if (!existsSync(scenarioPath) || !existsSync(manifestPath)) {
        treatmentObservations.push("pilot staging lacks the scenario or manifest");
      } else {
        stagingBytes = Buffer.concat([readFileSync(scenarioPath), readFileSync(manifestPath)]);
      }
      usage = usageSummary(usageExport.rows, workerCallId);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
    arms.push({
      armId,
      pilotId,
      sessionId,
      parentModel: arm.model,
      workerModel: arm.workerModel ?? null,
      reasoningEffort: arm.reasoningEffort,
      mechanism: condition.execution,
      agentName: arm.agentName ?? null,
      status: reasons.length === 0 ? "eligible" : "infrastructure-failure",
      reasons,
      treatmentObservations,
      mcpHandshake: handshake,
      terminalReturn: terminal,
      eventsSha256: eventsBytes ? sha256(eventsBytes) : null,
      usageSha256: usageBytes ? sha256(usageBytes) : null,
      stagingSha256: stagingBytes ? sha256(stagingBytes) : null,
      commandSha256: commandBytes ? sha256(commandBytes) : null,
      usage,
      evidence: {
        eventsPath: resolve(artifactRoot, "stdout.jsonl"),
        usagePath: resolve(artifactRoot, "usage.json"),
        scenarioPath: resolve(candidateRoot, ".benchmark-runtime", "corpus-staging", "scenarios", "pilot-scenario-001.json"),
        manifestPath: resolve(candidateRoot, ".benchmark-runtime", "corpus-staging", "manifest.json"),
        commandPath: resolve(artifactRoot, "command.json")
      }
    });
  }
  const output = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    pilotNamespace: PILOT_NAMESPACE,
    pilotSeries,
    outcomeEligible: false,
    capturedAt,
    cliVersion: COPILOT_VERSION,
    expectedTools: EXPECTED_TOOLS,
    builderBindings: currentLiveBuilderBindings(),
    arms
  };
  const validationReasons = validateLivePreflight(output);
  if (validationReasons.some((reason) => reason.startsWith("$"))) {
    throw new Error(`Live preflight artifact is invalid: ${validationReasons.join("; ")}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cli = argument(args, "--cli");
  const sessionStore = argument(args, "--session-store");
  const workRoot = argument(args, "--work-root");
  const pilotSeries = argument(args, "--pilot-series");
  const out = argument(args, "--out");
  if (!cli || !sessionStore || !workRoot || !out) {
    throw new Error("Usage: node scripts/live-preflight.mjs --cli <copilot> --session-store <session-store.db> --work-root <empty-pilot-root> --out <live-preflight.json>");
  }
  const output = runLivePreflight({ cli, sessionStore, workRoot, pilotSeries: pilotSeries ?? "R1" });
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, jsonBytes(output), { flag: "wx" });
  process.stdout.write(`${output.arms.filter((arm) => arm.status === "eligible").length}/5 live arm surfaces eligible\n`);
  if (validateLivePreflight(output).length > 0) process.exitCode = 2;
}

export { PILOT_TASK };
