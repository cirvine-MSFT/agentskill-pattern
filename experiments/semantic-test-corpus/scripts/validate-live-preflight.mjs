import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { auditDelegatedEventSequence } from "./collect-local-evidence.mjs";
import {
  MCP_TOOL_NAMES,
  availableToolsForArm,
  buildCopilotArgs,
  parseCopilotJsonl,
  predeterminedSessionId,
  resultEvent
} from "./copilot-cli-v4.mjs";
import { protocolDesign } from "./protocol-design.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "live-preflight.schema.json"), "utf8"));
const contract = protocolDesign("v4").contract;
const conditions = protocolDesign("v4").conditions;
const PILOT_NAMESPACE = "semantic-test-corpus-v4-pilot-only";
const EXPECTED_TERMINAL = "corpus-staging/manifest.json - 1 scenarios - SUCCESS";
export const PILOT_TASK = [
  "Generate the immutable request's one pilot-only v1 configuration scenario.",
  "",
  "Use semantic-corpus/list_contract_files, then semantic-corpus/read_contract_file",
  "for request.json and every listed contract file. Call",
  "semantic-corpus/write_scenario_input exactly once for pilot-scenario-001 with only",
  "scenarioId and a closed-schema config. Then call",
  "semantic-corpus/write_scenario_manifest exactly once with the request-defined",
  "pilot-scenario-001/pilot-only pair.",
  "",
  "Do not read staging or produce expected results. Return exactly",
  "corpus-staging/manifest.json - 1 scenarios - SUCCESS after manifest success, or",
  "corpus-staging - <written-count> scenarios - FAILURE: <reason> after the first failure.",
  ""
].join("\n");
const BOUND_PATHS = [
  "design/v4/condition-instructions.json",
  "scripts/collect-local-evidence.mjs",
  "scripts/copilot-cli-v4.mjs",
  "scripts/execution-contract.mjs",
  "scripts/live-preflight.mjs",
  "scripts/materialize-candidate.mjs",
  "scripts/mcp-live-probe.mjs",
  "scripts/preflight-execution.mjs",
  "scripts/run-controlled-harness.mjs",
  "scripts/validate-live-preflight.mjs",
  "schemas/live-preflight.schema.json"
];

export function currentLiveBuilderBindings() {
  return BOUND_PATHS.map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")
  }));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function auditMcp(events, { delegated, workerCallId, scenario, manifest }) {
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
    const matching = starts.filter((event) => mcpName(event) === name);
    const expectedCount = name === "semantic-corpus/read_contract_file" ? null : 1;
    if (matching.length === 0) reasons.push(`missing ${name}`);
    if (expectedCount !== null && matching.length !== expectedCount) {
      reasons.push(`${name} must be called exactly once`);
    }
  }
  const scenarioWrite = starts.find((event) =>
    mcpName(event) === "semantic-corpus/write_scenario_input");
  const manifestWrite = starts.find((event) =>
    mcpName(event) === "semantic-corpus/write_scenario_manifest");
  if (JSON.stringify(scenarioWrite?.data?.arguments) !== JSON.stringify(scenario)) {
    reasons.push("scenario staging bytes differ from write_scenario_input arguments");
  }
  if (JSON.stringify(manifestWrite?.data?.arguments) !== JSON.stringify(manifest)) {
    reasons.push("manifest staging bytes differ from write_scenario_manifest arguments");
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

function auditInline(events, usageRows, kickoff, arm) {
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
  return reasons;
}

function verifyArmEvidence(record, pilotSeries) {
  const reasons = [];
  const arm = contract.arms.find((item) => item.id === record.armId);
  const condition = conditions.conditions.find((item) => item.armId === record.armId);
  const expectedPilotId = `P4-SMOKE-${pilotSeries}-A${record.armId}`;
  if (!arm || !condition
    || record.pilotId !== expectedPilotId
    || record.sessionId !== predeterminedSessionId(PILOT_NAMESPACE, record.pilotId)
    || record.parentModel !== arm.model
    || record.workerModel !== (arm.workerModel ?? null)
    || record.reasoningEffort !== arm.reasoningEffort
    || record.mechanism !== condition.execution
    || record.agentName !== (arm.agentName ?? null)) {
    reasons.push("arm identity differs from the frozen pilot treatment");
  }
  const paths = record.evidence ?? {};
  for (const name of [
    "eventsPath", "usagePath", "scenarioPath", "manifestPath", "commandPath"
  ]) {
    const path = paths[name];
    if (typeof path !== "string" || path.length === 0) {
      reasons.push(`${name} is missing`);
      continue;
    }
    if (!existsSync(path)) reasons.push(`${name} is missing`);
  }
  if (reasons.some((reason) => reason.endsWith(" is missing"))) return reasons;
  const eventsBytes = readFileSync(paths.eventsPath);
  const usageBytes = readFileSync(paths.usagePath);
  const scenarioBytes = readFileSync(paths.scenarioPath);
  const manifestBytes = readFileSync(paths.manifestPath);
  const commandBytes = readFileSync(paths.commandPath);
  if (sha256(eventsBytes) !== record.eventsSha256) reasons.push("events SHA-256 differs");
  if (sha256(usageBytes) !== record.usageSha256) reasons.push("usage SHA-256 differs");
  if (sha256(Buffer.concat([scenarioBytes, manifestBytes])) !== record.stagingSha256) {
    reasons.push("staging SHA-256 differs");
  }
  if (sha256(commandBytes) !== record.commandSha256) reasons.push("command SHA-256 differs");
  let events;
  let usageExport;
  let scenario;
  let manifest;
  let command;
  try {
    events = parseCopilotJsonl(eventsBytes);
    usageExport = JSON.parse(usageBytes);
    scenario = JSON.parse(scenarioBytes);
    manifest = JSON.parse(manifestBytes);
    command = JSON.parse(commandBytes);
  } catch (error) {
    reasons.push(`evidence parsing failed: ${error.message}`);
    return reasons;
  }
  try {
    const result = resultEvent(events, record.sessionId);
    if (result.exitCode !== 0) reasons.push("terminal result exit code is nonzero");
  } catch (error) {
    reasons.push(error.message);
  }
  const usageRows = usageExport.rows ?? [];
  if (usageExport.source?.cliSessionId !== record.sessionId
    || usageRows.length === 0
    || usageRows.some((row) => row.session_id !== record.sessionId)) {
    reasons.push("usage evidence is missing or cross-session");
  }
  const kickoff = `${condition.kickoff}\n\n${PILOT_TASK}`;
  const candidateRoot = resolve(dirname(paths.scenarioPath), "..", "..", "..");
  const expectedMcpConfigPath = resolve(candidateRoot, ".benchmark-runtime", "mcp-config.json");
  const expectedTools = availableToolsForArm(arm);
  if (command.candidateRoot !== candidateRoot
    || command.mcpConfigPath !== expectedMcpConfigPath
    || JSON.stringify(command.availableTools) !== JSON.stringify(expectedTools)
    || !Array.isArray(command.disabledMcpServers)
    || command.disabledMcpServers.includes("semantic-corpus")) {
    reasons.push("command construction inputs differ from the frozen pilot surface");
  } else {
    const expectedArgs = buildCopilotArgs({
      prompt: kickoff,
      sessionId: record.sessionId,
      model: arm.model,
      reasoningEffort: arm.reasoningEffort,
      topLevelAgent: arm.topLevelAgent,
      candidateRoot,
      mcpConfigPath: expectedMcpConfigPath,
      disabledMcpServers: command.disabledMcpServers,
      availableTools: expectedTools
    });
    if (JSON.stringify(command.args) !== JSON.stringify(expectedArgs)) {
      reasons.push("spawned CLI arguments differ from the frozen command builder");
    }
  }
  const taskBytes = Buffer.from(PILOT_TASK, "utf8");
  const delegatedAudit = arm.delegated
    ? auditDelegatedEventSequence({
        events,
        usageRows,
        expectedKickoff: kickoff,
        expectedTaskBytes: taskBytes,
        expectedParentModel: arm.model,
        expectedWorkerModel: arm.workerModel,
        expectedAgent: arm.agentName
      })
    : { reasons: auditInline(events, usageRows, kickoff, arm), workerCallId: null };
  reasons.push(...delegatedAudit.reasons);
  reasons.push(...auditMcp(events, {
    delegated: arm.delegated,
    workerCallId: delegatedAudit.workerCallId,
    scenario,
    manifest
  }));
  const terminal = terminalReturn(events, arm.delegated);
  if (terminal !== EXPECTED_TERMINAL || record.terminalReturn !== terminal) {
    reasons.push("terminal return differs from pilot contract or summary");
  }
  if (JSON.stringify(record.usage)
    !== JSON.stringify(usageSummary(usageRows, delegatedAudit.workerCallId))) {
    reasons.push("usage summary differs from raw usage evidence");
  }
  return reasons;
}

export function validateLivePreflight(value) {
  const errors = validateJsonSchema(value, schema, { schemaDir: schemaRoot });
  const reasons = errors.map((error) => `${error.path} ${error.message}`);
  const expectedArms = [1, 2, 3, 4, 5];
  const expectedTools = [
    "list_contract_files",
    "read_contract_file",
    "write_scenario_input",
    "write_scenario_manifest"
  ];
  if (JSON.stringify(value?.expectedTools) !== JSON.stringify(expectedTools)) {
    reasons.push("live preflight tools must exactly match the four semantic-corpus tools");
  }
  if (JSON.stringify(value?.builderBindings) !== JSON.stringify(currentLiveBuilderBindings())) {
    reasons.push("live preflight builder bindings differ from the measured execution paths");
  }
  if (JSON.stringify(value?.arms?.map((arm) => arm.armId)) !== JSON.stringify(expectedArms)) {
    reasons.push("live preflight arms must be ordered 1 through 5");
  }
  if (value?.arms?.some((arm) =>
    arm.pilotId !== `P4-SMOKE-${value.pilotSeries}-A${arm.armId}`)) {
    reasons.push("live preflight pilot IDs must bind the declared pilot series and arm");
  }
  if (value?.arms?.some((arm) => arm.status !== "pass" || arm.reasons.length > 0
    || arm.mcpHandshake !== "pass")) {
    reasons.push("every AI arm must pass live preflight");
  }
  for (const arm of value?.arms ?? []) {
    const evidenceReasons = verifyArmEvidence(arm, value.pilotSeries);
    if (evidenceReasons.length > 0) {
      reasons.push(`arm ${arm.armId} raw evidence failed: ${evidenceReasons.join("; ")}`);
    }
  }
  return reasons;
}
