#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import {
  kickoffBytesForRun,
  legacyTaskBytesForSeed,
  legacyTaskSha256ForSeed,
  taskBytesForSeed,
  taskSha256ForSeed
} from "./execution-contract.mjs";
import {
  availableToolsForArm,
  buildCopilotArgs
} from "./copilot-cli-v5.mjs";
import { buildCopilotArgs as buildCopilotArgsV3 } from "./copilot-cli-v3.mjs";
import { protocolDesignForId } from "./protocol-design.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const evidenceSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-evidence.schema.json"), "utf8"));
const usageSchema = JSON.parse(readFileSync(resolve(schemaRoot, "local-usage-export.schema.json"), "utf8"));
const manifestSchema = JSON.parse(readFileSync(resolve(schemaRoot, "run-manifest.schema.json"), "utf8"));
const attemptSchema = JSON.parse(readFileSync(resolve(schemaRoot, "run-attempt.schema.json"), "utf8"));
const preSessionFailureSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "pre-session-failure.schema.json"), "utf8")
);
const sessionCreationSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "session-creation.schema.json"), "utf8")
);
const currentContract = protocolDesignForId("semantic-test-corpus-execution-v5").contract;
const repositoryRoot = resolve(root, "..", "..");
const MCP_TOOLS = new Set(currentContract.commonContract.toolSurface);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedKickoffBytes(armId, seed, protocolVersion, conditions) {
  if (protocolVersion === "v4" || protocolVersion === "v5") {
    return kickoffBytesForRun(armId, seed);
  }
  const condition = conditions.conditions.find((item) => item.armId === armId);
  if (!condition?.kickoff) throw new Error(`No ${protocolVersion} kickoff for arm ${armId}`);
  return Buffer.concat([
    Buffer.from(`${condition.kickoff}\n\n`, "utf8"),
    legacyTaskBytesForSeed(seed)
  ]);
}

function expectedKickoffSha256(armId, seed, protocolVersion, conditions) {
  return sha256(expectedKickoffBytes(armId, seed, protocolVersion, conditions));
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

function committedSource(sourcePath, sourcePin) {
  const repositoryPath = relative(repositoryRoot, resolve(root, sourcePath))
    .replaceAll("\\", "/");
  const blobId = sourcePin.sourceBlobs[repositoryPath];
  const observed = spawnSync("git", [
    "rev-parse", `${sourcePin.sourceCommit}:${repositoryPath}`
  ], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (observed.status !== 0 || observed.stdout.trim() !== blobId) {
    throw new Error(`Pinned treatment blob differs for ${repositoryPath}`);
  }
  const result = spawnSync("git", ["cat-file", "blob", blobId], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Cannot read committed treatment source ${repositoryPath}: ${result.stderr}`);
  }
  return { repositoryPath, blobId, bytes: result.stdout };
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

function safeSum(rows, field, { integer = true } = {}) {
  const valid = integer
    ? (value) => Number.isSafeInteger(value) && value >= 0
    : (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (rows.some((row) => !valid(row[field]))) return null;
  const total = rows.reduce((sum, row) => sum + row[field], 0);
  return valid(total) ? total : null;
}

function safeAverage(rows, field) {
  if (rows.length === 0) return 0;
  if (rows.some((row) => typeof row[field] !== "number"
    || !Number.isFinite(row[field])
    || row[field] < 0)) return null;
  return rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
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
      reasoningTokens: 0,
      modelTokens: 0,
      requestMultiplier: 0,
      durationMs: 0,
      meanTimeToFirstTokenMs: 0,
      meanInterTokenLatencyMs: 0,
      completionCount: 0
    };
  }
  const fields = {
    nanoAiu: safeSum(rows, "total_nano_aiu", { integer: false }),
    inputTokens: safeSum(rows, "input_tokens"),
    outputTokens: safeSum(rows, "output_tokens"),
    cacheReadTokens: safeSum(rows, "cache_read_tokens"),
    cacheWriteTokens: safeSum(rows, "cache_write_tokens"),
    reasoningTokens: safeSum(rows, "reasoning_tokens"),
    requestMultiplier: safeSum(rows, "request_multiplier", { integer: false }),
    durationMs: safeSum(rows, "duration_ms", { integer: false }),
    meanTimeToFirstTokenMs: safeAverage(rows, "time_to_first_token_ms"),
    meanInterTokenLatencyMs: safeAverage(rows, "inter_token_latency_ms")
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
    "cachedTokens", "reasoningTokens", "modelTokens", "requestMultiplier", "durationMs"
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
    meanTimeToFirstTokenMs: parent.meanTimeToFirstTokenMs === null
      || worker.meanTimeToFirstTokenMs === null
      ? null
      : ((parent.meanTimeToFirstTokenMs * parent.completionCount)
        + (worker.meanTimeToFirstTokenMs * worker.completionCount))
        / Math.max(1, parent.completionCount + worker.completionCount),
    meanInterTokenLatencyMs: parent.meanInterTokenLatencyMs === null
      || worker.meanInterTokenLatencyMs === null
      ? null
      : ((parent.meanInterTokenLatencyMs * parent.completionCount)
        + (worker.meanInterTokenLatencyMs * worker.completionCount))
        / Math.max(1, parent.completionCount + worker.completionCount),
    completionCount: parent.completionCount + worker.completionCount
  };
}

function eventRole(event) {
  return event.agentId || event.data?.parentToolCallId ? "worker" : "parent";
}

function contractToolName(event) {
  const server = event.data?.mcpServerName;
  const tool = event.data?.mcpToolName;
  if (typeof server === "string" && typeof tool === "string") return `${server}/${tool}`;
  const name = event.data?.toolName;
  return typeof name === "string" && name.startsWith("semantic-corpus-")
    ? `semantic-corpus/${name.slice("semantic-corpus-".length)}`
    : name;
}

function eventOrder(events, ...items) {
  const indices = items.map((item) => events.indexOf(item));
  return indices.every((index) => index >= 0)
    && indices.every((index, position) => position === 0 || indices[position - 1] < index);
}

export function auditDelegatedEventSequence({
  events,
  usageRows,
  expectedKickoff,
  expectedTaskBytes,
  expectedParentModel,
  expectedWorkerModel,
  expectedAgent
}) {
  const reasons = [];
  const skillContexts = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source === "skill-semantic-test-corpus");
  const externalMessages = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source !== "skill-semantic-test-corpus");
  if (externalMessages.length !== 1
    || externalMessages[0]?.data?.content !== expectedKickoff) {
    reasons.push("external user steering differs from the sole atomic kickoff");
  }
  const toolStarts = events.filter((event) => event.type === "tool.execution_start");
  const toolCompletes = events.filter((event) => event.type === "tool.execution_complete");
  const skillStarts = toolStarts.filter((event) =>
    event.data?.toolName === "skill"
    && event.data?.arguments?.skill === "semantic-test-corpus");
  const skillComplete = toolCompletes.filter((event) =>
    event.data?.toolCallId === skillStarts[0]?.data?.toolCallId);
  const taskStarts = toolStarts.filter((event) => event.data?.toolName === "task");
  if (skillStarts.length !== 1 || skillComplete.length !== 1
    || skillComplete[0]?.data?.success !== true) {
    reasons.push("Skill tool start/complete lifecycle is missing or ambiguous");
  }
  if (skillContexts.length !== 1
    || typeof skillContexts[0]?.data?.content !== "string"
    || skillContexts[0].data.content.length === 0
    || !eventOrder(events, skillStarts[0], skillComplete[0], skillContexts[0], taskStarts[0])
    || Date.parse(skillContexts[0]?.timestamp) < Date.parse(skillComplete[0]?.timestamp)
    || Date.parse(skillContexts[0]?.timestamp) > Date.parse(taskStarts[0]?.timestamp)
    || skillComplete[0]?.data?.result === undefined) {
    reasons.push("Skill context injection provenance is invalid");
  }
  const taskPrompt = taskStarts[0]?.data?.arguments?.prompt;
  if (taskStarts.length !== 1
    || taskStarts[0]?.data?.arguments?.agent_type !== expectedAgent
    || typeof taskPrompt !== "string"
    || !Buffer.from(taskPrompt, "utf8").equals(expectedTaskBytes)) {
    reasons.push("Task invocation differs from the exact per-block worker prompt bytes");
  }
  const workerCallId = taskStarts[0]?.data?.toolCallId;
  const parentModels = [...new Set(events
    .filter((event) => !event.agentId
      && ["model.call_start", "assistant.message"].includes(event.type))
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))];
  const workerModels = [...new Set(events
    .filter((event) => event.agentId === workerCallId
      && ["model.call_start", "assistant.message", "subagent.started", "subagent.completed"]
        .includes(event.type))
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))];
  if (parentModels.length !== 1 || parentModels[0] !== expectedParentModel) {
    reasons.push("parent event model attribution is missing or incorrect");
  }
  if (workerModels.length !== 1 || workerModels[0] !== expectedWorkerModel) {
    reasons.push("worker event model attribution is missing or incorrect");
  }
  const parentUsage = usageRows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  const workerUsage = usageRows.filter((row) =>
    row.agent_id === workerCallId
    && row.parent_tool_call_id === workerCallId
    && row.initiator === "sub-agent");
  if (parentUsage.length === 0 || parentUsage.some((row) => row.model !== expectedParentModel)) {
    reasons.push("parent usage attribution is missing or incorrect");
  }
  if (workerUsage.length === 0 || workerUsage.some((row) => row.model !== expectedWorkerModel)) {
    reasons.push("worker usage attribution is missing or incorrect");
  }
  const semanticCalls = toolStarts.filter((event) => MCP_TOOLS.has(contractToolName(event)));
  if (semanticCalls.length === 0) reasons.push("no semantic-corpus MCP calls were observed");
  if (semanticCalls.some((event) =>
    event.agentId !== workerCallId
    || event.data?.parentToolCallId !== workerCallId)) {
    reasons.push("semantic-corpus MCP calls are not worker-attributed");
  }
  return {
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    workerCallId: workerCallId ?? null,
    binding: {
      skillCallId: skillStarts[0]?.data?.toolCallId ?? null,
      skillArgumentsSha256: skillStarts[0]
        ? sha256(Buffer.from(canonicalJson(skillStarts[0].data.arguments), "utf8"))
        : null,
      skillResultSha256: skillComplete[0]
        ? sha256(Buffer.from(canonicalJson(skillComplete[0].data?.result ?? null), "utf8"))
        : null,
      skillContextSha256: skillContexts[0]
        ? sha256(Buffer.from(skillContexts[0].data.content, "utf8"))
        : null,
      taskPromptSha256: typeof taskPrompt === "string"
        ? sha256(Buffer.from(taskPrompt, "utf8"))
        : null
    }
  };
}

function timing(events, parentRows, workerRows, delegated) {
  const starts = events.filter((event) =>
    event.type === "assistant.turn_start" && !event.agentId);
  const ends = events.filter((event) =>
    event.type === "assistant.turn_end" && !event.agentId);
  const startedAt = starts[0]?.timestamp ?? null;
  const endedAt = ends.at(-1)?.timestamp ?? null;
  const wall = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;
  const parentActiveMs = safeSum(parentRows, "duration_ms", { integer: false });
  const workerActiveMs = safeSum(workerRows, "duration_ms", { integer: false });
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
  preSessionFailures = []
}) {
  const usageExport = JSON.parse(usageBytes);
  const sessionCreation = JSON.parse(sessionCreationBytes);
  const design = protocolDesignForId(runManifest.protocolId);
  const abortedV2 = design.version === "v2";
  const legacyTask = design.version === "v2" || design.version === "v3";
  const expectedTaskBytesForSeed = legacyTask ? legacyTaskBytesForSeed : taskBytesForSeed;
  const expectedTaskSha256ForSeed = legacyTask
    ? legacyTaskSha256ForSeed
    : taskSha256ForSeed;
  const {
    contract,
    schedule,
    candidateManifest,
    sourcePin,
    conditions
  } = design;
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
    || planned.order !== runManifest.scheduleOrder
    || planned.globalOrder !== runManifest.globalOrder
    || planned.taskSha256 !== expectedTaskSha256ForSeed(runManifest.seed)
    || planned.kickoffSha256 !== expectedKickoffSha256(
      runManifest.armId,
      runManifest.seed,
      design.version,
      conditions
    )) {
    throw new Error("Run manifest differs from the frozen schedule");
  }
  const boundary = JSON.parse(candidateBoundaryBytes);
  if (boundary.formatVersion !== 3
    || boundary.protocolId !== contract.protocolId
    || boundary.sourceCommit !== sourcePin.sourceCommit
    || boundary.sourceTree !== sourcePin.sourceTree
    || runManifest.sourceCommit !== sourcePin.sourceCommit
    || runManifest.sourceTree !== sourcePin.sourceTree
    || boundary.blockId !== runManifest.blockId
    || boundary.seed !== runManifest.seed
    || boundary.taskSha256 !== expectedTaskSha256ForSeed(runManifest.seed)
    || !Array.isArray(boundary.files)
    || boundary.files.length === 0) {
    throw new Error("Candidate boundary is not the frozen v2 materialization format");
  }
  const expectedCandidateFiles = candidateManifest.files.map((entry) => {
    const source = committedSource(entry.source, sourcePin);
    const bytes = entry.transform === "append-block-seed"
      ? expectedTaskBytesForSeed(runManifest.seed)
      : source.bytes;
    return {
      path: entry.destination.replaceAll("\\", "/"),
      sha256: sha256(bytes),
      sourcePath: source.repositoryPath,
      sourceBlob: source.blobId,
      transform: entry.transform ?? null
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
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
  const candidateCommit = git(liveCandidateRoot, [
    "rev-parse", runManifest.terminalCommit
  ]).trim();
  if (candidateCommit !== runManifest.terminalCommit) {
    throw new Error("Executed candidate commit cannot be resolved exactly");
  }
  const expectedTreePaths = [
    ...expectedCandidateFiles.map((file) => file.path),
    ".benchmark-boundary.json"
  ].sort();
  const observedTreePaths = git(liveCandidateRoot, [
    "ls-tree", "-r", "--name-only", runManifest.terminalCommit
  ])
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
    || taskFile.sha256 !== expectedTaskSha256ForSeed(runManifest.seed)
    || runAttempt.treatment.blockId !== runManifest.blockId
    || runAttempt.treatment.armId !== runManifest.armId
    || runAttempt.treatment.seed !== runManifest.seed
    || runAttempt.treatment.sourceCommit !== runManifest.sourceCommit
    || runAttempt.treatment.sourceTree !== runManifest.sourceTree
    || runAttempt.treatment.terminalCommit !== runManifest.terminalCommit
    || runAttempt.treatment.candidateSnapshotSha256 !== runManifest.candidateSnapshotSha256
    || runAttempt.treatment.sharedTaskSha256 !== taskFile.sha256
    || runAttempt.treatment.kickoffSha256
      !== expectedKickoffSha256(
        runManifest.armId,
        runManifest.seed,
        design.version,
        conditions
      )
    || runAttempt.treatment.wallLimitMs !== contract.commonContract.wallClockMinutes * 60_000
    || runAttempt.treatment.toolCallLimit !== contract.commonContract.maximumToolCalls
    || runAttempt.treatment.modelTokenLimit !== contract.commonContract.maximumTotalModelTokens) {
    throw new Error("Run attempt treatment differs from the frozen schedule, candidate, task, or budgets");
  }
  if (runManifest.attempts.length !== runManifest.attemptNumber
    || basename(runManifest.attempts.at(-1)) !== basename(runAttemptPath)) {
    throw new Error("Run manifest attempt chain does not end at the collected attempt");
  }
  if (preSessionFailures.length !== runManifest.preSessionFailures.length) {
    throw new Error("Pre-session failure records differ from the run manifest");
  }
  for (const [index, item] of preSessionFailures.entries()) {
    const errors = validateJsonSchema(item.record, preSessionFailureSchema, {
      schemaDir: schemaRoot
    });
    let receipt = null;
    try {
      receipt = item.receiptBytes ? JSON.parse(item.receiptBytes) : null;
    } catch {
      receipt = null;
    }
    if (errors.length > 0
      || item.record.runId !== runManifest.runId
      || basename(runManifest.preSessionFailures[index]) !== basename(item.path)
      || basename(item.receiptPath ?? "") !== item.record.receipt.path
      || !item.receiptBytes
      || sha256(item.receiptBytes) !== item.record.receipt.sha256
      || receipt?.receiptKind !== item.record.receipt.receiptKind
      || receipt?.receiptId !== item.record.receipt.receiptId
      || receipt?.kickoffStarted !== false
      || receipt?.sessionCreated !== false
      || JSON.stringify(receipt?.usage) !== JSON.stringify(item.record.usage)) {
      throw new Error("Invalid or mismatched pre-session creation failure record");
    }
  }
  const events = parseJsonLines(eventsBytes);
  const starts = events.filter((event) => event.type === "session.start");
  const results = events.filter((event) => event.type === "result");
  const cliSessionId = runManifest.cliSessionId;
  const sessionReasons = [];
  const capturedPrompt = abortedV2
    ? sessionCreation.request.kickoff.prompt
    : sessionCreation.request.prompt;
  const capturedKickoffBytes = Buffer.from(capturedPrompt, "utf8");
  if (abortedV2) {
    if (starts.length !== 1) {
      sessionReasons.push(`expected one session.start event; found ${starts.length}`);
    }
    if (sessionCreation.response.project_session_id !== runManifest.appProjectSessionId
      || sessionCreation.response.project_id !== sessionCreation.request.project_id
      || sessionCreation.response.execution_location !== contract.commonContract.executionLocation
      || sessionCreation.response.kickoff_mode !== contract.commonContract.kickoffMode
      || sessionCreation.response.kickoff_model !== arm.model
      || sessionCreation.response.kickoff_consumed !== true
      || sessionCreation.response.kickoff_prompt_sha256
        !== runAttempt.treatment.kickoffSha256
      || sessionCreation.request.execution_location !== contract.commonContract.executionLocation
      || sessionCreation.request.kickoff.mode !== contract.commonContract.kickoffMode
      || sessionCreation.request.kickoff.model !== arm.model
      || sessionCreation.request.kickoff.agent !== null
      || sessionCreation.request.candidate_commit !== runManifest.terminalCommit) {
      sessionReasons.push("captured atomic create_session request/response differs from the frozen attempt");
    }
    if (starts[0]?.data?.sessionId !== cliSessionId) {
      sessionReasons.push("session.start CLI session ID differs from the run manifest");
    }
    if (starts[0]?.data?.context?.headCommit !== runManifest.terminalCommit) {
      sessionReasons.push("session.start head commit differs from the terminal candidate commit");
    }
  } else {
    const expectedAvailableTools = availableToolsForArm(arm);
    const usesCurrentCli = design.version === "v4" || design.version === "v5";
    const expectedArgs = (usesCurrentCli ? buildCopilotArgs : buildCopilotArgsV3)({
      prompt: capturedPrompt,
      sessionId: cliSessionId,
      model: arm.model,
      ...(usesCurrentCli ? { reasoningEffort: arm.reasoningEffort } : {}),
      topLevelAgent: arm.topLevelAgent,
      candidateRoot: resolve(candidateRoot),
      mcpConfigPath: sessionCreation.request.mcp_config_path,
      disabledMcpServers: sessionCreation.request.disabled_mcp_servers,
      availableTools: expectedAvailableTools
    });
    if (starts.length !== 0) {
      sessionReasons.push("real prompt-mode JSONL unexpectedly emitted session.start");
    }
    if (results.length !== 1 || events.at(-1) !== results[0]) {
      sessionReasons.push(`expected one terminal result event; found ${results.length}`);
    }
    if (results[0]?.sessionId !== cliSessionId
      || results[0]?.exitCode !== 0
      || sessionCreation.response.result_session_id !== cliSessionId
      || sessionCreation.response.exit_code !== 0
      || sessionCreation.request.session_id !== cliSessionId
      || runManifest.appProjectSessionId !== null
      || runAttempt.appProjectSessionId !== null) {
      sessionReasons.push("predetermined CLI identity or prompt result binding differs from the run manifest");
    }
    if (sessionCreation.request.model !== arm.model
      || sessionCreation.request.agent !== (arm.topLevelAgent ?? null)
      || sessionCreation.request.output_format !== "json"
      || resolve(sessionCreation.request.cwd) !== resolve(candidateRoot)
      || sessionCreation.request.candidate_commit !== runManifest.terminalCommit
      || JSON.stringify(sessionCreation.request.available_tools)
        !== JSON.stringify(expectedAvailableTools)
      || JSON.stringify(sessionCreation.request.command_args) !== JSON.stringify(expectedArgs)
      || sessionCreation.request.disabled_mcp_servers.includes("semantic-corpus")
      || sha256(readFileSync(sessionCreation.request.mcp_config_path))
        !== sessionCreation.request.mcp_config_sha256) {
      sessionReasons.push("captured Copilot prompt invocation differs from the frozen attempt");
    }
  }
  if (sha256(capturedKickoffBytes) !== runAttempt.treatment.kickoffSha256
    || !capturedKickoffBytes.equals(
      expectedKickoffBytes(runManifest.armId, runManifest.seed, design.version, conditions)
    )) {
    sessionReasons.push("captured kickoff bytes differ from the frozen attempt");
  }
  if (usageExport.source.cliSessionId !== cliSessionId) sessionReasons.push("usage export CLI session ID differs from the run manifest");
  if (usageExport.rows.some((row) => row.session_id !== cliSessionId)) {
    sessionReasons.push("usage export includes another CLI session");
  }
  const topLevelTurnStarts = events.filter((event) =>
    event.type === "assistant.turn_start" && !event.agentId);
  const topLevelTurnEnds = events.filter((event) =>
    event.type === "assistant.turn_end" && !event.agentId);
  const skillContextMessages = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source === "skill-semantic-test-corpus");
  const topLevelUserMessages = events.filter((event) =>
    event.type === "user.message"
    && !event.agentId
    && event.data?.source !== "skill-semantic-test-corpus");
  if (topLevelTurnStarts.length === 0
    || topLevelTurnStarts.length !== topLevelTurnEnds.length) {
    sessionReasons.push("attempt must contain one or more complete top-level assistant turns");
  }
  if (topLevelUserMessages.length > 1) {
    sessionReasons.push("attempt contains follow-up user steering after kickoff");
  } else if (topLevelUserMessages.length === 1
    && topLevelUserMessages[0]?.data?.content
    !== capturedPrompt) {
    sessionReasons.push("captured user kickoff differs from the atomic prompt");
  } else if (topLevelUserMessages.length === 0 && !abortedV2) {
    sessionReasons.push("attempt lacks a captured top-level kickoff message");
  }

  const toolStarts = events.filter((event) => event.type === "tool.execution_start");
  const toolCompletes = events.filter((event) => event.type === "tool.execution_complete");
  const toolStartsById = new Map(toolStarts.map((event) => [event.data?.toolCallId, event]));
  const semanticCalls = toolStarts.filter((event) => MCP_TOOLS.has(contractToolName(event)));
  const subagentStarts = events.filter((event) => event.type === "subagent.started");
  const subagentCompletes = events.filter((event) => event.type === "subagent.completed");
  const skillCalls = toolStarts.filter((event) => event.data?.toolName === "skill");
  const skillCompletes = toolCompletes.filter((event) =>
    event.data?.toolCallId === skillCalls[0]?.data?.toolCallId);
  const taskCalls = toolStarts.filter((event) => event.data?.toolName === "task");
  const expectedAgent = arm.agentName;
  const workerCallId = arm.delegated && taskCalls.length === 1
    ? taskCalls[0].data?.toolCallId
    : null;
  const parentRows = usageExport.rows.filter((row) =>
    row.agent_id === null && row.parent_tool_call_id === null);
  const workerRows = arm.delegated
    ? usageExport.rows.filter((row) =>
      row.agent_id === workerCallId
      && row.parent_tool_call_id === workerCallId
      && row.initiator === "sub-agent")
    : [];
  const attributedUsageIds = new Set([...parentRows, ...workerRows].map((row) => row.id));
  const usageRoleReasons = usageExport.rows
    .filter((row) => !attributedUsageIds.has(row.id))
    .map((row) => `usage row ${row.id} is not bound to the exact parent/worker lifecycle`);
  const requested = {
    parent: [arm.model],
    worker: arm.delegated ? [arm.workerModel] : []
  };
  const observed = {
    parent: [...new Set(parentRows.map((row) => row.model))].sort(),
    worker: [...new Set(workerRows.map((row) => row.model))].sort()
  };
  const modelReasons = [...usageRoleReasons];
  const parentModelEvents = events.filter((event) =>
    !event.agentId && ["model.call_start", "assistant.message"].includes(event.type));
  const workerModelEvents = events.filter((event) =>
    event.agentId === workerCallId
    && ["model.call_start", "assistant.message", "subagent.started", "subagent.completed"]
      .includes(event.type));
  const parentEventModels = [...new Set(parentModelEvents
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))].sort();
  const workerEventModels = [...new Set(workerModelEvents
    .map((event) => event.data?.model)
    .filter((model) => typeof model === "string"))].sort();
  if (!abortedV2 && parentModelEvents.some((event) => typeof event.data?.model !== "string")) {
    modelReasons.push("one or more parent JSONL model events lack data.model");
  }
  if (!abortedV2 && arm.delegated
    && workerModelEvents.some((event) => typeof event.data?.model !== "string")) {
    modelReasons.push("one or more worker JSONL model events lack data.model");
  }
  if (!abortedV2 && (parentEventModels.length === 0
    || parentEventModels.some((model) => model !== arm.model))) {
    modelReasons.push(`parent JSONL model mismatch: expected ${arm.model}, observed ${parentEventModels.join(",")}`);
  }
  if (!abortedV2 && arm.delegated && (workerEventModels.length === 0
    || workerEventModels.some((model) => model !== arm.workerModel))) {
    modelReasons.push(`worker JSONL model mismatch: expected ${arm.workerModel}, observed ${workerEventModels.join(",")}`);
  }
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

  const callCounts = new Map();
  for (const event of toolStarts) {
    const key = `${eventRole(event)}\0${contractToolName(event)}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
  }
  const calls = [...callCounts].map(([key, count]) => {
    const [role, name] = key.split("\0");
    return { role, name, count };
  }).sort((left, right) => `${left.role}/${left.name}`.localeCompare(`${right.role}/${right.name}`));
  const mechanismReasons = [];
  const delegatedAudit = arm.delegated && !abortedV2
    ? auditDelegatedEventSequence({
      events,
      usageRows: usageExport.rows,
      expectedKickoff: capturedPrompt,
      expectedTaskBytes: expectedTaskBytesForSeed(runManifest.seed),
      expectedParentModel: arm.model,
      expectedWorkerModel: arm.workerModel,
      expectedAgent
    })
    : null;
  if (delegatedAudit) mechanismReasons.push(...delegatedAudit.reasons);
  if (!abortedV2) {
    const startIds = toolStarts.map((event) => event.data?.toolCallId);
    const completeIds = toolCompletes.map((event) => event.data?.toolCallId);
    if (startIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(startIds).size !== startIds.length) {
      mechanismReasons.push("tool starts require unique nonempty toolCallId values");
    }
    if (completeIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(completeIds).size !== completeIds.length) {
      mechanismReasons.push("tool completions require unique nonempty toolCallId values");
    }
    if (startIds.length !== completeIds.length
      || startIds.some((id) => !completeIds.includes(id))
      || completeIds.some((id) => !startIds.includes(id))) {
      mechanismReasons.push("tool starts and completions are not a bijective lifecycle");
    }
    for (const start of toolStarts) {
      const complete = toolCompletes.find((event) =>
        event.data?.toolCallId === start.data?.toolCallId);
      if (complete && Date.parse(complete.timestamp) < Date.parse(start.timestamp)) {
        mechanismReasons.push(`tool completion precedes start for ${start.data?.toolCallId}`);
      }
    }
  }
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
    if (subagentStarts[0]?.data?.toolCallId !== workerCallId
      || subagentStarts[0]?.agentId !== workerCallId
      || subagentCompletes[0]?.agentId !== workerCallId
      || subagentCompletes[0]?.data?.toolCallId !== workerCallId) {
      mechanismReasons.push("worker lifecycle is not cross-bound to the Task call ID");
    }
    if (subagentStarts[0]?.data?.model !== arm.workerModel
      || subagentCompletes[0]?.data?.model !== arm.workerModel
      || workerRows.some((row) => row.model !== arm.workerModel)) {
      mechanismReasons.push("worker lifecycle/name/usage is not cross-bound to the exact worker model");
    }
    const observedOverride = taskCalls[0]?.data?.arguments?.model;
    if (observedOverride !== undefined) {
      mechanismReasons.push("inherited delegated arm unexpectedly overrides the worker model");
    }
    const expectedWorkerPromptBytes = expectedTaskBytesForSeed(runManifest.seed);
    const observedWorkerPrompt = taskCalls[0]?.data?.arguments?.prompt;
    if (typeof observedWorkerPrompt !== "string"
      || !Buffer.from(observedWorkerPrompt, "utf8").equals(expectedWorkerPromptBytes)) {
      mechanismReasons.push("delegated task prompt differs from the exact per-block task artifact bytes");
    }
    if (skillCalls.length !== 1
      || skillCalls[0]?.data?.arguments?.skill !== "semantic-test-corpus"
      || skillCompletes.length !== 1
      || skillCompletes[0]?.data?.success !== true) {
      mechanismReasons.push("delegated arm requires one complete semantic-test-corpus Skill tool lifecycle");
    }
    if (!abortedV2 && (skillContextMessages.length !== 1
      || typeof skillContextMessages[0]?.data?.content !== "string"
      || skillContextMessages[0].data.content.length === 0
      || !eventOrder(
        events,
        skillCalls[0],
        skillCompletes[0],
        skillContextMessages[0],
        taskCalls[0]
      )
      || Date.parse(skillContextMessages[0]?.timestamp)
        < Date.parse(skillCompletes[0]?.timestamp)
      || Date.parse(skillContextMessages[0]?.timestamp)
        > Date.parse(taskCalls[0]?.timestamp)
      || skillCompletes[0]?.data?.result === undefined)) {
      mechanismReasons.push("Skill context injection lacks exact source provenance or lifecycle ordering");
    }
  } else {
    if (subagentStarts.length > 0 || subagentCompletes.length > 0) {
      mechanismReasons.push("inline arm emitted a subagent lifecycle");
    }
    if (semanticCalls.some((event) => eventRole(event) !== "parent")) {
      mechanismReasons.push("inline MCP call is not parent-attributed");
    }
    if (skillCalls.length > 0 || skillContextMessages.length > 0 || taskCalls.length > 0) {
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
      && ["skill", "task"].includes(name);
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
  const taskCompletion = workerCallId === null
    ? null
    : toolCompletes.find((event) => event.data?.toolCallId === workerCallId);
  const compact = taskCompletion?.data?.result?.content
    ?? subagentCompletes[0]?.data?.result
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
      sourceCommit: sourcePin.sourceCommit,
      sourceTree: sourcePin.sourceTree,
      sourceBlobs: boundary.files.map((file) => ({
        path: file.sourcePath,
        blob: file.sourceBlob
      })).sort((left, right) => left.path.localeCompare(right.path)),
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
      preSessionFailures: preSessionFailures.map((item) => ({
        path: basename(item.path),
        sha256: sha256(item.bytes),
        bytes: item.bytes.length
      })),
      preSessionFailureReceipts: preSessionFailures.map((item) => ({
        path: basename(item.receiptPath),
        sha256: sha256(item.receiptBytes),
        bytes: item.receiptBytes.length
      }))
    },
    trust: {
      status: "local-hash-bound",
      signed: false,
      complianceProof: false,
      limitations: [
        "No detached platform signature or external trust anchor",
        "No signed sandbox, filesystem, network, run, adapter, or metrics envelope",
        "Local hashes establish byte identity only",
        ...(abortedV2
          ? []
          : ["Direct Copilot prompt mode exposes no app project-session identity; appProjectSessionId is null"])
      ]
    },
    availability: {
      session: available(sessionReasons.length === 0 ? "available" : "unavailable", ...sessionReasons),
      model: available(modelReasons.length === 0 ? "available" : "unavailable", ...modelReasons),
      mechanism: available(mechanismReasons.length === 0 ? "available" : "unavailable", ...mechanismReasons),
      fields: {
        premiumRequests: available("unavailable", "assistant_usage_events has no premium-request field"),
        toolSchemas: available("unavailable", "local events do not expose the complete tool schema payload"),
        exposedTools: abortedV2
          ? available("unavailable", "local events do not expose the complete configured tool list")
          : available("available"),
        compaction: available("unavailable", "local events do not expose an authoritative compaction counter"),
        reasoningTokens: available(total.reasoningTokens === null ? "unavailable" : "available",
          total.reasoningTokens === null ? "one or more usage rows omit reasoning_tokens" : null),
        latencyDetails: available(
          total.meanTimeToFirstTokenMs === null || total.meanInterTokenLatencyMs === null
            ? "unavailable"
            : "available",
          total.meanTimeToFirstTokenMs === null || total.meanInterTokenLatencyMs === null
            ? "one or more usage rows omit latency fields"
            : null
        ),
        requestMultiplier: available(total.requestMultiplier === null ? "unavailable" : "available",
          total.requestMultiplier === null ? "one or more usage rows omit request_multiplier" : null),
        parentWait: available(measuredTiming.parentWaitMs === null ? "unavailable" : "available",
          measuredTiming.parentWaitMs === null ? "one complete delegated lifecycle is required" : null),
        sourceReadOnly: available("unavailable", "portable read-only state is not represented in the source formats")
      }
    },
    models: { requested, observed },
    attempt: {
      attemptId: runAttempt.attemptId,
      number: runAttempt.attemptNumber,
      preSessionFailureCount: preSessionFailures.length,
      outcomesOpened: runManifest.outcomesOpenedAt !== null || runAttempt.outcomesOpenedAt !== null
    },
    usage: {
      parent: parentUsage,
      worker: workerUsage,
      total
    },
    operationalUsage: {
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
      exposed: abortedV2
        ? { available: false, names: null }
        : { available: true, names: sessionCreation.request.available_tools },
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
      ...(abortedV2 ? {} : {
        skillCallId: delegatedAudit?.binding.skillCallId ?? null,
        skillArgumentsSha256: delegatedAudit?.binding.skillArgumentsSha256 ?? null,
        skillResultSha256: delegatedAudit?.binding.skillResultSha256 ?? null,
        skillContextSha256: delegatedAudit?.binding.skillContextSha256 ?? null,
        taskPromptSha256: delegatedAudit?.binding.taskPromptSha256 ?? null
      }),
      compactReturn,
      compactReturnBytes: compactReturn === null
        ? null
        : Buffer.byteLength(compactReturn, "utf8")
    },
    timing: {
      ...measuredTiming,
      globalOrder: runManifest.globalOrder
    },
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
      completionCount: usageExport.rows.length,
      compactionCount: null
    },
    deviations: [
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
  const outputPath = argument(args, "--out");
  if (!eventsPath || !usagePath || !sessionCreationPath || !manifestPath || !attemptPath || !candidateBoundaryPath || !candidateRoot || !outputPath) {
    throw new Error("Usage: node scripts/collect-local-evidence.mjs --events <events.jsonl> --usage <usage.json> --session-creation <create-session.json> --candidate-boundary <boundary.json> --candidate-root <clean-candidate-repository> --run-manifest <manifest.json> --run-attempt <attempt.json> --out <local-evidence.json>");
  }
  const runManifestBytes = readFileSync(resolve(manifestPath));
  const runAttemptBytes = readFileSync(resolve(attemptPath));
  const preSessionFailures = JSON.parse(runManifestBytes).preSessionFailures.map((path) => {
    const absolutePath = resolve(dirname(manifestPath), path);
    const bytes = readFileSync(absolutePath);
    const record = JSON.parse(bytes);
    const receiptPath = resolve(dirname(absolutePath), record.receipt.path);
    return {
      path: absolutePath,
      bytes,
      record,
      receiptPath,
      receiptBytes: readFileSync(receiptPath)
    };
  });
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
    preSessionFailures
  });
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.runId}: local evidence collected; signed=false complianceProof=false\n`);
}
