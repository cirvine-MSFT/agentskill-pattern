#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import {
  kickoffBytesForArm,
  kickoffSha256ForArm,
  sharedTaskSha256
} from "./execution-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const evidenceSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-evidence.schema.json"), "utf8"));
const usageSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-usage-export.schema.json"), "utf8"));
const manifestSchema = JSON.parse(readFileSync(resolve(schemaRoot, "run-manifest.schema.json"), "utf8"));
const attemptSchema = JSON.parse(readFileSync(resolve(schemaRoot, "run-attempt.schema.json"), "utf8"));
const retrySchema = JSON.parse(readFileSync(resolve(schemaRoot, "retry.schema.json"), "utf8"));
const sessionCreationSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "session-creation.schema.json"), "utf8")
);
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const candidateManifest = JSON.parse(
  readFileSync(resolve(root, "design", "candidate-manifest.json"), "utf8")
);
const repositoryRoot = resolve(root, "..", "..");
const MCP_TOOLS = new Set(contract.commonContract.toolSurface);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(candidateRoot, args) {
  const result = spawnSync("git", args, {
    cwd: candidateRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Candidate git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function committedSourceBytes(sourcePath) {
  const repositoryPath = relative(repositoryRoot, resolve(root, sourcePath))
    .replaceAll("\\", "/");
  const result = spawnSync("git", ["show", `HEAD:${repositoryPath}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Cannot read committed treatment source ${repositoryPath}: ${result.stderr}`);
  }
  return result.stdout;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function parseJsonLines(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Local events line ${index + 1} is invalid JSON`);
    }
  });
}

function available(status, ...reasons) {
  return { status, reasons: reasons.filter(Boolean) };
}

function roleForUsage(row) {
  return row.agent_id === null ? "parent" : "worker";
}

function safeSum(rows, field) {
  if (rows.some((row) => !Number.isSafeInteger(row[field]) || row[field] < 0)) return null;
  const total = rows.reduce((sum, row) => sum + row[field], 0);
  return Number.isSafeInteger(total) ? total : null;
}

function usageFor(rows, required) {
  if (rows.length === 0 && !required) {
    return {
      available: true,
      aiCredits: 0,
      premiumRequests: null,
      nanoAiu: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cachedTokens: 0,
      modelTokens: 0,
      completionCount: 0
    };
  }
  const fields = {
    nanoAiu: safeSum(rows, "total_nano_aiu"),
    inputTokens: safeSum(rows, "input_tokens"),
    outputTokens: safeSum(rows, "output_tokens"),
    cacheReadTokens: safeSum(rows, "cache_read_tokens"),
    cacheWriteTokens: safeSum(rows, "cache_write_tokens")
  };
  const availableFields = Object.values(fields).every((value) => value !== null);
  return {
    available: rows.length > 0 && availableFields,
    aiCredits: fields.nanoAiu === null ? null : fields.nanoAiu / 1e9,
    premiumRequests: null,
    ...fields,
    cachedTokens: fields.cacheReadTokens === null || fields.cacheWriteTokens === null
      ? null
      : fields.cacheReadTokens + fields.cacheWriteTokens,
    modelTokens: fields.inputTokens === null || fields.outputTokens === null
      ? null
      : fields.inputTokens + fields.outputTokens,
    completionCount: rows.length
  };
}

function totalUsage(parent, worker) {
  const fields = [
    "nanoAiu", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "cachedTokens", "modelTokens"
  ];
  const result = {};
  for (const field of fields) {
    result[field] = parent[field] === null || worker[field] === null
      ? null
      : parent[field] + worker[field];
  }
  return {
    available: parent.available && worker.available,
    aiCredits: result.nanoAiu === null ? null : result.nanoAiu / 1e9,
    premiumRequests: null,
    ...result,
    completionCount: parent.completionCount + worker.completionCount
  };
}

function eventRole(event) {
  return event.agentId || event.data?.parentToolCallId ? "worker" : "parent";
}

function contractToolName(event) {
  const server = event.data?.mcpServerName;
  const tool = event.data?.mcpToolName;
  return typeof server === "string" && typeof tool === "string"
    ? `${server}/${tool}`
    : event.data?.toolName;
}

function timing(events, parentRows, workerRows, delegated) {
  const starts = events.filter((event) =>
    event.type === "assistant.turn_start" && !event.agentId);
  const ends = events.filter((event) =>
    event.type === "assistant.turn_end" && !event.agentId);
  const startedAt = starts[0]?.timestamp ?? null;
  const endedAt = ends.at(-1)?.timestamp ?? null;
  const wall = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;
  const parentActiveMs = safeSum(parentRows, "duration_ms");
  const workerActiveMs = safeSum(workerRows, "duration_ms");
  const delegatedStarts = events.filter((event) => event.type === "subagent.started");
  const delegatedEnds = events.filter((event) => event.type === "subagent.completed");
  const wait = delegated && delegatedStarts.length === 1 && delegatedEnds.length === 1
    ? Date.parse(delegatedEnds[0].timestamp) - Date.parse(delegatedStarts[0].timestamp)
    : Number.NaN;
  return {
    startedAt,
    endedAt,
    wallMs: Number.isSafeInteger(wall) && wall >= 0 ? wall : null,
    parentActiveMs,
    workerActiveMs,
    parentWaitMs: Number.isSafeInteger(wait) && wait >= 0 ? wait : null
  };
}

export function collectLocalEvidence({
  eventsBytes,
  eventsPath,
  usageBytes,
  usagePath,
  sessionCreationBytes,
  sessionCreationPath,
  candidateBoundaryBytes,
  candidateBoundaryPath,
  candidateRoot,
  runManifest,
  runManifestBytes,
  runManifestPath,
  runAttempt,
  runAttemptBytes,
  runAttemptPath,
  retryRecord = null,
  retryBytes = null,
  retryPath = null
}) {
  const usageExport = JSON.parse(usageBytes);
  const sessionCreation = JSON.parse(sessionCreationBytes);
  const usageErrors = validateJsonSchema(usageExport, usageSchema, { schemaDir: schemaRoot });
  if (usageErrors.length > 0) {
    throw new Error(`Usage export is invalid: ${usageErrors[0].path} ${usageErrors[0].message}`);
  }
  const sessionCreationErrors = validateJsonSchema(
    sessionCreation,
    sessionCreationSchema,
    { schemaDir: schemaRoot }
  );
  if (sessionCreationErrors.length > 0) {
    throw new Error(`Session creation capture is invalid: ${sessionCreationErrors[0].path} ${sessionCreationErrors[0].message}`);
  }
  const manifestErrors = validateJsonSchema(runManifest, manifestSchema, { schemaDir: schemaRoot });
  if (manifestErrors.length > 0) {
    throw new Error(`Run manifest is invalid: ${manifestErrors[0].path} ${manifestErrors[0].message}`);
  }
  const attemptErrors = validateJsonSchema(runAttempt, attemptSchema, { schemaDir: schemaRoot });
  if (attemptErrors.length > 0) {
    throw new Error(`Run attempt is invalid: ${attemptErrors[0].path} ${attemptErrors[0].message}`);
  }
  if (runManifest.armId === 0) throw new Error("Local AI evidence collector does not accept arm 0");

  const arm = contract.arms.find((item) => item.id === runManifest.armId);
  if (!arm) throw new Error(`Unknown arm ${runManifest.armId}`);
  const planned = schedule.runs.find((item) => item.runId === runManifest.runId);
  if (!planned
    || planned.blockId !== runManifest.blockId
    || planned.armId !== runManifest.armId
    || planned.seed !== runManifest.seed
    || planned.order !== runManifest.scheduleOrder) {
    throw new Error("Run manifest differs from the frozen schedule");
  }
  const boundary = JSON.parse(candidateBoundaryBytes);
  if (boundary.formatVersion !== 2
    || boundary.protocolId !== contract.protocolId
    || !Array.isArray(boundary.files)
    || boundary.files.length === 0) {
    throw new Error("Candidate boundary is not the frozen v2 materialization format");
  }
  const expectedCandidateFiles = candidateManifest.files.map((entry) => ({
    path: entry.destination.replaceAll("\\", "/"),
    sha256: sha256(committedSourceBytes(entry.source))
  })).sort((left, right) => left.path.localeCompare(right.path));
  const observedCandidateFiles = [...boundary.files]
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(observedCandidateFiles) !== JSON.stringify(expectedCandidateFiles)) {
    throw new Error("Candidate boundary differs from the exact candidate manifest file tree");
  }
  const liveCandidateRoot = resolve(candidateRoot);
  const liveBoundaryBytes = readFileSync(resolve(liveCandidateRoot, ".benchmark-boundary.json"));
  if (!liveBoundaryBytes.equals(candidateBoundaryBytes)) {
    throw new Error("Candidate boundary bytes differ from the executed checkout");
  }
  const status = git(liveCandidateRoot, ["status", "--porcelain=v1"]);
  if (status !== "") throw new Error("Candidate worktree is not clean at evidence collection");
  const head = git(liveCandidateRoot, ["rev-parse", "HEAD"]).trim();
  if (head !== runManifest.terminalCommit) {
    throw new Error("Executed candidate HEAD differs from the terminal commit");
  }
  const expectedTreePaths = [
    ...expectedCandidateFiles.map((file) => file.path),
    ".benchmark-boundary.json"
  ].sort();
  const observedTreePaths = git(liveCandidateRoot, ["ls-tree", "-r", "--name-only", "HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  if (JSON.stringify(observedTreePaths) !== JSON.stringify(expectedTreePaths)) {
    throw new Error("Candidate commit tree contains missing or extra treatment files");
  }
  for (const file of expectedCandidateFiles) {
    if (sha256(readFileSync(resolve(liveCandidateRoot, file.path))) !== file.sha256) {
      throw new Error(`Candidate checkout file differs from frozen treatment: ${file.path}`);
    }
  }
  if (sha256(candidateBoundaryBytes) !== runManifest.candidateSnapshotSha256) {
    throw new Error("Candidate boundary SHA-256 differs from the run manifest");
  }
  if (basename(candidateBoundaryPath) !== basename(runManifest.candidateBoundaryPath)) {
    throw new Error("Candidate boundary path differs from the run manifest");
  }
  if (runAttempt.runId !== runManifest.runId
    || runAttempt.attemptNumber !== runManifest.attemptNumber
    || runAttempt.appProjectSessionId !== runManifest.appProjectSessionId
    || runAttempt.cliSessionId !== runManifest.cliSessionId
    || runAttempt.requestedParentModel !== arm.model
    || runAttempt.requestedWorkerModel !== (arm.workerModel ?? null)) {
    throw new Error("Run attempt treatment/session identity differs from the manifest and arm contract");
  }
  const taskFile = boundary.files.find((file) => file.path === contract.commonContract.taskArtifact);
  if (!taskFile
    || taskFile.sha256 !== sharedTaskSha256()
    || runAttempt.treatment.blockId !== runManifest.blockId
    || runAttempt.treatment.armId !== runManifest.armId
    || runAttempt.treatment.seed !== runManifest.seed
    || runAttempt.treatment.terminalCommit !== runManifest.terminalCommit
    || runAttempt.treatment.candidateSnapshotSha256 !== runManifest.candidateSnapshotSha256
    || runAttempt.treatment.sharedTaskSha256 !== taskFile.sha256
    || runAttempt.treatment.kickoffSha256 !== kickoffSha256ForArm(runManifest.armId)
    || runAttempt.treatment.wallLimitMs !== contract.commonContract.wallClockMinutes * 60_000
    || runAttempt.treatment.toolCallLimit !== contract.commonContract.maximumToolCalls
    || runAttempt.treatment.modelTokenLimit !== contract.commonContract.maximumTotalModelTokens) {
    throw new Error("Run attempt treatment differs from the frozen schedule, candidate, task, or budgets");
  }
  if (runManifest.attempts.length !== runManifest.attemptNumber
    || basename(runManifest.attempts.at(-1)) !== basename(runAttemptPath)) {
    throw new Error("Run manifest attempt chain does not end at the collected attempt");
  }
  if (runManifest.attemptNumber === 1
    && (runManifest.retries.length !== 0 || retryRecord !== null)) {
    throw new Error("First attempt cannot contain a retry record");
  }
  if (runManifest.attemptNumber === 2) {
    if (runManifest.retries.length !== 1 || !retryRecord || !retryBytes || !retryPath) {
      throw new Error("Second attempt requires exactly one retry record");
    }
    const retryErrors = validateJsonSchema(retryRecord, retrySchema, { schemaDir: schemaRoot });
    if (retryErrors.length > 0) {
      throw new Error(`Retry record is invalid: ${retryErrors[0].path} ${retryErrors[0].message}`);
    }
    if (basename(runManifest.retries[0]) !== basename(retryPath)
      || retryRecord.runId !== runManifest.runId
      || retryRecord.toAttemptId !== runAttempt.attemptId
      || retryRecord.reason !== "observed-model-mismatch"
      || retryRecord.outcomesOpened !== false
      || retryRecord.sameTreatment !== true) {
      throw new Error("Retry record does not authorize this exact second attempt");
    }
  }
  const events = parseJsonLines(eventsBytes);
  const starts = events.filter((event) => event.type === "session.start");
  const cliSessionId = runManifest.cliSessionId;
  const sessionReasons = [];
  if (starts.length !== 1) sessionReasons.push(`expected one session.start event; found ${starts.length}`);
  const capturedKickoffBytes = Buffer.from(sessionCreation.request.kickoff.prompt, "utf8");
  if (sessionCreation.response.project_session_id !== runManifest.appProjectSessionId
    || sessionCreation.response.project_id !== sessionCreation.request.project_id
    || sessionCreation.response.execution_location !== contract.commonContract.executionLocation
    || sessionCreation.response.kickoff_mode !== contract.commonContract.kickoffMode
    || sessionCreation.response.kickoff_model !== arm.model
    || sessionCreation.request.execution_location !== contract.commonContract.executionLocation
    || sessionCreation.request.kickoff.mode !== contract.commonContract.kickoffMode
    || sessionCreation.request.kickoff.model !== arm.model
    || sessionCreation.request.kickoff.agent !== null
    || sessionCreation.request.candidate_commit !== runManifest.terminalCommit
    || sha256(capturedKickoffBytes) !== runAttempt.treatment.kickoffSha256
    || !capturedKickoffBytes.equals(kickoffBytesForArm(runManifest.armId))) {
    sessionReasons.push("captured atomic create_session request/response differs from the frozen attempt");
  }
  if (starts[0]?.data?.sessionId !== cliSessionId) sessionReasons.push("session.start CLI session ID differs from the run manifest");
  if (starts[0]?.data?.context?.headCommit !== runManifest.terminalCommit) {
    sessionReasons.push("session.start head commit differs from the terminal candidate commit");
  }
  if (usageExport.source.cliSessionId !== cliSessionId) sessionReasons.push("usage export CLI session ID differs from the run manifest");
  if (usageExport.rows.some((row) => row.session_id !== cliSessionId)) {
    sessionReasons.push("usage export includes another CLI session");
  }
  const topLevelTurnStarts = events.filter((event) =>
    event.type === "assistant.turn_start" && !event.agentId);
  const topLevelTurnEnds = events.filter((event) =>
    event.type === "assistant.turn_end" && !event.agentId);
  const topLevelUserMessages = events.filter((event) =>
    event.type === "user.message" && !event.agentId);
  if (topLevelTurnStarts.length !== 1 || topLevelTurnEnds.length !== 1) {
    sessionReasons.push("attempt must contain exactly one top-level assistant kickoff turn");
  }
  if (topLevelUserMessages.length > 1) {
    sessionReasons.push("attempt contains follow-up user steering after atomic kickoff");
  }
  if (topLevelUserMessages.length === 1
    && topLevelUserMessages[0]?.data?.content !== sessionCreation.request.kickoff.prompt) {
    sessionReasons.push("captured user kickoff differs from the atomic create_session prompt");
  }

  const parentRows = usageExport.rows.filter((row) => roleForUsage(row) === "parent");
  const workerRows = usageExport.rows.filter((row) => roleForUsage(row) === "worker");
  const requested = {
    parent: [arm.model],
    worker: arm.delegated ? [arm.workerModel] : []
  };
  const observed = {
    parent: [...new Set(parentRows.map((row) => row.model))].sort(),
    worker: [...new Set(workerRows.map((row) => row.model))].sort()
  };
  const modelReasons = [];
  for (const role of ["parent", "worker"]) {
    const expected = requested[role];
    const actual = observed[role];
    if (expected.length === 0 && actual.length > 0) {
      modelReasons.push(`${role} usage exists for an inline arm`);
    } else if (expected.length > 0 && actual.length === 0) {
      modelReasons.push(`${role} model is unavailable from local usage`);
    } else if (expected.length > 0 && (actual.length !== 1 || actual[0] !== expected[0])) {
      modelReasons.push(`${role} model mismatch: expected ${expected[0]}, observed ${actual.join(",")}`);
    }
  }

  const toolStarts = events.filter((event) => event.type === "tool.execution_start");
  const toolCompletes = events.filter((event) => event.type === "tool.execution_complete");
  const toolStartsById = new Map(toolStarts.map((event) => [event.data?.toolCallId, event]));
  const semanticCalls = toolStarts.filter((event) => MCP_TOOLS.has(contractToolName(event)));
  const callCounts = new Map();
  for (const event of toolStarts) {
    const key = `${eventRole(event)}\0${contractToolName(event)}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
  }
  const calls = [...callCounts].map(([key, count]) => {
    const [role, name] = key.split("\0");
    return { role, name, count };
  }).sort((left, right) => `${left.role}/${left.name}`.localeCompare(`${right.role}/${right.name}`));
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const skillInvocations = events.filter((event) => event.type === "skill.invoked");
  const skillCalls = toolStarts.filter((event) => event.data?.toolName === "skill");
  const taskCalls = toolStarts.filter((event) => event.data?.toolName === "task");
  const expectedAgent = arm.agentName ?? contract.delegationContract.agentName;
  const mechanismReasons = [];
  if (arm.delegated) {
    if (subagentStarts.length !== 1 || subagentCompletes.length !== 1) {
      mechanismReasons.push("delegated arm lacks one complete local subagent lifecycle");
    }
    if (subagentStarts[0]?.data?.agentName !== expectedAgent) {
      mechanismReasons.push(`delegated agent differs from ${expectedAgent}`);
    }
    if (subagentCompletes[0]?.data?.agentName !== expectedAgent) {
      mechanismReasons.push(`delegation completion agent differs from ${expectedAgent}`);
    }
    if (semanticCalls.some((event) => eventRole(event) !== "worker")) {
      mechanismReasons.push("delegated parent called semantic-corpus MCP tools");
    }
    if (taskCalls.length !== 1
      || taskCalls[0]?.data?.arguments?.agent_type !== expectedAgent) {
      mechanismReasons.push(`delegated arm requires one exact ${expectedAgent} task invocation`);
    }
    const observedWorkerPrompt = taskCalls[0]?.data?.arguments?.prompt;
    if (typeof observedWorkerPrompt !== "string"
      || sha256(Buffer.from(observedWorkerPrompt, "utf8")) !== taskFile.sha256) {
      mechanismReasons.push("delegated task prompt differs from the byte-exact shared task");
    }
    if ([2, 4].includes(runManifest.armId)) {
      if (skillCalls.length !== 1
        || skillCalls[0]?.data?.arguments?.skill !== "semantic-test-corpus"
        || skillInvocations.length !== 1
        || skillInvocations[0]?.data?.name !== "semantic-test-corpus") {
        mechanismReasons.push("inherited delegated arm requires one semantic-test-corpus Skill invocation");
      }
    } else if (skillCalls.length > 0 || skillInvocations.length > 0) {
      mechanismReasons.push("arm 5 must invoke the fixed specialist directly without the core Skill");
    }
  } else {
    if (subagentStarts.length > 0 || subagentCompletes.length > 0) {
      mechanismReasons.push("inline arm emitted a subagent lifecycle");
    }
    if (semanticCalls.some((event) => eventRole(event) !== "parent")) {
      mechanismReasons.push("inline MCP call is not parent-attributed");
    }
    if (skillCalls.length > 0 || skillInvocations.length > 0 || taskCalls.length > 0) {
      mechanismReasons.push("inline arm invoked a Skill or delegated task");
    }
  }
  if (semanticCalls.length === 0) mechanismReasons.push("no semantic-corpus MCP calls were observed");
  for (const event of toolStarts) {
    const role = eventRole(event);
    const name = contractToolName(event);
    const semanticAllowed = MCP_TOOLS.has(name)
      && role === (arm.delegated ? "worker" : "parent");
    const parentDelegationAllowed = role === "parent"
      && arm.delegated
      && (runManifest.armId === 5
        ? name === "task"
        : ["skill", "task"].includes(name));
    if (!semanticAllowed && !parentDelegationAllowed) {
      mechanismReasons.push(`${role} used prohibited tool ${name ?? "<missing>"}`);
    }
  }

  const parentUsage = usageFor(parentRows, true);
  const workerUsage = usageFor(workerRows, arm.delegated);
  const measuredTiming = timing(events, parentRows, workerRows, arm.delegated);
  const resultBytes = toolCompletes.reduce((sum, event) =>
    sum + Buffer.byteLength(JSON.stringify(event.data?.result ?? null), "utf8"), 0);
  const toolErrors = toolCompletes
    .filter((event) => event.data?.success === false)
    .map((event) => {
      const start = toolStartsById.get(event.data?.toolCallId);
      const name = start ? contractToolName(start) : event.data?.toolName;
      if (!start || !MCP_TOOLS.has(name)) return null;
      const error = event.data?.result?.error ?? event.data?.error ?? {};
      const message = error.message
        ?? event.data?.result?.content
        ?? JSON.stringify(event.data?.result ?? "Local tool execution failed");
      return {
        callId: event.data.toolCallId,
        toolName: name,
        argumentsSha256: sha256(Buffer.from(canonicalJson(start.data?.arguments ?? {}), "utf8")),
        ...(typeof start.data?.arguments?.scenarioId === "string"
          ? { scenarioId: start.data.arguments.scenarioId }
          : {}),
        code: String(error.code ?? "LOCAL_TOOL_ERROR"),
        message: String(message)
      };
    })
    .filter(Boolean);
  const successfulWrites = toolCompletes
    .filter((event) => event.data?.success === true)
    .map((event) => {
      const start = toolStartsById.get(event.data?.toolCallId);
      const name = start ? contractToolName(start) : null;
      if (!start || ![
        "semantic-corpus/write_scenario_input",
        "semantic-corpus/write_scenario_manifest"
      ].includes(name)) return null;
      return {
        callId: event.data.toolCallId,
        toolName: name,
        argumentsSha256: sha256(Buffer.from(canonicalJson(start.data?.arguments ?? {}), "utf8")),
        ...(typeof start.data?.arguments?.scenarioId === "string"
          ? { scenarioId: start.data.arguments.scenarioId }
          : {})
      };
    })
    .filter(Boolean);
  const compact = subagentCompletes[0]?.data?.result
    ?? subagentCompletes[0]?.data?.response
    ?? null;
  const compactReturn = typeof compact === "string" ? compact : compact === null ? null : JSON.stringify(compact);
  const inlineTerminal = events.filter((event) => event.type === "assistant.message")
    .map((event) => event.data?.content)
    .filter((content) => typeof content === "string")
    .at(-1) ?? null;
  const observedTerminal = arm.delegated ? compactReturn : inlineTerminal;
  if (runAttempt.terminalReturn !== observedTerminal) {
    mechanismReasons.push("attempt terminal return differs from the observed compact delegation return");
  }
  const scenarioWriteStarts = semanticCalls.filter((event) =>
    contractToolName(event) === "semantic-corpus/write_scenario_input");
  const scenarioWriteIds = scenarioWriteStarts
    .map((event) => event.data?.arguments?.scenarioId)
    .filter((scenarioId) => typeof scenarioId === "string");
  if (new Set(scenarioWriteIds).size !== scenarioWriteIds.length) {
    mechanismReasons.push("scenario write was retried or duplicated");
  }
  const semanticErrors = toolCompletes.filter((event) => {
    const start = toolStartsById.get(event.data?.toolCallId);
    return event.data?.success === false && start && MCP_TOOLS.has(contractToolName(start));
  });
  const successfulScenarioWrites = successfulWrites.filter((write) =>
    write.toolName === "semantic-corpus/write_scenario_input");
  const successfulManifestWrites = successfulWrites.filter((write) =>
    write.toolName === "semantic-corpus/write_scenario_manifest");
  const successTerminal = /^corpus-staging\/manifest\.json - (\d+) scenarios - SUCCESS$/u
    .exec(observedTerminal ?? "");
  const failureTerminal = /^corpus-staging - (\d+) scenarios - FAILURE: (.+)$/u
    .exec(observedTerminal ?? "");
  if (!successTerminal && !failureTerminal) {
    mechanismReasons.push("terminal return does not match the exact success/failure contract");
  } else if (successTerminal) {
    if (Number(successTerminal[1]) !== 60
      || successfulScenarioWrites.length !== 60
      || successfulManifestWrites.length !== 1
      || semanticErrors.length !== 0) {
      mechanismReasons.push("successful terminal return differs from observed write calls");
    }
  } else {
    const failureAt = semanticErrors.length === 1
      ? Date.parse(semanticErrors[0].timestamp)
      : Number.NaN;
    if (Number(failureTerminal[1]) !== successfulScenarioWrites.length
      || successfulManifestWrites.length !== 0
      || semanticErrors.length !== 1
      || semanticCalls.some((event) => Date.parse(event.timestamp) > failureAt)) {
      mechanismReasons.push("failure terminal return does not represent one final failed MCP call");
    }
  }
  const total = totalUsage(parentUsage, workerUsage);
  const budgetReasons = [];
  if (measuredTiming.wallMs === null || total.modelTokens === null) {
    budgetReasons.push("wall or model-token budget evidence is unavailable");
  }
  if (measuredTiming.wallMs !== null
    && measuredTiming.wallMs > contract.commonContract.wallClockMinutes * 60_000) {
    budgetReasons.push("wall-clock limit exceeded");
  }
  if (toolStarts.length > contract.commonContract.maximumToolCalls) {
    budgetReasons.push("tool-call limit exceeded");
  }
  if (total.modelTokens !== null
    && total.modelTokens > contract.commonContract.maximumTotalModelTokens) {
    budgetReasons.push("model-token limit exceeded");
  }
  const budgetStatus = budgetReasons.some((reason) => reason.includes("exceeded"))
    ? "exceeded"
    : budgetReasons.length > 0 ? "unavailable" : "within-budget";
  const output = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    evidenceTier: "descriptive-local-v1",
    runId: runManifest.runId,
    blockId: runManifest.blockId,
    armId: runManifest.armId,
    identity: {
      appProjectSessionId: runManifest.appProjectSessionId,
      cliSessionId,
      terminalCommit: runManifest.terminalCommit,
      candidateSnapshotSha256: runManifest.candidateSnapshotSha256
    },
    source: {
      events: {
        path: basename(eventsPath),
        sha256: sha256(eventsBytes),
        bytes: eventsBytes.length
      },
      usage: {
        path: basename(usagePath),
        sha256: sha256(usageBytes),
        bytes: usageBytes.length
      },
      sessionCreation: {
        path: basename(sessionCreationPath),
        sha256: sha256(sessionCreationBytes),
        bytes: sessionCreationBytes.length
      },
      candidateBoundary: {
        path: basename(candidateBoundaryPath),
        sha256: sha256(candidateBoundaryBytes),
        bytes: candidateBoundaryBytes.length
      },
      runManifest: {
        path: basename(runManifestPath),
        sha256: sha256(runManifestBytes),
        bytes: runManifestBytes.length
      },
      runAttempt: {
        path: basename(runAttemptPath),
        sha256: sha256(runAttemptBytes),
        bytes: runAttemptBytes.length
      },
      retry: retryBytes ? {
        path: basename(retryPath),
        sha256: sha256(retryBytes),
        bytes: retryBytes.length
      } : null
    },
    trust: {
      status: "local-hash-bound",
      signed: false,
      complianceProof: false,
      limitations: [
        "No detached platform signature or external trust anchor",
        "No signed sandbox, filesystem, network, run, adapter, or metrics envelope",
        "Local hashes establish byte identity only"
      ]
    },
    availability: {
      session: available(sessionReasons.length === 0 ? "available" : "unavailable", ...sessionReasons),
      model: available(modelReasons.length === 0 ? "available" : "unavailable", ...modelReasons),
      mechanism: available(mechanismReasons.length === 0 ? "available" : "unavailable", ...mechanismReasons),
      fields: {
        premiumRequests: available("unavailable", "assistant_usage_events has no premium-request field"),
        toolSchemas: available("unavailable", "local events do not expose the complete tool schema payload"),
        parentWait: available(measuredTiming.parentWaitMs === null ? "unavailable" : "available",
          measuredTiming.parentWaitMs === null ? "one complete delegated lifecycle is required" : null),
        sourceReadOnly: available("unavailable", "portable read-only state is not represented in the source formats")
      }
    },
    models: { requested, observed },
    attempt: {
      attemptId: runAttempt.attemptId,
      number: runAttempt.attemptNumber,
      retryCount: runManifest.retries.length,
      outcomesOpened: runManifest.outcomesOpenedAt !== null || runAttempt.outcomesOpenedAt !== null
    },
    usage: {
      parent: parentUsage,
      worker: workerUsage,
      total
    },
    parentContext: {
      cumulativeInputTokens: parentUsage.inputTokens,
      peakInputTokens: parentRows.length > 0 && parentRows.every((row) => Number.isSafeInteger(row.input_tokens))
        ? Math.max(...parentRows.map((row) => row.input_tokens))
        : null
    },
    tools: {
      schemas: { available: false, count: null, names: null },
      calls,
      callCount: toolStarts.length,
      resultCount: toolCompletes.length,
      resultBytes
    },
    successfulWrites,
    toolErrors,
    delegation: {
      invoked: subagentStarts.length > 0,
      completed: subagentCompletes.length > 0,
      agentName: subagentStarts[0]?.data?.agentName ?? null,
      compactReturn
    },
    timing: measuredTiming,
    budgets: {
      limits: {
        wallMs: contract.commonContract.wallClockMinutes * 60_000,
        toolCalls: contract.commonContract.maximumToolCalls,
        modelTokens: contract.commonContract.maximumTotalModelTokens
      },
      observed: {
        wallMs: measuredTiming.wallMs,
        toolCalls: toolStarts.length,
        modelTokens: total.modelTokens
      },
      status: budgetStatus,
      reasons: budgetReasons
    },
    events: {
      count: events.length,
      completionCount: usageExport.rows.length
    },
    deviations: [
      ...(runManifest.armId === 5 ? ["arm-5-named-fixed-specialist"] : []),
      ...sessionReasons,
      ...modelReasons,
      ...mechanismReasons,
      ...budgetReasons
    ]
  };
  const errors = validateJsonSchema(output, evidenceSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Collected local evidence is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const eventsPath = argument(args, "--events");
  const usagePath = argument(args, "--usage");
  const sessionCreationPath = argument(args, "--session-creation");
  const manifestPath = argument(args, "--run-manifest");
  const attemptPath = argument(args, "--run-attempt");
  const candidateBoundaryPath = argument(args, "--candidate-boundary");
  const candidateRoot = argument(args, "--candidate-root");
  const retryPath = argument(args, "--retry");
  const outputPath = argument(args, "--out");
  if (!eventsPath || !usagePath || !sessionCreationPath || !manifestPath || !attemptPath || !candidateBoundaryPath || !candidateRoot || !outputPath) {
    throw new Error("Usage: node scripts/collect-local-evidence.mjs --events <events.jsonl> --usage <usage.json> --session-creation <create-session.json> --candidate-boundary <boundary.json> --candidate-root <clean-candidate-repository> --run-manifest <manifest.json> --run-attempt <attempt.json> [--retry <retry.json>] --out <local-evidence.json>");
  }
  const runManifestBytes = readFileSync(resolve(manifestPath));
  const runAttemptBytes = readFileSync(resolve(attemptPath));
  const retryBytes = retryPath ? readFileSync(resolve(retryPath)) : null;
  const output = collectLocalEvidence({
    eventsBytes: readFileSync(resolve(eventsPath)),
    eventsPath,
    usageBytes: readFileSync(resolve(usagePath)),
    usagePath,
    sessionCreationBytes: readFileSync(resolve(sessionCreationPath)),
    sessionCreationPath,
    candidateBoundaryBytes: readFileSync(resolve(candidateBoundaryPath)),
    candidateBoundaryPath,
    candidateRoot,
    runManifest: JSON.parse(runManifestBytes),
    runManifestBytes,
    runManifestPath: manifestPath,
    runAttempt: JSON.parse(runAttemptBytes),
    runAttemptBytes,
    runAttemptPath: attemptPath,
    ...(retryBytes ? {
      retryRecord: JSON.parse(retryBytes),
      retryBytes,
      retryPath
    } : {})
  });
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.runId}: local evidence collected; signed=false complianceProof=false\n`);
}
