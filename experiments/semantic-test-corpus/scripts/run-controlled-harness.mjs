#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
import { preflightLocalModel } from "./preflight-local-model.mjs";
import { preflightExecution } from "./preflight-execution.mjs";
import { validateStartOrder } from "./validate-start-order.mjs";
import { runDeterministicBlock } from "./run-deterministic-block.mjs";
import { snapshotLocalCorpusStaging } from "../evaluator/adapter.mjs";
import { canonicalMetricsBytes, deriveMetricsArtifact } from "../evaluator/metrics.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const sourcePin = JSON.parse(readFileSync(resolve(root, "design", "source-pin.json"), "utf8"));
const preSessionFailureSchema = JSON.parse(
  readFileSync(resolve(root, "schemas", "pre-session-failure.schema.json"), "utf8")
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

function createSandbox(candidateRoot) {
  const runtimeRoot = resolve(candidateRoot, ".benchmark-runtime");
  const stagingRoot = resolve(runtimeRoot, "corpus-staging");
  const configPath = resolve(runtimeRoot, "corpus-sandbox.json");
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
      contract: { path: contractRoot, identity: identity(contractRoot) },
      staging: { path: stagingRoot, identity: identity(stagingRoot) }
    },
    lock: { waitTimeoutMs: 5000, staleAfterMs: 60000 }
  };
  writeOnce(configPath, jsonBytes(config));
  for (const file of readdirSync(contractRoot)) {
    chmodSync(resolve(contractRoot, file), 0o444);
  }
  chmodSync(configPath, 0o444);
  const excludePath = resolve(candidateRoot, ".git", "info", "exclude");
  writeFileSync(excludePath, "\n.benchmark-runtime/\n", { flag: "a" });
  return { runtimeRoot, stagingRoot, configPath, contractRoot, token, config };
}

function nextStart(indexPath, planned) {
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : {
        formatVersion: 1,
        protocolId: "semantic-test-corpus-execution-v2",
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
  writeFileSync(pending, jsonBytes(next), { flag: "wx" });
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

function writeUnitDisposition(plan, status, reason, sourcePath, sourceBytes, {
  evidenceKind,
  orderSourcePath = sourcePath,
  orderSourceBytes = sourceBytes
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
    orderSourceSha256: sha256(orderSourceBytes)
  };
  const dispositionPath = resolve(plan.artifactRoot, "unit-disposition.json");
  writeOnce(dispositionPath, jsonBytes(disposition));
  immutable(dispositionPath);
  return { disposition, dispositionPath };
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
  const filesBeforeRecord = readdirSync(plan.artifactRoot)
    .map((name) => resolve(plan.artifactRoot, name))
    .filter((path) => statSync(path).isFile());
  const uncertainty = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    runId: plan.runId,
    blockId: plan.blockId,
    armId: plan.armId,
    status: "started-uncertain",
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
  const uncertaintyBytes = jsonBytes(uncertainty);
  if (!existsSync(uncertaintyPath)) writeOnce(uncertaintyPath, uncertaintyBytes);
  const disposition = existsSync(resolve(plan.artifactRoot, "unit-disposition.json"))
    ? null
    : writeUnitDisposition(
      plan, "unavailable", reason, uncertaintyPath, uncertaintyBytes, {
        evidenceKind: "started-uncertain",
        orderSourcePath: lifecyclePath,
        orderSourceBytes: lifecycleBytes
      }
    );
  for (const path of [...filesBeforeRecord, uncertaintyPath]) immutable(path);
  return {
    status: "started-uncertain",
    plan,
    uncertainty,
    uncertaintyPath,
    ...disposition
  };
}

export function buildHarnessPlan({
  cli,
  projectId,
  candidateRoot,
  artifactRoot,
  startIndexPath,
  blockId,
  armId
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
  const kickoffPath = resolve(artifactRoot, "kickoff.txt");
  const args = armId === 0 ? [] : [
    "create-session",
    "--project-id", projectId,
    "--execution-location", "local",
    "--mode", "autopilot",
    "--model", arm.model,
    "--prompt-file", kickoffPath,
    "--prompt-sha256", planned.kickoffSha256,
    "--task-file", resolve(candidateRoot, contract.commonContract.taskArtifact),
    "--run-id", planned.runId,
    "--global-order", String(planned.globalOrder),
    "--candidate-commit", "<materialized-terminal-commit>",
    "--sandbox-config", resolve(candidateRoot, ".benchmark-runtime", "corpus-sandbox.json"),
    "--events-out", resolve(artifactRoot, "captured.events.jsonl"),
    "--usage-out", resolve(artifactRoot, "captured.usage.json")
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
    sourcePin,
    candidateRoot: resolve(candidateRoot),
    artifactRoot: resolve(artifactRoot),
    startIndexPath: resolve(startIndexPath),
    atomicCommand: { command: cli, args }
  };
}

export function runControlledHarness(options) {
  const plan = buildHarnessPlan(options);
  const planned = schedule.runs.find((run) => run.runId === plan.runId);
  const arm = contract.arms.find((item) => item.id === plan.armId);
  const preflight = preflightExecution(options.cli, options.capturedAt);
  const armPreflight = preflight.arms.find((item) => item.armId === plan.armId);
  if (options.dryRun) return { status: "dry-run", plan, preflight };
  if (existsSync(plan.artifactRoot) && readdirSync(plan.artifactRoot).length > 0) {
    throw new Error("Artifact root must be absent or empty");
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
    const recordedAt = nextRecordedAt(startIndex);
    const unavailable = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      runId: plan.runId,
      blockId: plan.blockId,
      armId: plan.armId,
      seed: plan.seed,
      scheduleOrder: plan.scheduleOrder,
      globalOrder: plan.globalOrder,
      disposition: "unavailable",
      recordedAt,
      startedAt: null,
      preflightSha256: sha256(preflightBytes),
      reasons: armPreflight.reasons
    };
    const unavailablePath = resolve(plan.artifactRoot, "order-record.json");
    const unavailableBytes = jsonBytes(unavailable);
    writeOnce(unavailablePath, unavailableBytes);
    immutable(unavailablePath);
    const disposition = writeUnitDisposition(
      plan,
      "unavailable",
      armPreflight.reasons.join("; "),
      unavailablePath,
      unavailableBytes,
      { evidenceKind: "preflight-unavailable" }
    );
    const stored = storeStart(
      plan.startIndexPath,
      startIndex,
      orderCapture(plan, unavailablePath, unavailableBytes, "unavailable", recordedAt)
    );
    releaseReservationOnce();
    return {
      status: "unavailable",
      plan,
      preflight,
      reasons: armPreflight.reasons,
      orderRecord: unavailable,
      ...disposition,
      startFinalization: stored.finalization
    };
  }
  const preSessionFailures = [];
  if (options.preSessionFailurePath) {
    try {
    const sourcePath = resolve(options.preSessionFailurePath);
    const sourceBytes = readFileSync(sourcePath);
    const record = JSON.parse(sourceBytes);
    const errors = validateJsonSchema(record, preSessionFailureSchema, {
      schemaDir: resolve(root, "schemas")
    });
    const receiptPath = errors.length === 0
      ? resolve(dirname(sourcePath), record.receipt.path)
      : null;
    const receiptBytes = receiptPath && existsSync(receiptPath)
      ? readFileSync(receiptPath)
      : null;
    let receipt = null;
    try {
      receipt = receiptBytes ? JSON.parse(receiptBytes) : null;
    } catch {
      receipt = null;
    }
    if (errors.length > 0
      || record.runId !== plan.runId
      || record.kickoffStarted !== false
      || record.sessionCreated !== false
      || !receiptBytes
      || sha256(receiptBytes) !== record.receipt.sha256
      || receipt?.receiptKind !== record.receipt.receiptKind
      || receipt?.receiptId !== record.receipt.receiptId
      || receipt?.kickoffStarted !== false
      || receipt?.sessionCreated !== false
      || JSON.stringify(receipt?.usage) !== JSON.stringify(record.usage)) {
      releaseReservationOnce();
      throw new Error("Prior pre-session failure is invalid or belongs to another run");
    }
    const target = resolve(plan.artifactRoot, `${record.failureId}.json`);
    const targetReceipt = resolve(plan.artifactRoot, record.receipt.path);
    writeOnce(target, sourceBytes);
    writeOnce(targetReceipt, receiptBytes);
    immutable(target);
    immutable(targetReceipt);
    preSessionFailures.push({
      path: target,
      bytes: sourceBytes,
      record,
      receiptPath: targetReceipt,
      receiptBytes
    });
    } catch (error) {
      releaseReservationOnce();
      throw error;
    }
  }
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
      createdAt: new Date().toISOString()
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
  try {
    boundary = materializeCandidate(plan.candidateRoot, { blockId: plan.blockId });
    sandbox = createSandbox(plan.candidateRoot);
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
      state: "atomic-kickoff-planned",
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
    releaseReservationOnce();
    if (lifecyclePath && lifecycleBytes && existsSync(lifecyclePath)) {
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
  const recordedAt = JSON.parse(lifecycleBytes.toString("utf8")).recordedAt;
  const plannedStartCapture = orderCapture(
    plan, lifecyclePath, lifecycleBytes, "started", recordedAt
  );
  const commandArgs = plan.atomicCommand.args.map((item) =>
    item === "<materialized-terminal-commit>" ? boundary.terminalCommit : item);
  const [executable, ...prefix] = commandParts(options.cli);
  const completeAiRun = () => {
  const execution = spawnSync(executable, [...prefix, ...commandArgs], {
    cwd: plan.candidateRoot,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SEMANTIC_CORPUS_SANDBOX_CONFIG: sandbox.configPath,
      SEMANTIC_CORPUS_SANDBOX_TOKEN: sandbox.token
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: contract.commonContract.wallClockMinutes * 60_000,
    killSignal: "SIGTERM"
  });
  const stdoutPath = resolve(plan.artifactRoot, "process-stdout.txt");
  const stderrPath = resolve(plan.artifactRoot, "process-stderr.txt");
  writeOnce(stdoutPath, Buffer.from(execution.stdout ?? "", "utf8"));
  writeOnce(stderrPath, Buffer.from(execution.stderr ?? "", "utf8"));
  if (execution.error && execution.status === null) throw execution.error;
  if (execution.status !== 0) {
    if (existsSync(eventsPath) || existsSync(usagePath)) {
      throw new Error("Failed create-session emitted run evidence after the durable kickoff marker");
    }
    let receipt;
    try {
      receipt = JSON.parse(execution.stdout);
    } catch {
      throw new Error("Create-session failure lacks an authoritative failure receipt");
    }
    if (!preflight.capabilities.preSessionFailureReceipt
      || !preflight.capabilities.zeroUsageReceipt
      || receipt.receiptKind !== "authoritative-pre-session-failure"
      || receipt.kickoffStarted !== false
      || receipt.sessionCreated !== false
      || JSON.stringify(receipt.usage) !== JSON.stringify({
        aiCredits: 0,
        premiumRequests: null,
        nanoAiu: 0,
        modelTokens: 0,
        completionCount: 0
      })) {
      throw new Error("Create-session failure receipt does not prove pre-kickoff zero usage");
    }
    const receiptBytes = Buffer.from(execution.stdout, "utf8");
    const receiptName = `${plan.runId}-pre-session-${preSessionFailures.length + 1}.receipt.json`;
    const receiptPath = resolve(plan.artifactRoot, receiptName);
    writeOnce(receiptPath, receiptBytes);
    const failure = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      failureId: `${plan.runId}-pre-session-${preSessionFailures.length + 1}`,
      runId: plan.runId,
      attemptedAt: new Date().toISOString(),
      phase: "create_session",
      kickoffStarted: false,
      sessionCreated: false,
      reason: execution.stderr.trim() || `create-session exited ${execution.status}`,
      receipt: {
        receiptKind: receipt.receiptKind,
        receiptId: receipt.receiptId,
        path: receiptName,
        sha256: sha256(receiptBytes)
      },
      usage: receipt.usage
    };
    const failurePath = resolve(plan.artifactRoot, `${failure.failureId}.json`);
    writeOnce(failurePath, jsonBytes(failure));
    for (const path of [stdoutPath, stderrPath, receiptPath, failurePath]) immutable(path);
    if (preSessionFailures.length > 0) {
      const unavailableRecordedAt = nextRecordedAt(startIndex);
      const unavailable = {
        formatVersion: 1,
        protocolId: contract.protocolId,
        runId: plan.runId,
        blockId: plan.blockId,
        armId: plan.armId,
        disposition: "unavailable",
        recordedAt: unavailableRecordedAt,
        startedAt: null,
        reason: "single positive pre-session retry was exhausted",
        failures: [...preSessionFailures.map((item) => basename(item.path)), basename(failurePath)]
      };
      const unavailablePath = resolve(plan.artifactRoot, "order-record.json");
      const unavailableBytes = jsonBytes(unavailable);
      writeOnce(unavailablePath, unavailableBytes);
      immutable(unavailablePath);
      const retryDisposition = writeUnitDisposition(
        plan,
        "unavailable",
        unavailable.reason,
        unavailablePath,
        unavailableBytes,
        { evidenceKind: "retry-exhausted" }
      );
      const stored = storeStart(
        plan.startIndexPath,
        startIndex,
        orderCapture(
          plan, unavailablePath, unavailableBytes, "unavailable", unavailableRecordedAt
        )
      );
      releaseReservationOnce();
      return {
        status: "unavailable",
        plan,
        preflight,
        failure,
        orderRecord: unavailable,
        ...retryDisposition,
        startFinalization: stored.finalization
      };
    }
    releaseReservationOnce();
    return {
      status: "pre-session-failure",
      plan,
      preflight,
      failure,
      failurePath
    };
  }
  const response = JSON.parse(execution.stdout);
  const eventsBytes = readFileSync(eventsPath);
  const events = eventsBytes.toString("utf8").trim().split(/\r?\n/u).map(JSON.parse);
  const sessionStart = events.find((event) => event.type === "session.start");
  if (!sessionStart || response.cli_session_id !== sessionStart.data?.sessionId) {
    throw new Error("CLI response and captured session.start ID differ");
  }
  const capturePath = resolve(plan.artifactRoot, "start-capture.json");
  writeOnce(capturePath, jsonBytes(plannedStartCapture));
  const startStored = storeStart(plan.startIndexPath, startIndex, plannedStartCapture);
  releaseReservationOnce();

  const boundaryPath = resolve(plan.artifactRoot, "candidate-boundary.json");
  const boundaryBytes = readFileSync(resolve(plan.candidateRoot, ".benchmark-boundary.json"));
  writeOnce(boundaryPath, boundaryBytes);
  const sessionCreation = {
    formatVersion: 1,
    operation: "create_session",
    capturedAt: response.started_at,
    request: {
      project_id: options.projectId,
      execution_location: "local",
      coordinate_with_creator: false,
      candidate_commit: boundary.terminalCommit,
      kickoff: {
        mode: "autopilot",
        model: arm.model,
        prompt: kickoffBytes.toString("utf8"),
        agent: null,
        context_tier: "default",
        reasoning_effort: "medium"
      }
    },
    response: {
      project_session_id: response.project_session_id,
      project_id: response.project_id,
      execution_location: response.execution_location,
      kickoff_mode: response.kickoff_mode,
      kickoff_model: response.kickoff_model,
      kickoff_consumed: response.kickoff_consumed === true,
      kickoff_prompt_sha256: response.prompt_sha256_echo
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
    appProjectSessionId: response.project_session_id,
    cliSessionId: response.cli_session_id,
    requestedParentModel: arm.model,
    requestedWorkerModel: arm.workerModel ?? null,
    status: "completed",
    startedAt: response.started_at,
    endedAt: response.ended_at,
    terminalReturn: response.terminal_return,
    localEvidencePath: "local-evidence.json",
    modelPreflightPath: "model-preflight.json",
    treatment: {
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
    },
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
    appProjectSessionId: response.project_session_id,
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
  const usageBytes = readFileSync(usagePath);
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
    attempt.status = "excluded";
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
    preflightPath, kickoffPath, lifecyclePath, stdoutPath, stderrPath,
    eventsPath, usagePath, capturePath, boundaryPath,
    sessionCreationPath, attemptPath, manifestPath, evidencePath, modelPreflightPath,
    ...(startStored.finalization
      ? [startStored.finalization.indexPath, startStored.finalization.shaPath]
      : [])
  ];
  const disposition = modelPreflight.status === "pass"
    ? null
    : writeUnitDisposition(
      plan,
      "excluded",
      modelPreflight.reasons.join("; ") || "local model/mechanism preflight failed",
      modelPreflightPath,
      modelPreflightBytes,
      {
        evidenceKind: "model-excluded",
        orderSourcePath: lifecyclePath,
        orderSourceBytes: lifecycleBytes
      }
    );
  if (disposition) produced.push(disposition.dispositionPath);
  let evaluation = null;
  if (modelPreflight.status === "pass") {
    const snapshotPath = resolve(plan.artifactRoot, "staging.json");
    const snapshot = snapshotLocalCorpusStaging({
      corpusContractRoot: sandbox.contractRoot,
      corpusStagingRoot: sandbox.stagingRoot,
      localEvidence: evidence,
      localEvidenceBytes: evidenceBytes,
      modelPreflight,
      sourceArtifactRoot: plan.artifactRoot,
      sourceCandidateRoot: plan.candidateRoot,
      outputPath: snapshotPath
    });
    const metricsPath = resolve(plan.artifactRoot, "metrics.json");
    const metrics = deriveMetricsArtifact(snapshot.bytes, {
      runId: plan.runId,
      blockId: plan.blockId,
      armId: plan.armId
    });
    const metricsBytes = canonicalMetricsBytes(metrics);
    writeOnce(metricsPath, metricsBytes);
    evaluation = {
      formatVersion: 1,
      protocolId: contract.protocolId,
      runId: plan.runId,
      blockId: plan.blockId,
      armId: plan.armId,
      attemptId: attempt.attemptId,
      snapshotPath,
      snapshotSha256: sha256(snapshot.bytes),
      metricsPath,
      metricsSha256: sha256(metricsBytes),
      executionSha256: null,
      localEvidenceSha256: sha256(evidenceBytes),
      modelPreflightSha256: sha256(modelPreflightBytes),
      createdAt: response.ended_at
    };
    const evaluationPath = resolve(plan.artifactRoot, "evaluation.json");
    writeOnce(evaluationPath, jsonBytes(evaluation));
    produced.push(snapshotPath, metricsPath, evaluationPath);
  }
  const provenance = {
    formatVersion: 1,
    protocolId: contract.protocolId,
    evidence: "unsigned-descriptive-only",
    immutablePolicy: "write-once then read-only",
    sourcePin,
    atomicCommand: { command: options.cli, args: commandArgs },
    appProjectSessionId: response.project_session_id,
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
    status: modelPreflight.status === "pass" ? "complete" : "unavailable",
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
    ["projectId", "--project-id"],
    ["candidateRoot", "--candidate-root"],
    ["artifactRoot", "--artifact-root"],
    ["startIndexPath", "--start-index"],
    ["blockId", "--block"],
    ["arm", "--arm"]
  ].map(([key, flag]) => [key, argument(args, flag)]));
  if (Object.values(required).some((value) => value === undefined)) {
    throw new Error("Usage: node scripts/run-controlled-harness.mjs --cli <adapter> --project-id <id> --candidate-root <external-empty-directory> --artifact-root <external-empty-directory> --start-index <external-index.json> --block <B01..B12> --arm <0..5> [--pre-session-failure <record.json>] [--dry-run]");
  }
  const output = runControlledHarness({
    ...required,
    armId: Number(required.arm),
    preSessionFailurePath: argument(args, "--pre-session-failure"),
    dryRun: args.includes("--dry-run")
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === "unavailable") process.exitCode = 2;
}
