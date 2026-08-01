import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const protocolId = "release-note-synthesis-v2-repair";
export const v2Root = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const experimentRoot = resolve(v2Root, "..");
export const repositoryRoot = resolve(experimentRoot, "..", "..");
export const evidenceRoot = resolve(experimentRoot, "results", "v2-repair");
export const canonicalTools = [
  "release-notes/read_release_dossier",
  "release-notes/write_release_note_draft",
];
export const availableTools = ["skill", "task", ...canonicalTools];
export const tokenLimit = 20_000;
export const wallTimeLimitMs = 300_000;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function filesUnder(directory, excluded = new Set()) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = resolve(directory, entry.name);
      if (excluded.has(target)) return [];
      return entry.isDirectory() ? filesUnder(target, excluded) : [target];
    });
}

export function parseEvents(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line);
      assert(event && typeof event.type === "string", "event type is missing");
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

function toolName(event) {
  return event.data?.toolName ?? event.toolName ?? null;
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
    activeTimeMs: sum(rows, "duration_ms"),
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  };
}

function exactEnvelope(content) {
  if (typeof content !== "string" || content.trim() === "") return null;
  try {
    const value = JSON.parse(content);
    const top = Object.keys(value ?? {}).sort();
    const integrity = Object.keys(value?.integrity ?? {}).sort();
    if (
      JSON.stringify(top) !== JSON.stringify(["integrity", "outputPath", "runId"])
      || JSON.stringify(integrity) !== JSON.stringify(["dossierSha256", "draftBytes", "draftSha256"])
    ) return null;
    return value;
  } catch {
    return null;
  }
}

export function deriveEvidence({
  run,
  events,
  rawBytes,
  usageRows,
  audit,
  attestation,
  draftBytes,
  processResult,
  startedAt,
  endedAt,
  expectedDossierSha256,
}) {
  const failures = [];
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completes = events.filter((event) => event.type === "tool.execution_complete");
  const skillStarts = starts.filter((event) =>
    toolName(event) === "skill" && event.data?.arguments?.skill === "release-note-synthesis");
  const taskStarts = starts.filter((event) => toolName(event) === "task");
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const workerCallId = subagentStarts[0]?.data?.toolCallId ?? subagentStarts[0]?.agentId ?? null;
  const mcpStarts = starts.filter((event) => canonicalTools.includes(toolName(event)));
  const mcpCompletes = mcpStarts.map((start) =>
    completes.find((event) => event.data?.toolCallId === start.data?.toolCallId));
  const unknownToolWarnings = events.filter((event) =>
    event.type === "session.info"
    && /unknown tool name in the tool allowlist/iu.test(event.data?.message ?? ""));

  if (skillStarts.length !== 1) failures.push("Skill start count is not exactly one");
  if (taskStarts.length !== 1) failures.push("delegation task start count is not exactly one");
  if (subagentStarts.length !== 1 || subagentCompletes.length !== 1) {
    failures.push("custom-agent lifecycle is not exactly one start and one complete");
  }
  if (subagentStarts[0]?.data?.agentName !== "release-note-haiku") failures.push("worker agent mismatch");
  if (subagentStarts[0]?.data?.model !== "claude-haiku-4.5") failures.push("worker model mismatch");
  if (unknownToolWarnings.length !== 0) failures.push("unknown-tool warnings were emitted");
  if (
    mcpStarts.length !== 2
    || JSON.stringify(mcpStarts.map(toolName)) !== JSON.stringify(canonicalTools)
    || mcpStarts.some((event) => event.agentId !== workerCallId)
    || mcpCompletes.some((event) => event?.data?.success !== true)
  ) {
    failures.push("canonical MCP tools lack exact worker-owned structured start/complete lifecycles");
  }
  const observedToolNames = [...new Set(starts.map(toolName).filter(Boolean))].sort();
  if (observedToolNames.some((name) => !availableTools.includes(name))) {
    failures.push("an unexpected general tool was invoked");
  }

  const agentEvents = events.filter((event) => event.type === "session.custom_agents_updated");
  const agentSurface = agentEvents.at(-1)?.data ?? {};
  if (
    agentSurface.errors?.length
    || agentSurface.warnings?.length
    || agentSurface.agents?.length !== 1
    || agentSurface.agents[0]?.name !== "release-note-haiku"
    || JSON.stringify(agentSurface.agents[0]?.tools) !== JSON.stringify(canonicalTools)
  ) failures.push("custom-agent schema did not resolve to the exact singleton canonical surface");

  const skillEvents = events.filter((event) => event.type === "session.skills_loaded");
  const loadedSkills = skillEvents.at(-1)?.data?.skills ?? [];
  if (
    loadedSkills.length !== 1
    || loadedSkills[0]?.name !== "release-note-synthesis"
    || loadedSkills[0]?.source !== "project"
  ) failures.push("Skill surface is not the exact singleton project Skill");

  const mcpServers = [...new Set(events
    .filter((event) => event.type === "session.mcp_server_status_changed")
    .map((event) => event.data?.serverName)
    .filter(Boolean))].sort();
  if (JSON.stringify(mcpServers) !== JSON.stringify(["release-notes"])) {
    failures.push("MCP surface contains an unexpected server");
  }

  const auditTypes = audit.map((event) => event.type);
  if (JSON.stringify(auditTypes) !== JSON.stringify([
    "service.started",
    "dossier.read",
    "draft.written",
    "run.completed",
  ])) failures.push("MCP audit sequence is not exact");
  if (!attestation?.forbiddenRootsInaccessible || !attestation?.secretEnvironmentAbsent) {
    failures.push("sandbox root or credential isolation attestation failed");
  }

  const writeStart = mcpStarts.find((event) => toolName(event) === canonicalTools[1]);
  const writeComplete = completes.find((event) =>
    event.data?.toolCallId === writeStart?.data?.toolCallId && event.data?.success === true);
  const expectedEnvelope = writeComplete?.data?.result?.structuredContent
    ?? writeComplete?.data?.result
    ?? null;
  const parentMessages = events.filter((event) =>
    event.type === "assistant.message" && !event.agentId && event.data?.content?.trim());
  const workerMessages = events.filter((event) =>
    event.type === "assistant.message"
    && event.agentId === workerCallId
    && event.data?.content?.trim());
  const parentEnvelope = exactEnvelope(parentMessages.at(-1)?.data?.content);
  const workerEnvelope = exactEnvelope(workerMessages.at(-1)?.data?.content);
  if (parentMessages.length !== 1 || workerMessages.length !== 1) {
    failures.push("parent or worker returned narration beyond one compact envelope");
  }
  if (
    !parentEnvelope
    || !workerEnvelope
    || JSON.stringify(parentEnvelope) !== JSON.stringify(expectedEnvelope)
    || JSON.stringify(workerEnvelope) !== JSON.stringify(expectedEnvelope)
  ) failures.push("compact status envelope differs from the MCP write result");
  if (
    expectedEnvelope?.runId !== run.runId
    || expectedEnvelope?.integrity?.dossierSha256 !== expectedDossierSha256
    || expectedEnvelope?.integrity?.draftSha256 !== (draftBytes ? sha256(draftBytes) : null)
    || expectedEnvelope?.integrity?.draftBytes !== draftBytes?.length
  ) failures.push("status envelope integrity does not bind the exact run output");

  const parentRows = usageRows.filter((row) => row.agent_id === null);
  const workerRows = usageRows.filter((row) => row.agent_id === workerCallId);
  const otherRows = usageRows.filter((row) => row.agent_id !== null && row.agent_id !== workerCallId);
  const parentUsage = usageFor(parentRows);
  const workerUsage = usageFor(workerRows);
  const totalUsage = usageFor(usageRows);
  if (JSON.stringify(parentUsage.models) !== JSON.stringify(["gpt-5.6-sol"])) {
    failures.push("parent usage model mismatch");
  }
  if (JSON.stringify(workerUsage.models) !== JSON.stringify(["claude-haiku-4.5"])) {
    failures.push("worker usage model mismatch");
  }
  if (otherRows.length !== 0) failures.push("unexpected usage actor observed");
  if (totalUsage.modelTokens === null || totalUsage.modelTokens > tokenLimit) {
    failures.push("total model-token ceiling failed");
  }

  const wallTimeMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(wallTimeMs) || wallTimeMs > wallTimeLimitMs) {
    failures.push("wall-time ceiling failed");
  }
  const results = events.filter((event) => event.type === "result");
  if (
    processResult.status !== 0
    || results.length !== 1
    || results[0]?.sessionId !== run.sessionId
    || results[0]?.exitCode !== 0
  ) failures.push("terminal process or session identity failed");

  return {
    formatVersion: 1,
    protocolId,
    phase: run.phase,
    permanentlyExcludedFromConfirmation: true,
    runId: run.runId,
    dossierId: run.dossierId,
    sessionId: run.sessionId,
    startedAt,
    endedAt,
    disposition: failures.length === 0 ? "success" : "measured-failure",
    operationalSuccess: failures.length === 0,
    treatmentAdherent: failures.length === 0,
    failureReasons: [...new Set(failures)],
    mechanism: {
      parentModel: "gpt-5.6-sol",
      workerModel: subagentStarts[0]?.data?.model ?? null,
      workerCallId,
      skillStarts: skillStarts.length,
      taskStarts: taskStarts.length,
      customAgentStarts: subagentStarts.length,
      customAgentCompletes: subagentCompletes.length,
      customAgentSchema: agentSurface,
    },
    surface: {
      skills: loadedSkills,
      mcpServers,
      observedToolNames,
      unknownToolWarnings: unknownToolWarnings.map((event) => event.data?.message),
      isolationAttestation: attestation,
    },
    boundary: {
      canonicalTools,
      mcpStarts: mcpStarts.length,
      mcpCompletes: mcpCompletes.filter((event) => event?.data?.success === true).length,
      workerOwnedMcpStarts: mcpStarts.filter((event) => event.agentId === workerCallId).length,
      auditSequence: auditTypes,
      draftBytes: draftBytes?.length ?? null,
      draftSha256: draftBytes ? sha256(draftBytes) : null,
      rawEventBytes: rawBytes.length,
    },
    returnBoundary: { parentEnvelope, workerEnvelope, expectedEnvelope },
    usage: {
      parent: parentUsage,
      worker: workerUsage,
      unexpectedActors: usageFor(otherRows),
      total: totalUsage,
    },
    timing: { wallTimeMs },
    terminal: {
      processStatus: processResult.status,
      processSignal: processResult.signal,
      resultEventCount: results.length,
      resultSessionId: results[0]?.sessionId ?? null,
      resultExitCode: results[0]?.exitCode ?? null,
    },
  };
}
