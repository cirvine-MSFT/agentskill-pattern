#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeCandidate } from "./materialize-candidate.mjs";
import {
  kickoffBytesForRun,
  kickoffSha256ForRun,
  taskSha256ForSeed
} from "./execution-contract.mjs";
import { collectLocalEvidence } from "./collect-local-evidence.mjs";
import { exportLocalUsage } from "./export-local-usage.mjs";
import { preflightLocalModel } from "./preflight-local-model.mjs";
import { preflightExecution } from "./preflight-execution.mjs";
import { validateLivePreflight } from "./validate-live-preflight.mjs";
import {
  MCP_TOOL_NAMES,
  availableToolsForArm,
  buildCopilotArgs,
  parseCopilotJsonl,
  resultEvent
} from "./copilot-cli-v5.mjs";
import { validateStartOrder } from "./validate-start-order.mjs";
import { runDeterministicBlock } from "./run-deterministic-block.mjs";
import { snapshotLocalCorpusStaging } from "../evaluator/adapter.mjs";
import {
  canonicalMetricsBytes,
  deriveFailureMetricsArtifact,
  deriveMetricsArtifact
} from "../evaluator/metrics.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "schedule.json"), "utf8")
);
const contract = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "arm-contract.json"), "utf8")
);
const sourcePin = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "source-pin.json"), "utf8")
);
const partialUsageSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "partial-usage.schema.json"), "utf8")
);
const usageExportSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "local-usage-export.schema.json"), "utf8")
);
const unitDispositionSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "unit-disposition.schema.json"), "utf8")
);
const evaluationRecordSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "evaluation-record.schema.json"), "utf8")
);
const preSessionFailureSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "pre-session-failure.schema.json"), "utf8")
);
const runAttemptSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "run-attempt.schema.json"), "utf8")
);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeOnce(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, resolve(command)]
    : [command];
}

function identity(path) {
  const stats = statSync(path, { bigint: true });
  return { device: stats.dev.toString(), fileId: stats.ino.toString() };
}

export function createSandbox(candidateRoot) {
  const runtimeRoot = resolve(candidateRoot, ".benchmark-runtime");
  const stagingRoot = resolve(runtimeRoot, "corpus-staging");
  const configPath = resolve(runtimeRoot, "corpus-sandbox.json");
  const mcpConfigPath = resolve(runtimeRoot, "mcp-config.json");
  const contractRoot = resolve(candidateRoot, "corpus-contract");
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const request = JSON.parse(readFileSync(resolve(contractRoot, "request.json"), "utf8"));
  const token = randomBytes(32).toString("base64url");
  const config = {
    version: 1,
    sandboxKind: "restricted-acl",
    tokenHash: `sha256:${sha256(Buffer.from(token, "utf8"))}`,
    requestHash: request.requestHash,
    roots: {
      contract: {
        path: contractRoot,
        access: "read-only",
        identity: identity(contractRoot)
      },
      staging: {
        path: stagingRoot,
        access: "read-write",
        identity: identity(stagingRoot)
      }
    },
    lock: { waitTimeoutMs: 5000, staleAfterMs: 60000 }
  };
  writeOnce(configPath, jsonBytes(config));
  writeOnce(mcpConfigPath, jsonBytes({
    mcpServers: {
      "semantic-corpus": {
        command: process.execPath,
        args: [resolve(candidateRoot, "tools", "semantic-corpus-mcp", "server.mjs")],
        tools: MCP_TOOL_NAMES.map((name) => name.slice("semantic-corpus-".length))
      }
    }
  }));
  for (const file of readdirSync(contractRoot)) {
    chmodSync(resolve(contractRoot, file), 0o444);
  }
  chmodSync(configPath, 0o444);
  chmodSync(mcpConfigPath, 0o444);
  const excludePath = resolve(candidateRoot, ".git", "info", "exclude");
  writeFileSync(excludePath, "\n.benchmark-runtime/\n", { flag: "a" });
  return {
    runtimeRoot,
    stagingRoot,
    configPath,
    mcpConfigPath,
    contractRoot,
    token,
    config
  };
}

function nextStart(indexPath, planned) {
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : {
        formatVersion: 1,
        protocolId: contract.protocolId,
        captures: []
      };
  const errors = validateStartOrder(index, { requireComplete: false });
  if (errors.length > 0) throw new Error(`Existing start index is invalid: ${errors[0]}`);
  if (index.captures.length + 1 !== planned.globalOrder) {
    throw new Error(`Next frozen run is global order ${index.captures.length + 1}, not ${planned.runId}`);
  }
  return index;
}

function storeStart(indexPath, index, capture) {
  const next = { ...index, captures: [...index.captures, capture] };
  const errors = validateStartOrder(next, { requireComplete: next.captures.length === 72 });
  if (errors.length > 0) throw new Error(`Captured start order is invalid: ${errors[0]}`);
  const pending = `${indexPath}.next`;
  const nextBytes = jsonBytes(next);
  if (existsSync(pending)) {
    if (!readFileSync(pending).equals(nextBytes)) {
      throw new Error("Pending start-index update differs from the requested frozen capture");
    }
  } else {
    writeFileSync(pending, nextBytes, { flag: "wx" });
  }
  if (existsSync(indexPath)) chmodSync(indexPath, 0o666);
  renameSync(pending, indexPath);
  let finalization = null;
  if (next.captures.length === 72) {
    const bytes = readFileSync(indexPath);
    const shaPath = `${indexPath}.sha256`;
    writeOnce(shaPath, Buffer.from(`${sha256(bytes)}\n`, "utf8"));
    immutable(indexPath);
    immutable(shaPath);
    finalization = { indexPath, shaPath, sha256: sha256(bytes) };
  }
  return { index: next, finalization };
}

function reserveStart(plan) {
  const path = `${plan.startIndexPath}.slot-${String(plan.globalOrder).padStart(2, "0")}.lock`;
  writeOnce(path, jsonBytes({
    protocolId: plan.protocolId,
    runId: plan.runId,
    globalOrder: plan.globalOrder,
    reservedAt: new Date().toISOString()
  }));
  immutable(path);
  return path;
}

function releaseReservation(path) {
  chmodSync(path, 0o666);
  rmSync(path);
}

function nextRecordedAt(index) {
  const previous = Date.parse(index.captures.at(-1)?.recordedAt ?? "");
  const now = Date.now();
  return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString();
}

function orderCapture(plan, sourcePath, sourceBytes, disposition, recordedAt) {
  return {
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    sequence: plan.globalOrder,
    disposition,
    recordedAt,
    startedAt: disposition === "started" ? recordedAt : null,
    sourcePath: relative(dirname(plan.startIndexPath), sourcePath).replaceAll("\\", "/"),
    sourceSha256: sha256(sourceBytes)
  };
}

function immutable(path) {
  chmodSync(path, 0o444);
}

function partialSource(plan, name, reason) {
  const path = resolve(plan.artifactRoot, name);
  if (!existsSync(path)) {
    return {
      source: { available: false, path: null, sha256: null, reason },
      bytes: null
    };
  }
  const bytes = readFileSync(path);
  return {
    source: {
      available: true,
      path: name,
      sha256: sha256(bytes),
      reason: null
    },
    bytes
  };
}

function partialMeasurement(value, reason) {
  return Number.isFinite(value) && value >= 0
    ? { available: true, value, reason: null }
    : { available: false, value: null, reason };
}

export function classifyMeasuredFailure(reason) {
  const text = String(reason).toLowerCase();
  const kinds = [];
  if (/model|completion|usage model/u.test(text)) kinds.push("model");
  if (/skill.*(?:order|before|context)|before skill/u.test(text)) kinds.push("skill-order");
  if (/task.*(?:byte|prompt|newline|terminal lf)|sha-256/u.test(text)) kinds.push("task-bytes");
  if (/worker.*(?:model|identity|agent|attribut)|agent identity/u.test(text)) {
    kinds.push("worker-identity");
  }
  if (/mechanism|delegat|routing/u.test(text)) kinds.push("mechanism");
  if (/\bmcp\b|semantic-corpus|tool completion/u.test(text)) kinds.push("mcp");
  if (/terminal|exit|result event|process=/u.test(text)) kinds.push("terminal");
  if (/staging|manifest|scenario/u.test(text)) kinds.push("partial-staging");
  if (/budget|token limit|tool call limit/u.test(text)) kinds.push("budget");
  if (/timeout|timed out|etimedout/u.test(text)) kinds.push("timeout");
  if (/tool misuse|forbidden tool|tool surface/u.test(text)) kinds.push("tool-misuse");
  if (/spawn|process|filesystem|artifact/u.test(text)) kinds.push("post-start-infrastructure");
  return kinds.length > 0 ? [...new Set(kinds)].sort() : ["unknown"];
}

function exportUsageAfterSettlement(options, plan) {
  const exporter = options.usageExporter ?? exportLocalUsage;
  if (options.usageExporter) {
    return exporter({
      database: options.sessionStore,
      cliSessionId: plan.cliSessionId,
      exportedAt: new Date().toISOString()
    });
  }
  let latest = null;
  let stableSamples = 0;
  let previousHash = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    latest = exporter({
      database: options.sessionStore,
      cliSessionId: plan.cliSessionId,
      exportedAt: new Date().toISOString()
    });
    const rowsHash = sha256(Buffer.from(JSON.stringify(latest.rows), "utf8"));
    stableSamples = rowsHash === previousHash ? stableSamples + 1 : 1;
    previousHash = rowsHash;
    if (latest.rows.length > 0 && stableSamples >= 3) return latest;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return latest;
}

function derivePartialUsage(plan, lifecyclePath, lifecycleBytes) {
  const usageSource = partialSource(
    plan,
    "captured.usage.json",
    "usage export was not produced before the attempt became uncertain"
  );
  const eventsSource = partialSource(
    plan,
    "captured.events.jsonl",
    "raw events were not produced before the attempt became uncertain"
  );
  const responseSource = partialSource(
    plan,
    "process-stdout.txt",
    "Copilot JSONL result was not produced before the attempt became uncertain"
  );
  const finalAttemptSource = partialSource(
    plan,
    "attempt-1.json",
    "final attempt record was not produced before the attempt became uncertain"
  );
  const attemptSource = finalAttemptSource.bytes
    ? finalAttemptSource
    : partialSource(
        plan,
        "attempt-start.json",
        "attempt-start record was not produced before the attempt became uncertain"
      );
  const invalidSources = [];
  const invalidateSource = (kind, source, validationError) => {
    if (source.bytes) {
      invalidSources.push({
        kind,
        path: source.source.path,
        sha256: source.source.sha256,
        byteLength: source.bytes.length,
        validationError
      });
    }
    source.source = {
      available: false,
      path: null,
      sha256: null,
      reason: validationError
    };
  };
  let response = null;
  const unavailableUsage = (field) => partialMeasurement(
    null,
    usageSource.source.reason ?? `usage export does not provide finite ${field}`
  );
  let usageRows = null;
  let usageSessionId = null;
  if (usageSource.bytes) {
    try {
      const usage = JSON.parse(usageSource.bytes);
      const errors = validateJsonSchema(usage, usageExportSchema, {
        schemaDir: resolve(root, "schemas")
      });
      if (errors.length === 0
        && usage.source.cliSessionId
        && usage.rows.every((row) =>
          row.session_id === usage.source.cliSessionId)) {
        usageRows = usage.rows;
        usageSessionId = usage.source.cliSessionId;
      } else {
        invalidateSource(
          "usage",
          usageSource,
          errors.length > 0
          ? `usage export is invalid: ${errors[0].path} ${errors[0].message}`
          : "usage export rows are not bound to one CLI session"
        );
      }
    } catch (error) {
      invalidateSource(
        "usage",
        usageSource,
        `usage export is unreadable: ${error.message}`
      );
    }
  }
  let events = null;
  if (eventsSource.bytes) {
    try {
      events = parseCopilotJsonl(eventsSource.bytes);
      try {
        const result = resultEvent(events, plan.cliSessionId);
        response = { cli_session_id: result.sessionId };
      } catch (error) {
        invalidateSource("response", responseSource, error.message);
      }
    } catch (error) {
      invalidateSource(
        "events",
        eventsSource,
        `raw events are invalid: ${error.message}`
      );
      events = null;
    }
  }
  if (usageRows) {
    const expectedSessionId = response?.cli_session_id ?? plan.cliSessionId;
    if (usageSessionId !== expectedSessionId) {
      invalidateSource(
        "usage",
        usageSource,
        "usage export session differs from the predetermined/result session"
      );
      usageRows = null;
    }
  }
  const sum = (field) => {
    if (!usageRows
      || usageRows.some((row) =>
        !Number.isFinite(row[field]) || row[field] < 0)) {
      return unavailableUsage(field);
    }
    return partialMeasurement(
      usageRows.reduce((total, row) => total + row[field], 0),
      null
    );
  };
  const nanoAiu = sum("total_nano_aiu");
  const inputTokens = sum("input_tokens");
  const outputTokens = sum("output_tokens");
  const modelTokens = inputTokens.available && outputTokens.available
    ? partialMeasurement(inputTokens.value + outputTokens.value, null)
    : unavailableUsage("model tokens");
  let attempt = {
    available: false,
    attemptId: null,
    path: null,
    sha256: null,
    reason: attemptSource.source.reason
  };
  if (attemptSource.bytes) {
    try {
      const record = JSON.parse(attemptSource.bytes);
      const errors = validateJsonSchema(record, runAttemptSchema, {
        schemaDir: resolve(root, "schemas")
      });
      if (errors.length === 0
        && record.runId === plan.runId
        && record.cliSessionId === plan.cliSessionId
        && record.attemptNumber === 1
        && typeof record.attemptId === "string") {
        attempt = {
          available: true,
          attemptId: record.attemptId,
          path: attemptSource.source.path,
          sha256: attemptSource.source.sha256,
          reason: null
        };
      } else {
        attempt.reason = errors.length > 0
          ? `attempt record is invalid: ${errors[0].path} ${errors[0].message}`
          : "attempt record does not bind this run/session/attempt";
      }
    } catch (error) {
      attempt.reason = `attempt record is unreadable: ${error.message}`;
    }
  }
  const record = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    status: "measured-failure",
    lifecycle: {
      available: true,
      path: relative(plan.artifactRoot, lifecyclePath).replaceAll("\\", "/"),
      sha256: sha256(lifecycleBytes),
      reason: null
    },
    attempt,
    sources: {
      events: eventsSource.source,
      usage: usageSource.source,
      response: responseSource.source
    },
    invalidSources,
    metrics: {
      aiCredits: nanoAiu.available
        ? partialMeasurement(nanoAiu.value / 1e9, null)
        : unavailableUsage("AI credits"),
      nanoAiu,
      inputTokens,
      outputTokens,
      modelTokens,
      completionCount: usageRows
        ? partialMeasurement(usageRows.length, null)
        : unavailableUsage("completion count"),
      durationMs: sum("duration_ms"),
      toolCallCount: events
        ? partialMeasurement(events.filter((event) =>
          event.type === "tool.execution_start").length, null)
        : partialMeasurement(null, eventsSource.source.reason),
      toolResultCount: events
        ? partialMeasurement(events.filter((event) =>
          event.type === "tool.execution_complete").length, null)
        : partialMeasurement(null, eventsSource.source.reason)
    }
  };
  const errors = validateJsonSchema(record, partialUsageSchema, {
    schemaDir: resolve(root, "schemas")
  });
  if (errors.length > 0) {
    throw new Error(`Partial usage record is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return record;
}

function writeUnitDisposition(plan, status, reason, sourcePath, sourceBytes, {
  evidenceKind,
  orderSourcePath = sourcePath,
  orderSourceBytes = sourceBytes,
  partialUsagePath = null,
  partialUsageBytes = null,
  metricsPath = null,
  metricsBytes = null,
  evaluationPath = null,
  evaluationBytes = null
}) {
  const disposition = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    status,
    reason,
    evidenceKind,
    sourcePath: relative(plan.artifactRoot, sourcePath).replaceAll("\\", "/"),
    sourceSha256: sha256(sourceBytes),
    orderSourcePath: relative(
      dirname(plan.startIndexPath),
      orderSourcePath
    ).replaceAll("\\", "/"),
    orderSourceSha256: sha256(orderSourceBytes),
    partialUsagePath: partialUsagePath
      ? relative(plan.artifactRoot, partialUsagePath).replaceAll("\\", "/")
      : null,
    partialUsageSha256: partialUsageBytes ? sha256(partialUsageBytes) : null
    ,
    metricsPath: metricsPath
      ? relative(plan.artifactRoot, metricsPath).replaceAll("\\", "/")
      : null,
    metricsSha256: metricsBytes ? sha256(metricsBytes) : null,
    evaluationPath: evaluationPath
      ? relative(plan.artifactRoot, evaluationPath).replaceAll("\\", "/")
      : null,
    evaluationSha256: evaluationBytes ? sha256(evaluationBytes) : null,
    retryCount: 0
  };
  const errors = validateJsonSchema(disposition, unitDispositionSchema, {
    schemaDir: resolve(root, "schemas")
  });
  if (errors.length > 0) {
    throw new Error(`Unit disposition is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  const dispositionPath = resolve(plan.artifactRoot, "unit-disposition.json");
  writeOnce(dispositionPath, jsonBytes(disposition));
  immutable(dispositionPath);
  return { disposition, dispositionPath };
}

function persistPreSessionFailure(plan, startIndex, phase, reason) {
  const attemptedAt = nextRecordedAt(startIndex);
  const evidence = readdirSync(plan.artifactRoot)
    .map((name) => resolve(plan.artifactRoot, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: basename(path),
        sha256: sha256(bytes),
        bytes: bytes.length
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const failure = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    failureId: `${plan.runId}-pre-session`,
    runId: plan.runId,
    attemptedAt,
    phase,
    kickoffStarted: false,
    sessionCreated: false,
    reason,
    evidence,
    receipt: null,
    usage: {
      aiCredits: null,
      premiumRequests: null,
      nanoAiu: null,
      modelTokens: null,
      completionCount: null,
      unavailableReason: "No authoritative zero-session/zero-usage receipt is available"
    }
  };
  const errors = validateJsonSchema(failure, preSessionFailureSchema, {
    schemaDir: resolve(root, "schemas")
  });
  if (errors.length > 0) {
    throw new Error(`Pre-session failure is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  const failurePath = resolve(plan.artifactRoot, "pre-session-failure.json");
  const failureBytes = jsonBytes(failure);
  writeOnce(failurePath, failureBytes);
  immutable(failurePath);
  const disposition = writeUnitDisposition(
    plan, "unavailable", reason, failurePath, failureBytes, {
      evidenceKind: "pre-session-failure"
    }
  );
  const stored = storeStart(
    plan.startIndexPath,
    startIndex,
    orderCapture(plan, failurePath, failureBytes, "unavailable", attemptedAt)
  );
  return {
    status: "unavailable",
    plan,
    failure,
    failurePath,
    ...disposition,
    startFinalization: stored.finalization
  };
}

function recoveredOutcomeDimensions(plan) {
  const evaluationPath = resolve(plan.artifactRoot, "evaluation.json");
  if (existsSync(evaluationPath)) {
    const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8"));
    return {
      treatmentAdherent: evaluation.treatmentAdherent === true,
      operationalSuccess: evaluation.operationalSuccess === true
    };
  }
  const modelPreflightPath = resolve(plan.artifactRoot, "model-preflight.json");
  const treatmentAdherent = plan.armId === 0
    ? existsSync(resolve(plan.artifactRoot, "execution.json"))
    : existsSync(modelPreflightPath)
      && JSON.parse(readFileSync(modelPreflightPath, "utf8")).status === "pass";
  const processResultPath = resolve(plan.artifactRoot, "process-result.json");
  const sessionCreationPath = resolve(plan.artifactRoot, "session-creation.json");
  const attemptPath = resolve(plan.artifactRoot, "attempt-1.json");
  const processSucceeded = existsSync(processResultPath)
    && JSON.parse(readFileSync(processResultPath, "utf8")).status === 0
    && existsSync(sessionCreationPath)
    && JSON.parse(readFileSync(sessionCreationPath, "utf8")).response.exit_code === 0;
  const terminalReturn = existsSync(attemptPath)
    ? JSON.parse(readFileSync(attemptPath, "utf8")).terminalReturn
    : null;
  const operationalSuccess = plan.armId === 0
    ? existsSync(resolve(plan.artifactRoot, "lifecycle-end.json"))
    : processSucceeded
      && typeof terminalReturn === "string"
      && /^corpus-staging\/manifest\.json - \d+ scenarios - SUCCESS$/u.test(terminalReturn);
  return { treatmentAdherent, operationalSuccess };
}

function persistExactOrAlternate(primaryPath, alternateName, bytes) {
  if (!existsSync(primaryPath)) {
    writeOnce(primaryPath, bytes);
    return { path: primaryPath, bytes };
  }
  const persisted = readFileSync(primaryPath);
  if (persisted.equals(bytes)) return { path: primaryPath, bytes: persisted };
  const alternatePath = resolve(dirname(primaryPath), alternateName);
  if (!existsSync(alternatePath)) writeOnce(alternatePath, bytes);
  const alternateBytes = readFileSync(alternatePath);
  if (!alternateBytes.equals(bytes)) {
    throw new Error(`Existing ${alternateName} differs from deterministic recovery output`);
  }
  return { path: alternatePath, bytes: alternateBytes };
}

function exactArtifact(path, expectedSha256) {
  return typeof path === "string"
    && typeof expectedSha256 === "string"
    && existsSync(path)
    && sha256(readFileSync(path)) === expectedSha256;
}

function validDispositionBundle(plan, validEvaluation, evaluationBytes) {
  const dispositionPath = resolve(plan.artifactRoot, "unit-disposition.json");
  if (!existsSync(dispositionPath)) return false;
  const disposition = JSON.parse(readFileSync(dispositionPath, "utf8"));
  const errors = validateJsonSchema(disposition, unitDispositionSchema, {
    schemaDir: resolve(root, "schemas")
  });
  const bindings = [
    [resolve(plan.artifactRoot, disposition.sourcePath), disposition.sourceSha256],
    [resolve(dirname(plan.startIndexPath), disposition.orderSourcePath),
      disposition.orderSourceSha256],
    [disposition.partialUsagePath
      ? resolve(plan.artifactRoot, disposition.partialUsagePath)
      : null, disposition.partialUsageSha256],
    [disposition.metricsPath
      ? resolve(plan.artifactRoot, disposition.metricsPath)
      : null, disposition.metricsSha256],
    [disposition.evaluationPath
      ? resolve(plan.artifactRoot, disposition.evaluationPath)
      : null, disposition.evaluationSha256]
  ];
  return errors.length === 0
    && disposition.protocolId === contract.protocolId
    && disposition.runId === plan.runId
    && disposition.blockId === plan.blockId
    && disposition.armId === plan.armId
    && disposition.status === "measured-failure"
    && disposition.retryCount === 0
    && bindings.every(([path, digest]) =>
      path === null ? digest === null : exactArtifact(path, digest))
    && bindings[4][0] === validEvaluation
    && disposition.evaluationSha256 === sha256(evaluationBytes);
}

function validSuccessBundle(plan, validEvaluation, evaluation) {
  const provenancePath = resolve(plan.artifactRoot, "capture-provenance.json");
  if (evaluation.disposition !== "success" || !existsSync(provenancePath)) return false;
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const expected = new Map(provenance.files.map((file) => [file.path, file.sha256]));
  return [
    validEvaluation,
    evaluation.metricsPath,
    evaluation.snapshotPath
  ].every((path) => {
    const relativePath = relative(plan.artifactRoot, path).replaceAll("\\", "/");
    return exactArtifact(path, expected.get(relativePath));
  });
}

function hasValidatedFinalBundle(plan) {
  const evaluationCandidates = ["failure-evaluation.json", "evaluation.json"]
    .map((name) => resolve(plan.artifactRoot, name))
    .filter((path) => existsSync(path));
  return evaluationCandidates.some((path) => {
    try {
      const evaluationBytes = readFileSync(path);
      const evaluation = JSON.parse(evaluationBytes);
      const errors = validateJsonSchema(evaluation, evaluationRecordSchema, {
        schemaDir: resolve(root, "schemas")
      });
      if (errors.length > 0
        || evaluation.protocolId !== contract.protocolId
        || evaluation.runId !== plan.runId
        || evaluation.blockId !== plan.blockId
        || evaluation.armId !== plan.armId
        || !exactArtifact(evaluation.metricsPath, evaluation.metricsSha256)
        || (evaluation.snapshotPath === null
          ? evaluation.snapshotSha256 !== null
          : !exactArtifact(evaluation.snapshotPath, evaluation.snapshotSha256))) {
        return false;
      }
      return evaluation.disposition === "measured-failure"
        ? validDispositionBundle(plan, path, evaluationBytes)
        : validSuccessBundle(plan, path, evaluation);
    } catch {
      return false;
    }
  });
}

function persistUncertain(plan, startIndex, lifecyclePath, lifecycleBytes, reason) {
  const current = existsSync(plan.startIndexPath)
    ? JSON.parse(readFileSync(plan.startIndexPath, "utf8"))
    : startIndex;
  if (current.captures.length === plan.globalOrder - 1) {
    storeStart(
      plan.startIndexPath,
      current,
      orderCapture(
        plan,
        lifecyclePath,
        lifecycleBytes,
        "started",
        JSON.parse(lifecycleBytes.toString("utf8")).recordedAt
      )
    );
  } else if (current.captures.at(-1)?.runId !== plan.runId) {
    throw new Error("Cannot preserve uncertain attempt because global order advanced unexpectedly");
  }
  let partialUsage = derivePartialUsage(plan, lifecyclePath, lifecycleBytes);
  const partialUsagePath = resolve(plan.artifactRoot, "partial-usage.json");
  let partialUsageBytes = jsonBytes(partialUsage);
  if (!existsSync(partialUsagePath)) {
    writeOnce(partialUsagePath, partialUsageBytes);
  } else {
    partialUsageBytes = readFileSync(partialUsagePath);
    partialUsage = JSON.parse(partialUsageBytes);
    const errors = validateJsonSchema(partialUsage, partialUsageSchema, {
      schemaDir: resolve(root, "schemas")
    });
    if (errors.length > 0
      || partialUsage.protocolId !== contract.protocolId
      || partialUsage.runId !== plan.runId
      || partialUsage.blockId !== plan.blockId
      || partialUsage.armId !== plan.armId) {
      throw new Error("Existing partial usage does not bind the interrupted slot");
    }
  }
  immutable(partialUsagePath);
  const snapshotPath = resolve(plan.artifactRoot, "staging.json");
  let snapshot = null;
  let snapshotFailure = null;
  const evidencePath = resolve(plan.artifactRoot, "local-evidence.json");
  const modelPreflightPath = resolve(plan.artifactRoot, "model-preflight.json");
  if (existsSync(evidencePath) && existsSync(modelPreflightPath)) {
    try {
      const evidenceBytes = readFileSync(evidencePath);
      snapshot = snapshotLocalCorpusStaging({
        corpusContractRoot: resolve(plan.candidateRoot, "corpus-contract"),
        corpusStagingRoot: resolve(
          plan.candidateRoot,
          ".benchmark-runtime",
          "corpus-staging"
        ),
        localEvidence: JSON.parse(evidenceBytes),
        localEvidenceBytes: evidenceBytes,
        modelPreflight: JSON.parse(readFileSync(modelPreflightPath, "utf8")),
        sourceArtifactRoot: plan.artifactRoot,
        sourceCandidateRoot: plan.candidateRoot,
        outputPath: snapshotPath,
        allowTreatmentFailure: true,
        reuseExisting: true
      });
      immutable(snapshotPath);
    } catch (error) {
      snapshotFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const filesBeforeRecord = readdirSync(plan.artifactRoot)
    .map((name) => resolve(plan.artifactRoot, name))
    .filter((path) => statSync(path).isFile());
  const failureKinds = classifyMeasuredFailure(
    snapshotFailure ? `${reason}; partial staging: ${snapshotFailure}` : reason
  );
  const { treatmentAdherent, operationalSuccess } = recoveredOutcomeDimensions(plan);
  const metrics = deriveFailureMetricsArtifact({
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    failureKinds,
    snapshotBytes: snapshot?.bytes ?? null,
    treatmentAdherent,
    operationalSuccess
  });
  const metricsResult = persistExactOrAlternate(
    resolve(plan.artifactRoot, "metrics.json"),
    "failure-metrics.json",
    canonicalMetricsBytes(metrics)
  );
  const metricsPath = metricsResult.path;
  const metricsBytes = metricsResult.bytes;
  immutable(metricsPath);
  const evaluation = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    attemptId: partialUsage.attempt.attemptId,
    snapshotPath: snapshot ? snapshotPath : null,
    snapshotSha256: snapshot ? sha256(snapshot.bytes) : null,
    metricsPath,
    metricsSha256: sha256(metricsBytes),
    executionSha256: null,
    localEvidenceSha256: existsSync(evidencePath)
      ? sha256(readFileSync(evidencePath))
      : null,
    modelPreflightSha256: existsSync(modelPreflightPath)
      ? sha256(readFileSync(modelPreflightPath))
      : null,
    createdAt: JSON.parse(lifecycleBytes.toString("utf8")).recordedAt,
    disposition: "measured-failure",
    treatmentAdherent,
    operationalSuccess,
    failureKinds,
    retryCount: 0
  };
  const evaluationResult = persistExactOrAlternate(
    resolve(plan.artifactRoot, "evaluation.json"),
    "failure-evaluation.json",
    jsonBytes(evaluation)
  );
  const evaluationPath = evaluationResult.path;
  const evaluationBytes = evaluationResult.bytes;
  immutable(evaluationPath);
  let uncertainty = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    status: "measured-failure",
    reason,
    lifecycleSha256: sha256(lifecycleBytes),
    preservedFiles: filesBeforeRecord.map((path) => {
      const bytes = readFileSync(path);
      return {
        path: basename(path),
        bytes: bytes.length,
        sha256: sha256(bytes)
      };
    })
  };
  const uncertaintyPath = resolve(plan.artifactRoot, "uncertainty.json");
  let uncertaintyBytes = jsonBytes(uncertainty);
  if (!existsSync(uncertaintyPath)) {
    writeOnce(uncertaintyPath, uncertaintyBytes);
  } else {
    uncertaintyBytes = readFileSync(uncertaintyPath);
    uncertainty = JSON.parse(uncertaintyBytes);
    if (uncertainty.protocolId !== contract.protocolId
      || uncertainty.runId !== plan.runId
      || uncertainty.blockId !== plan.blockId
      || uncertainty.armId !== plan.armId
      || uncertainty.status !== "measured-failure"
      || uncertainty.lifecycleSha256 !== sha256(lifecycleBytes)) {
      throw new Error("Existing uncertainty record does not bind the interrupted slot");
    }
  }
  const disposition = existsSync(resolve(plan.artifactRoot, "unit-disposition.json"))
    ? null
    : writeUnitDisposition(
      plan, "measured-failure", uncertainty.reason, uncertaintyPath, uncertaintyBytes, {
        evidenceKind: "started-failure",
        orderSourcePath: lifecyclePath,
        orderSourceBytes: lifecycleBytes,
        partialUsagePath,
        partialUsageBytes,
        metricsPath,
        metricsBytes,
        evaluationPath,
        evaluationBytes
      }
    );
  for (const path of [...filesBeforeRecord, uncertaintyPath]) immutable(path);
  return {
    status: "measured-failure",
    plan,
    uncertainty,
    uncertaintyPath,
    partialUsage,
    partialUsagePath,
    metrics,
    metricsPath,
    evaluation,
    evaluationPath,
    ...disposition
  };
}

function recoverInterruptedSlot(plan, planned, preflight) {
  const lifecyclePath = resolve(plan.artifactRoot, "lifecycle-start.json");
  const preSessionFailurePath = resolve(plan.artifactRoot, "pre-session-failure.json");
  const lockPath = `${plan.startIndexPath}.slot-${String(plan.globalOrder).padStart(2, "0")}.lock`;
  const index = existsSync(plan.startIndexPath)
    ? JSON.parse(readFileSync(plan.startIndexPath, "utf8"))
    : { formatVersion: 1, protocolId: contract.protocolId, captures: [] };
  const errors = validateStartOrder(index, { requireComplete: false });
  if (errors.length > 0) throw new Error(`Existing start index is invalid: ${errors[0]}`);
  const pendingPath = `${plan.startIndexPath}.next`;
  if (existsSync(pendingPath)) {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    const pendingErrors = validateStartOrder(pending, { requireComplete: false });
    if (pendingErrors.length > 0) {
      throw new Error(`Pending start index is invalid: ${pendingErrors[0]}`);
    }
    if (JSON.stringify(pending) === JSON.stringify(index)) {
      rmSync(pendingPath);
    } else if (pending.captures.length !== index.captures.length + 1
      || pending.captures.at(-1)?.runId !== plan.runId) {
      throw new Error("Pending start index does not represent this interrupted slot");
    }
  }
  const releaseRecoveredLock = () => {
    if (!existsSync(lockPath)) return;
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.protocolId !== contract.protocolId
      || lock.runId !== plan.runId
      || lock.globalOrder !== plan.globalOrder) {
      throw new Error("Existing reservation does not bind the requested frozen slot");
    }
    releaseReservation(lockPath);
  };
  if (existsSync(preSessionFailurePath)) {
    const failureBytes = readFileSync(preSessionFailurePath);
    const failure = JSON.parse(failureBytes);
    const failureErrors = validateJsonSchema(failure, preSessionFailureSchema, {
      schemaDir: resolve(root, "schemas")
    });
    if (failureErrors.length > 0
      || failure.protocolId !== contract.protocolId
      || failure.runId !== plan.runId
      || failure.kickoffStarted !== false
      || failure.sessionCreated !== false) {
      throw new Error("Existing pre-session failure does not bind the requested frozen slot");
    }
    let startFinalization = null;
    if (index.captures.length === plan.globalOrder - 1) {
      startFinalization = storeStart(
        plan.startIndexPath,
        index,
        orderCapture(
          plan,
          preSessionFailurePath,
          failureBytes,
          "unavailable",
          failure.attemptedAt
        )
      ).finalization;
    } else if (index.captures.length !== plan.globalOrder
      || index.captures.at(-1)?.runId !== plan.runId) {
      throw new Error("Interrupted pre-session failure cannot be recovered at the current order");
    }
    const dispositionPath = resolve(plan.artifactRoot, "unit-disposition.json");
    const dispositionResult = existsSync(dispositionPath)
      ? {
          disposition: JSON.parse(readFileSync(dispositionPath, "utf8")),
          dispositionPath
        }
      : writeUnitDisposition(
          plan,
          "unavailable",
          failure.reason,
          preSessionFailurePath,
          failureBytes,
          { evidenceKind: "pre-session-failure" }
        );
    releaseRecoveredLock();
    return {
      status: "unavailable",
      plan,
      preflight,
      failure,
      failurePath: preSessionFailurePath,
      ...dispositionResult,
      startFinalization,
      recovered: true
    };
  }
  if (hasValidatedFinalBundle(plan)) {
    throw new Error("Artifact root contains a finalized slot and cannot be resumed");
  }
  if (!existsSync(lifecyclePath)) {
    if (index.captures.length + 1 !== planned.globalOrder) {
      throw new Error("Interrupted pre-session slot no longer matches the next global order");
    }
    const recovered = persistPreSessionFailure(
      plan,
      index,
      "kickoff-preparation",
      "Recovered interrupted preparation before the durable start marker; no process was spawned"
    );
    releaseRecoveredLock();
    return { ...recovered, preflight, recovered: true };
  }
  const lifecycleBytes = readFileSync(lifecyclePath);
  const lifecycle = JSON.parse(lifecycleBytes);
  if (lifecycle.protocolId !== contract.protocolId
    || lifecycle.runId !== plan.runId
    || lifecycle.blockId !== plan.blockId
    || lifecycle.armId !== plan.armId
    || lifecycle.globalOrder !== plan.globalOrder
    || lifecycle.disposition !== "started"
    || lifecycle.taskSha256 !== plan.taskSha256
    || lifecycle.kickoffSha256 !== plan.kickoffSha256) {
    throw new Error("Existing durable lifecycle marker does not bind the requested frozen slot");
  }
  const attemptStartPath = resolve(plan.artifactRoot, "attempt-start.json");
  if (existsSync(attemptStartPath)) {
    const attemptStart = JSON.parse(readFileSync(attemptStartPath, "utf8"));
    const attemptErrors = validateJsonSchema(attemptStart, runAttemptSchema, {
      schemaDir: resolve(root, "schemas")
    });
    if (attemptErrors.length > 0
      || attemptStart.runId !== plan.runId
      || attemptStart.cliSessionId !== plan.cliSessionId
      || attemptStart.status !== "created") {
      throw new Error("Existing attempt-start record does not bind the requested frozen slot");
    }
  }
  if (index.captures.length === plan.globalOrder - 1) {
    storeStart(
      plan.startIndexPath,
      index,
      orderCapture(plan, lifecyclePath, lifecycleBytes, "started", lifecycle.recordedAt)
    );
  } else if (index.captures.length !== plan.globalOrder
    || index.captures.at(-1)?.runId !== plan.runId) {
    throw new Error("Interrupted durable start cannot be recovered at the current global order");
  }
  releaseRecoveredLock();
  return {
    ...persistUncertain(
      plan,
      index,
      lifecyclePath,
      lifecycleBytes,
      "Recovered an interrupted durable start without respawning the measured process"
    ),
    preflight,
    recovered: true
  };
}

export function buildHarnessPlan({
  cli,
  candidateRoot,
  artifactRoot,
  startIndexPath,
  blockId,
  armId,
  disabledMcpServers = []
}) {
  const planned = schedule.runs.find((run) => run.blockId === blockId && run.armId === armId);
  if (!planned) throw new Error("Run is not present in the frozen schedule");
  const arm = contract.arms.find((item) => item.id === armId);
  const generatedTaskSha256 = taskSha256ForSeed(planned.seed);
  const generatedKickoffSha256 = armId === 0
    ? null
    : kickoffSha256ForRun(armId, planned.seed);
  if (planned.taskSha256 !== generatedTaskSha256
    || planned.kickoffSha256 !== generatedKickoffSha256) {
    throw new Error("Generated task/kickoff bytes differ from the frozen planned SHA-256");
  }
  const args = armId === 0 ? [] : [
    ...buildCopilotArgs({
      prompt: kickoffBytesForRun(armId, planned.seed).toString("utf8"),
      sessionId: planned.sessionId,
      model: arm.model,
      reasoningEffort: arm.reasoningEffort,
      topLevelAgent: arm.topLevelAgent,
      candidateRoot: resolve(candidateRoot),
      mcpConfigPath: resolve(candidateRoot, ".benchmark-runtime", "mcp-config.json"),
      disabledMcpServers: disabledMcpServers.filter((name) => name !== "semantic-corpus"),
      availableTools: availableToolsForArm(arm)
    })
  ];
  return {
    protocolId: contract.protocolId,
    runId: planned.runId,
    blockId,
    armId,
    seed: planned.seed,
    scheduleOrder: planned.order,
    globalOrder: planned.globalOrder,
    taskSha256: planned.taskSha256,
    kickoffSha256: planned.kickoffSha256,
    cliSessionId: planned.sessionId,
    sourcePin,
    candidateRoot: resolve(candidateRoot),
    artifactRoot: resolve(artifactRoot),
    startIndexPath: resolve(startIndexPath),
    atomicCommand: { command: cli, args }
  };
}

export function runControlledHarness(options) {
  const preflight = options.preflight ?? preflightExecution(options.cli, {
    sessionStore: options.sessionStore,
    capturedAt: options.capturedAt
  });
  const plan = buildHarnessPlan({
    ...options,
    disabledMcpServers: preflight.configuredMcpServers
  });
  const planned = schedule.runs.find((run) => run.runId === plan.runId);
  const arm = contract.arms.find((item) => item.id === plan.armId);
  const armPreflight = preflight.arms.find((item) => item.armId === plan.armId);
  const livePreflightReasons = options.livePreflight
    ? validateLivePreflight(options.livePreflight)
    : ["a passing pilot-only live preflight artifact is required"];
  if (options.dryRun) {
    return {
      status: "dry-run",
      plan,
      preflight,
      livePreflight: {
        status: livePreflightReasons.length === 0 ? "pass" : "unavailable",
        reasons: livePreflightReasons
      }
    };
  }
  if (livePreflightReasons.length > 0) {
    throw new Error(
      `Measured execution is blocked before slot reservation: ${livePreflightReasons.join("; ")}`
    );
  }
  if (existsSync(plan.artifactRoot) && readdirSync(plan.artifactRoot).length > 0) {
    return recoverInterruptedSlot(plan, planned, preflight);
  }
  mkdirSync(plan.artifactRoot, { recursive: true });
  const startIndex = nextStart(plan.startIndexPath, planned);
  const reservationPath = reserveStart(plan);
  let reservationActive = true;
  const releaseReservationOnce = () => {
    if (!reservationActive) return;
    releaseReservation(reservationPath);
    reservationActive = false;
  };
  const preflightPath = resolve(plan.artifactRoot, "execution-preflight.json");
  const preflightBytes = jsonBytes(preflight);
  writeOnce(preflightPath, preflightBytes);
  immutable(preflightPath);
  if (armPreflight.status !== "available") {
    const unavailable = persistPreSessionFailure(
      plan,
      startIndex,
      "preflight",
      armPreflight.reasons.join("; ")
    );
    releaseReservationOnce();
    return {
      ...unavailable,
      preflight,
      reasons: armPreflight.reasons
    };
  }
  const preSessionFailures = [];
  if (plan.armId === 0) {
    let lifecyclePath;
    let lifecycleBytes;
    let startCapture;
    let startStored;
    let lifecycle;
    try {
      const recordedAt = nextRecordedAt(startIndex);
      lifecycle = {
        formatVersion: 1,
        protocolId: contract.protocolId,
        runId: plan.runId,
        blockId: plan.blockId,
        armId: 0,
        seed: plan.seed,
        scheduleOrder: plan.scheduleOrder,
        globalOrder: plan.globalOrder,
        disposition: "started",
        recordedAt,
        startedAt: recordedAt,
        taskSha256: plan.taskSha256,
        kickoffSha256: null
      };
      lifecyclePath = resolve(plan.artifactRoot, "lifecycle-start.json");
      lifecycleBytes = jsonBytes(lifecycle);
      writeOnce(lifecyclePath, lifecycleBytes);
      immutable(lifecyclePath);
      startCapture = orderCapture(
        plan, lifecyclePath, lifecycleBytes, "started", recordedAt
      );
      startStored = storeStart(plan.startIndexPath, startIndex, startCapture);
      releaseReservationOnce();
    } catch (error) {
      releaseReservationOnce();
      if (lifecyclePath && existsSync(lifecyclePath)) {
        return {
          ...persistUncertain(
            plan,
            startIndex,
            lifecyclePath,
            lifecycleBytes,
            error instanceof Error ? error.message : String(error)
          ),
          preflight
        };
      }
      throw error;
    }
    const completeBaseline = () => {
    const result = runDeterministicBlock(plan.blockId, { startEvidence: lifecycle });
    const snapshotPath = resolve(plan.artifactRoot, "staging.json");
    const executionPath = resolve(plan.artifactRoot, "execution.json");
    const completionPath = resolve(plan.artifactRoot, "lifecycle-end.json");
    const metricsPath = resolve(plan.artifactRoot, "metrics.json");
    const evaluationPath = resolve(plan.artifactRoot, "evaluation.json");
    const executionBytes = jsonBytes(result.execution);
    if (!result.startBytes.equals(lifecycleBytes)) {
      throw new Error("Deterministic runner start evidence differs from durable lifecycle marker");
    }
    writeOnce(completionPath, result.endBytes);
    const metrics = deriveMetricsArtifact(result.bytes, {
      runId: plan.runId,
      blockId: plan.blockId,
      armId: 0
    });
    const metricsBytes = canonicalMetricsBytes(metrics);
    const evaluation = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      runId: plan.runId,
      blockId: plan.blockId,
      armId: 0,
      attemptId: null,
      snapshotPath,
      snapshotSha256: sha256(result.bytes),
      metricsPath,
      metricsSha256: sha256(metricsBytes),
      executionSha256: sha256(executionBytes),
      localEvidenceSha256: null,
      modelPreflightSha256: null,
      createdAt: new Date().toISOString(),
      disposition: "success",
      treatmentAdherent: true,
      operationalSuccess: true,
      failureKinds: [],
      retryCount: 0
    };
    for (const [path, bytes] of [
      [snapshotPath, result.bytes],
      [executionPath, executionBytes],
      [metricsPath, metricsBytes],
      [evaluationPath, jsonBytes(evaluation)]
    ]) writeOnce(path, bytes);
    const capturePath = resolve(plan.artifactRoot, "start-capture.json");
    writeOnce(capturePath, jsonBytes(startCapture));
    const files = [
      preflightPath, lifecyclePath, completionPath, snapshotPath, executionPath,
      metricsPath, evaluationPath, capturePath,
      ...(startStored.finalization
        ? [startStored.finalization.indexPath, startStored.finalization.shaPath]
        : [])
    ];
    const provenance = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      evidence: "unsigned-descriptive-only",
      immutablePolicy: "write-once then read-only",
      sourcePin,
      files: files.map((path) => {
        const bytes = readFileSync(path);
        return {
          path: relative(plan.artifactRoot, path).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: sha256(bytes)
        };
      })
    };
    const provenancePath = resolve(plan.artifactRoot, "capture-provenance.json");
    writeOnce(provenancePath, jsonBytes(provenance));
    for (const path of [...files, provenancePath]) immutable(path);
    return { status: "complete", plan, preflight, evaluation, provenance };
    };
    try {
      return completeBaseline();
    } catch (error) {
      return {
        ...persistUncertain(
          plan,
          startIndex,
          lifecyclePath,
          lifecycleBytes,
          error instanceof Error ? error.message : String(error)
        ),
        preflight
      };
    }
  }
  let boundary;
  let sandbox;
  let kickoffBytes;
  let kickoffPath;
  let eventsPath;
  let usagePath;
  let lifecyclePath;
  let lifecycleBytes;
  let preSessionPhase = "candidate-materialization";
  try {
    boundary = materializeCandidate(plan.candidateRoot, { blockId: plan.blockId });
    preSessionPhase = "sandbox-preparation";
    sandbox = createSandbox(plan.candidateRoot);
    preSessionPhase = "kickoff-preparation";
    kickoffBytes = kickoffBytesForRun(plan.armId, plan.seed);
    const taskBytes = readFileSync(
      resolve(plan.candidateRoot, contract.commonContract.taskArtifact)
    );
    if (sha256(taskBytes) !== plan.taskSha256
      || sha256(kickoffBytes) !== plan.kickoffSha256
      || boundary.taskSha256 !== plan.taskSha256) {
      throw new Error("Materialized task/kickoff bytes differ from the frozen planned SHA-256");
    }
    kickoffPath = resolve(plan.artifactRoot, "kickoff.txt");
    writeOnce(kickoffPath, kickoffBytes);
    immutable(kickoffPath);
    eventsPath = resolve(plan.artifactRoot, "captured.events.jsonl");
    usagePath = resolve(plan.artifactRoot, "captured.usage.json");
    const recordedAt = nextRecordedAt(startIndex);
    const lifecycle = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      runId: plan.runId,
      blockId: plan.blockId,
      armId: plan.armId,
      seed: plan.seed,
      scheduleOrder: plan.scheduleOrder,
      globalOrder: plan.globalOrder,
      disposition: "started",
      recordedAt,
      startedAt: recordedAt,
      state: "atomic-copilot-prompt-planned",
      taskSha256: plan.taskSha256,
      kickoffSha256: plan.kickoffSha256,
      candidateSnapshotSha256: boundary.boundarySha256,
      terminalCommit: boundary.terminalCommit
    };
    lifecyclePath = resolve(plan.artifactRoot, "lifecycle-start.json");
    lifecycleBytes = jsonBytes(lifecycle);
    writeOnce(lifecyclePath, lifecycleBytes);
    immutable(lifecyclePath);
  } catch (error) {
    if (lifecyclePath && lifecycleBytes && existsSync(lifecyclePath)) {
      releaseReservationOnce();
      return {
        ...persistUncertain(
          plan,
          startIndex,
          lifecyclePath,
          lifecycleBytes,
          error instanceof Error ? error.message : String(error)
        ),
        preflight
      };
    }
    const unavailable = {
      ...persistPreSessionFailure(
        plan,
        startIndex,
        preSessionPhase,
        error instanceof Error ? error.message : String(error)
      ),
      preflight
    };
    releaseReservationOnce();
    return unavailable;
  }
  const recordedAt = JSON.parse(lifecycleBytes.toString("utf8")).recordedAt;
  const plannedStartCapture = orderCapture(
    plan, lifecyclePath, lifecycleBytes, "started", recordedAt
  );
  const commandArgs = plan.atomicCommand.args;
  const [executable, ...prefix] = commandParts(options.cli);
  const completeAiRun = () => {
  const attemptStartPath = resolve(plan.artifactRoot, "attempt-start.json");
  const attemptTreatment = {
    blockId: plan.blockId,
    armId: plan.armId,
    seed: plan.seed,
    sourceCommit: sourcePin.sourceCommit,
    sourceTree: sourcePin.sourceTree,
    terminalCommit: boundary.terminalCommit,
    candidateSnapshotSha256: boundary.boundarySha256,
    sharedTaskSha256: taskSha256ForSeed(plan.seed),
    kickoffSha256: kickoffSha256ForRun(plan.armId, plan.seed),
    wallLimitMs: 1800000,
    toolCallLimit: 120,
    modelTokenLimit: 100000
  };
  const attemptStart = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    attemptId: `${plan.runId}-attempt-1`,
    runId: plan.runId,
    attemptNumber: 1,
    appProjectSessionId: null,
    cliSessionId: plan.cliSessionId,
    requestedParentModel: arm.model,
    requestedWorkerModel: arm.workerModel ?? null,
    status: "created",
    startedAt: recordedAt,
    endedAt: null,
    terminalReturn: null,
    localEvidencePath: null,
    modelPreflightPath: null,
    treatment: attemptTreatment,
    evaluatorSnapshotPath: null,
    outcomesOpenedAt: null,
    deviations: []
  };
  const attemptStartErrors = validateJsonSchema(attemptStart, runAttemptSchema, {
    schemaDir: resolve(root, "schemas")
  });
  if (attemptStartErrors.length > 0) {
    throw new Error(
      `Attempt-start record is invalid: ${attemptStartErrors[0].path} ${attemptStartErrors[0].message}`
    );
  }
  writeOnce(attemptStartPath, jsonBytes(attemptStart));
  immutable(attemptStartPath);
  const capturePath = resolve(plan.artifactRoot, "start-capture.json");
  writeOnce(capturePath, jsonBytes(plannedStartCapture));
  const startStored = storeStart(plan.startIndexPath, startIndex, plannedStartCapture);
  releaseReservationOnce();
  const stdoutPath = resolve(plan.artifactRoot, "process-stdout.txt");
  const stderrPath = resolve(plan.artifactRoot, "process-stderr.txt");
  const stdoutFd = openSync(stdoutPath, "wx");
  const stderrFd = openSync(stderrPath, "wx");
  let execution;
  try {
    execution = spawnSync(executable, [...prefix, ...commandArgs], {
      cwd: plan.candidateRoot,
      windowsHide: true,
      env: {
        ...process.env,
        SEMANTIC_CORPUS_SANDBOX_CONFIG: sandbox.configPath,
        SEMANTIC_CORPUS_SANDBOX_TOKEN: sandbox.token
      },
      stdio: ["ignore", stdoutFd, stderrFd],
      timeout: contract.commonContract.wallClockMinutes * 60_000,
      killSignal: "SIGTERM"
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const processResultPath = resolve(plan.artifactRoot, "process-result.json");
  const processResult = {
    formatVersion: 1,
    recordedAt: new Date().toISOString(),
    status: execution.status,
    signal: execution.signal,
    error: execution.error
      ? {
          name: execution.error.name,
          message: execution.error.message,
          code: execution.error.code ?? null
        }
      : null
  };
  writeOnce(processResultPath, jsonBytes(processResult));
  immutable(processResultPath);
  const stdoutBytes = readFileSync(stdoutPath);
  writeOnce(eventsPath, stdoutBytes);
  const exportedUsage = exportUsageAfterSettlement(options, plan);
  const usageBytes = jsonBytes(exportedUsage);
  writeOnce(usagePath, usageBytes);
  if (execution.error && execution.status === null) throw execution.error;
  const eventsBytes = stdoutBytes;
  const events = parseCopilotJsonl(eventsBytes);
  const result = resultEvent(events, plan.cliSessionId);
  const processSucceeded = execution.status === 0 && result.exitCode === 0;
  const topLevelMessages = events.filter((event) =>
    event.type === "assistant.message" && !event.agentId);
  const taskStart = events.find((event) =>
    event.type === "tool.execution_start" && event.data?.toolName === "task");
  const taskComplete = events.find((event) =>
    event.type === "tool.execution_complete"
    && event.data?.toolCallId === taskStart?.data?.toolCallId);
  const terminalReturn = arm.delegated
    ? taskComplete?.data?.result?.content ?? null
    : topLevelMessages.at(-1)?.data?.content ?? null;
  const startedAt = events.find((event) =>
    event.type === "user.message" && !event.agentId)?.timestamp ?? recordedAt;
  const response = {
    cli_session_id: result.sessionId,
    started_at: startedAt,
    ended_at: result.timestamp,
    terminal_return: terminalReturn,
    exit_code: result.exitCode
  };

  const boundaryPath = resolve(plan.artifactRoot, "candidate-boundary.json");
  const boundaryBytes = readFileSync(resolve(plan.candidateRoot, ".benchmark-boundary.json"));
  writeOnce(boundaryPath, boundaryBytes);
  const sessionCreation = {
    formatVersion: 2,
    operation: "copilot_prompt",
    capturedAt: response.started_at,
    request: {
      session_id: plan.cliSessionId,
      cwd: plan.candidateRoot,
      candidate_commit: boundary.terminalCommit,
      model: arm.model,
      reasoningEffort: arm.reasoningEffort,
      agent: arm.topLevelAgent,
      prompt: kickoffBytes.toString("utf8"),
      prompt_sha256: plan.kickoffSha256,
      output_format: "json",
      available_tools: availableToolsForArm(arm),
      disabled_mcp_servers: preflight.configuredMcpServers
        .filter((name) => name !== "semantic-corpus"),
      mcp_config_path: sandbox.mcpConfigPath,
      mcp_config_sha256: sha256(readFileSync(sandbox.mcpConfigPath)),
      command_args: commandArgs
    },
    response: {
      result_session_id: response.cli_session_id,
      exit_code: response.exit_code,
      result_timestamp: response.ended_at
    }
  };
  const sessionCreationPath = resolve(plan.artifactRoot, "session-creation.json");
  const attemptPath = resolve(plan.artifactRoot, "attempt-1.json");
  const manifestPath = resolve(plan.artifactRoot, "run-manifest.json");
  const evidencePath = resolve(plan.artifactRoot, "local-evidence.json");
  const modelPreflightPath = resolve(plan.artifactRoot, "model-preflight.json");
  const attempt = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    attemptId: `${plan.runId}-attempt-1`,
    runId: plan.runId,
    attemptNumber: 1,
    appProjectSessionId: null,
    cliSessionId: response.cli_session_id,
    requestedParentModel: arm.model,
    requestedWorkerModel: arm.workerModel ?? null,
    status: "completed",
    startedAt: response.started_at,
    endedAt: response.ended_at,
    terminalReturn: response.terminal_return,
    localEvidencePath: "local-evidence.json",
    modelPreflightPath: "model-preflight.json",
    treatment: attemptTreatment,
    evaluatorSnapshotPath: null,
    outcomesOpenedAt: null,
    deviations: []
  };
  const manifest = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    seed: plan.seed,
    scheduleOrder: plan.scheduleOrder,
    globalOrder: plan.globalOrder,
    sourceCommit: sourcePin.sourceCommit,
    sourceTree: sourcePin.sourceTree,
    appProjectSessionId: null,
    cliSessionId: response.cli_session_id,
    terminalCommit: boundary.terminalCommit,
    candidateSnapshotSha256: boundary.boundarySha256,
    candidateBoundaryPath: "candidate-boundary.json",
    attemptNumber: 1,
    outcomesOpenedAt: null,
    attempts: ["attempt-1.json"],
    preflights: ["model-preflight.json"],
    preSessionFailures: preSessionFailures.map((item) => basename(item.path)),
    deviations: []
  };
  const sessionCreationBytes = jsonBytes(sessionCreation);
  let capturedUsage;
  try {
    capturedUsage = JSON.parse(usageBytes);
  } catch (error) {
    throw new Error(`Captured usage is unreadable: ${error.message}`);
  }
  const capturedUsageErrors = validateJsonSchema(capturedUsage, usageExportSchema, {
    schemaDir: resolve(root, "schemas")
  });
  if (capturedUsageErrors.length > 0
    || capturedUsage.source.cliSessionId !== response.cli_session_id
    || capturedUsage.rows.some((row) =>
      row.session_id !== response.cli_session_id)) {
    throw new Error("Captured usage is invalid or differs from the created CLI session");
  }
  const manifestBytes = jsonBytes(manifest);
  let attemptBytes = jsonBytes(attempt);
  let evidence = collectLocalEvidence({
    eventsBytes,
    eventsPath,
    usageBytes,
    usagePath,
    sessionCreationBytes,
    sessionCreationPath,
    candidateBoundaryBytes: boundaryBytes,
    candidateBoundaryPath: boundaryPath,
    candidateRoot: plan.candidateRoot,
    runManifest: manifest,
    runManifestBytes: manifestBytes,
    runManifestPath: manifestPath,
    runAttempt: attempt,
    runAttemptBytes: attemptBytes,
    runAttemptPath: attemptPath,
    preSessionFailures
  });
  let evidenceBytes = jsonBytes(evidence);
  let modelPreflight = preflightLocalModel(evidence, evidenceBytes);
  if (modelPreflight.status !== "pass") {
    attempt.status = "measured-failure";
    attemptBytes = jsonBytes(attempt);
    evidence = collectLocalEvidence({
      eventsBytes,
      eventsPath,
      usageBytes,
      usagePath,
      sessionCreationBytes,
      sessionCreationPath,
      candidateBoundaryBytes: boundaryBytes,
      candidateBoundaryPath: boundaryPath,
      candidateRoot: plan.candidateRoot,
      runManifest: manifest,
      runManifestBytes: manifestBytes,
      runManifestPath: manifestPath,
      runAttempt: attempt,
      runAttemptBytes: attemptBytes,
      runAttemptPath: attemptPath,
      preSessionFailures
    });
    evidenceBytes = jsonBytes(evidence);
    modelPreflight = preflightLocalModel(evidence, evidenceBytes);
  }
  const modelPreflightBytes = jsonBytes(modelPreflight);
  for (const [path, bytes] of [
    [sessionCreationPath, sessionCreationBytes],
    [attemptPath, attemptBytes],
    [manifestPath, manifestBytes],
    [evidencePath, evidenceBytes],
    [modelPreflightPath, modelPreflightBytes]
  ]) writeOnce(path, bytes);

  const produced = [
    ...preSessionFailures.flatMap((item) => [item.path, item.receiptPath]),
    preflightPath, kickoffPath, lifecyclePath, attemptStartPath,
    stdoutPath, stderrPath, processResultPath,
    eventsPath, usagePath, capturePath, boundaryPath,
    sessionCreationPath, attemptPath, manifestPath, evidencePath, modelPreflightPath,
    ...(startStored.finalization
      ? [startStored.finalization.indexPath, startStored.finalization.shaPath]
      : [])
  ];
  const treatmentAdherent = modelPreflight.status === "pass";
  const terminalSuccess = typeof terminalReturn === "string"
    && /^corpus-staging\/manifest\.json - \d+ scenarios - SUCCESS$/u.test(terminalReturn);
  const terminalFailure = typeof terminalReturn === "string"
    && /^corpus-staging - \d+ scenarios - FAILURE: .+/u.test(terminalReturn);
  const terminalValid = terminalSuccess || terminalFailure;
  const operationalSuccess = processSucceeded && terminalSuccess;
  const failureReasons = [
    ...modelPreflight.reasons,
    ...(!processSucceeded
      ? [`Copilot process/result failure (process=${execution.status}, result=${result.exitCode})`]
      : []),
    ...(!terminalValid ? ["invalid terminal return"] : []),
    ...(terminalFailure ? [`terminal reported failure: ${terminalReturn}`] : [])
  ];
  const failureReason = failureReasons.join("; ") || "local execution failed";
  const measuredFailure = !treatmentAdherent || !operationalSuccess;
  const failureKinds = measuredFailure ? classifyMeasuredFailure(failureReason) : [];
  const snapshotPath = resolve(plan.artifactRoot, "staging.json");
  let snapshot = null;
  let snapshotFailure = null;
  try {
    snapshot = snapshotLocalCorpusStaging({
      corpusContractRoot: sandbox.contractRoot,
      corpusStagingRoot: sandbox.stagingRoot,
      localEvidence: evidence,
      localEvidenceBytes: evidenceBytes,
      modelPreflight,
      sourceArtifactRoot: plan.artifactRoot,
      sourceCandidateRoot: plan.candidateRoot,
      outputPath: snapshotPath,
      allowTreatmentFailure: measuredFailure
    });
  } catch (error) {
    if (!measuredFailure) throw error;
    snapshotFailure = error instanceof Error ? error.message : String(error);
  }
  const metricsPath = resolve(plan.artifactRoot, "metrics.json");
  const metrics = !measuredFailure
    ? deriveMetricsArtifact(snapshot.bytes, {
       runId: plan.runId,
       blockId: plan.blockId,
       armId: plan.armId
     })
    : deriveFailureMetricsArtifact({
       runId: plan.runId,
       blockId: plan.blockId,
       armId: plan.armId,
       failureKinds: snapshotFailure
         ? [...failureKinds, "partial-staging"]
         : failureKinds,
       snapshotBytes: snapshot?.bytes ?? null,
       treatmentAdherent,
       operationalSuccess
     });
  const metricsBytes = canonicalMetricsBytes(metrics);
  writeOnce(metricsPath, metricsBytes);
  const evaluation = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      runId: plan.runId,
      blockId: plan.blockId,
      armId: plan.armId,
      attemptId: attempt.attemptId,
      snapshotPath: snapshot ? snapshotPath : null,
      snapshotSha256: snapshot ? sha256(snapshot.bytes) : null,
      metricsPath,
      metricsSha256: sha256(metricsBytes),
      executionSha256: null,
      localEvidenceSha256: sha256(evidenceBytes),
      modelPreflightSha256: sha256(modelPreflightBytes),
      createdAt: response.ended_at,
      disposition: measuredFailure ? "measured-failure" : "success",
      treatmentAdherent,
      operationalSuccess,
      failureKinds: metrics.outcome?.failureKinds ?? [],
      retryCount: 0
  };
  const evaluationPath = resolve(plan.artifactRoot, "evaluation.json");
  const evaluationBytes = jsonBytes(evaluation);
  writeOnce(evaluationPath, evaluationBytes);
  produced.push(...(snapshot ? [snapshotPath] : []), metricsPath, evaluationPath);
  const disposition = measuredFailure
   ? writeUnitDisposition(
       plan,
       "measured-failure",
       snapshotFailure ? `${failureReason}; evaluator snapshot unavailable: ${snapshotFailure}` : failureReason,
       modelPreflightPath,
       modelPreflightBytes,
       {
         evidenceKind: "model-failure",
         orderSourcePath: lifecyclePath,
         orderSourceBytes: lifecycleBytes,
         metricsPath,
         metricsBytes,
         evaluationPath,
         evaluationBytes
       }
     )
    : null;
  if (disposition) produced.push(disposition.dispositionPath);
  const provenance = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    evidence: "unsigned-descriptive-only",
    immutablePolicy: "write-once then read-only",
    sourcePin,
    atomicCommand: { command: options.cli, args: commandArgs },
    appProjectSessionId: null,
    cliSessionId: response.cli_session_id,
    terminalCommit: boundary.terminalCommit,
    candidateBoundarySha256: boundary.boundarySha256,
    files: produced.map((path) => {
      const bytes = readFileSync(path);
      return {
        path: relative(plan.artifactRoot, path).replaceAll("\\", "/"),
        bytes: bytes.length,
        sha256: sha256(bytes)
      };
    })
  };
  const provenancePath = resolve(plan.artifactRoot, "capture-provenance.json");
  writeOnce(provenancePath, jsonBytes(provenance));
  produced.push(provenancePath);
  for (const path of produced) immutable(path);
  return {
    status: measuredFailure ? "measured-failure" : "complete",
    plan,
    preflight,
    evidence,
    modelPreflight,
    evaluation,
    provenance,
    ...disposition
  };
  };
  try {
    return completeAiRun();
  } catch (error) {
    releaseReservationOnce();
    return {
      ...persistUncertain(
        plan,
        startIndex,
        lifecyclePath,
        lifecycleBytes,
        error instanceof Error ? error.message : String(error)
      ),
      preflight
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = Object.fromEntries([
    ["cli", "--cli"],
    ["sessionStore", "--session-store"],
    ["candidateRoot", "--candidate-root"],
    ["artifactRoot", "--artifact-root"],
    ["startIndexPath", "--start-index"],
    ["livePreflightPath", "--live-preflight"],
    ["blockId", "--block"],
    ["arm", "--arm"]
  ].map(([key, flag]) => [key, argument(args, flag)]));
  if (Object.values(required).some((value) => value === undefined)) {
    throw new Error("Usage: node scripts/run-controlled-harness.mjs --cli <copilot> --session-store <session-store.db> --candidate-root <external-empty-directory> --artifact-root <external-empty-directory> --start-index <external-index.json> --live-preflight <passing-live-preflight.json> --block <B01..B12> --arm <0..5> [--dry-run]");
  }
  const output = runControlledHarness({
    ...required,
    livePreflight: JSON.parse(readFileSync(resolve(required.livePreflightPath), "utf8")),
    armId: Number(required.arm),
    dryRun: args.includes("--dry-run")
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === "unavailable") process.exitCode = 2;
}
