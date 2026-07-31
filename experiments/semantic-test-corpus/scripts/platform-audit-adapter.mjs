#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticateExport } from "./authenticated-export.mjs";
import { evaluateModelBindings } from "./preflight-models.mjs";
import { evaluateIsolationEvidence } from "./verify-isolation-evidence.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { verifyMetricsArtifact } from "../evaluator/statistics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const outputSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "platform-audit-adapter.schema.json"), "utf8")
);
const REQUIRED_SIGNED_EVENT_TYPES = [
  "run.started",
  "session.created",
  "model.bound",
  "sandbox.policy.applied",
  "tool.called",
  "tool.result",
  "fs.access",
  "audit.completed",
  "run.completed",
  "outcomes.unblinded",
  "adapter.snapshot",
  "metrics.computed"
];

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonLines(rawBytes) {
  return rawBytes.toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Captured Copilot JSONL line ${index + 1} is invalid`);
      }
    });
}

function observedSmoke(events) {
  const subagents = events.filter((event) => event.type === "subagent.started");
  const completed = events.filter((event) => event.type === "subagent.completed");
  const workerCallIds = new Set(subagents.map((event) => event.data?.toolCallId));
  const toolCalls = events
    .filter((event) =>
      event.type === "tool.execution_start"
      && event.data?.mcpServerName === "semantic-corpus"
      && typeof event.data?.mcpToolName === "string")
    .map((event) => {
      const actor = event.agentId || workerCallIds.has(event.data.parentToolCallId)
        ? "worker"
        : "parent";
      return {
        eventId: event.id,
        callId: event.data.toolCallId,
        rawToolName: event.data.toolName,
        mcpServerName: event.data.mcpServerName,
        mcpToolName: event.data.mcpToolName,
        contractToolName: `${event.data.mcpServerName}/${event.data.mcpToolName}`,
        actor,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.data.parentToolCallId
          ? { parentToolCallId: event.data.parentToolCallId }
          : {})
      };
    });
  const invocation = subagents.find((event) => event.data?.agentName === "semantic-test-corpus");
  const completion = completed.find((event) =>
    event.data?.toolCallId === invocation?.data?.toolCallId
    && event.data?.agentName === "semantic-test-corpus");
  return {
    models: [...new Set(events
      .map((event) => event.data?.model)
      .filter((model) => typeof model === "string"))].sort(),
    toolCalls,
    delegation: {
      invoked: Boolean(invocation),
      completed: Boolean(completion),
      agentName: invocation?.data?.agentName ?? null,
      callId: invocation?.data?.toolCallId ?? null
    }
  };
}

export function adaptPlatformAudit({
  rawBytes,
  cell,
  signatureBytes,
  publicKey,
  runRecord,
  evidenceContext
}) {
  if (!["inline", "delegated"].includes(cell)) {
    throw new Error("Audit adapter cell must be inline or delegated");
  }
  const requiredEventTypes = [
    ...REQUIRED_SIGNED_EVENT_TYPES,
    ...(cell === "delegated" ? ["delegation.invoked", "delegation.completed"] : [])
  ];
  let output;
  if (signatureBytes && publicKey) {
    const authenticated = authenticateExport(rawBytes, signatureBytes, publicKey);
    if (!runRecord?.runId || !evidenceContext) {
      throw new Error("Signed audit adaptation requires one run record and evidence context");
    }
    const runEvents = authenticated.payload.events.filter((event) =>
      event.runId === runRecord.runId);
    const present = new Set(runEvents.map((event) => event.type));
    const missingEvidence = requiredEventTypes.filter((type) => !present.has(type));
    const verificationFailures = [];
    const armDelegated = runRecord.armId === 2 || runRecord.armId === 4;
    if ((cell === "delegated") !== armDelegated) {
      verificationFailures.push("cell-does-not-match-run-arm");
    }
    try {
      const bindings = evaluateModelBindings(authenticated, [runRecord]);
      const binding = bindings.runs.find((run) => run.runId === runRecord.runId);
      if (binding?.status !== "available") {
        verificationFailures.push("model-binding-unavailable");
      }
    } catch (error) {
      verificationFailures.push(`model-binding:${error.message}`);
    }
    try {
      const isolation = evaluateIsolationEvidence(authenticated, {
        armId: runRecord.armId,
        runId: runRecord.runId,
        contractRoot: evidenceContext.contractRoot,
        stagingRoot: evidenceContext.stagingRoot,
        evaluatorRoot: evidenceContext.evaluatorRoot,
        snapshotPath: runRecord.staging.path
      });
      if (isolation.status !== "compliant" || isolation.budgets.met !== true) {
        verificationFailures.push("isolation-noncompliant");
      }
    } catch (error) {
      verificationFailures.push(`isolation:${error.message}`);
    }
    try {
      verifyMetricsArtifact({
        metricsPath: runRecord.metrics.path,
        runRecord,
        authenticated
      });
    } catch (error) {
      verificationFailures.push(`metrics:${error.message}`);
    }
    missingEvidence.push(...verificationFailures);
    const available = missingEvidence.length === 0;
    output = {
      formatVersion: 1,
      provider: "github-copilot-cli",
      cell,
      source: {
        format: "signed-platform-export",
        bytes: rawBytes.length,
        sha256: sha256(rawBytes)
      },
      status: available ? "available" : "unavailable",
      protocolCellAvailable: available,
      missingEvidence,
      observed: {
        models: [...new Set(runEvents
          .map((event) => event.modelId)
          .filter(Boolean))].sort(),
        toolCalls: runEvents
          .filter((event) => event.type === "tool.called"
            && event.toolName?.startsWith("semantic-corpus/"))
          .map((event) => ({
            eventId: event.eventId,
            callId: event.callId,
            rawToolName: event.toolName,
            mcpServerName: "semantic-corpus",
            mcpToolName: event.toolName.slice("semantic-corpus/".length),
            contractToolName: event.toolName,
            actor: event.actor
          })),
        delegation: {
          invoked: runEvents.some((event) =>
            event.type === "delegation.invoked"),
          completed: runEvents.some((event) =>
            event.type === "delegation.completed"),
          agentName: runEvents.find((event) =>
            event.type === "delegation.invoked")?.agentName ?? null,
          callId: runEvents.find((event) =>
            event.type === "delegation.invoked")?.callId ?? null
        }
      },
      normalizedExport: available ? authenticated.payload : null
    };
  } else {
    const events = parseJsonLines(rawBytes);
    output = {
      formatVersion: 1,
      provider: "github-copilot-cli",
      cell,
      source: {
        format: "copilot-jsonl",
        bytes: rawBytes.length,
        sha256: sha256(rawBytes)
      },
      status: "unavailable",
      protocolCellAvailable: false,
      missingEvidence: [
        "detached-ed25519-signature",
        ...requiredEventTypes
      ],
      observed: observedSmoke(events),
      normalizedExport: null
    };
  }
  const errors = validateJsonSchema(output, outputSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Audit adapter output is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const inputPath = argument(args, "--in");
  const cell = argument(args, "--cell");
  const outputPath = argument(args, "--out");
  if (!inputPath || !cell || !outputPath) {
    throw new Error("Usage: node scripts/platform-audit-adapter.mjs --in <capture.jsonl|export.json> --cell <inline|delegated> --out <audit.json> [--signature <sig> --public-key <pem> --run-record <record.json> --contract-root <path> --staging-root <path> --evaluator-root <path>]");
  }
  const signaturePath = argument(args, "--signature");
  const publicKeyPath = argument(args, "--public-key");
  if (Boolean(signaturePath) !== Boolean(publicKeyPath)) {
    throw new Error("--signature and --public-key must be supplied together");
  }
  const runRecordPath = argument(args, "--run-record");
  const contractRoot = argument(args, "--contract-root");
  const stagingRoot = argument(args, "--staging-root");
  const evaluatorRoot = argument(args, "--evaluator-root");
  if (signaturePath
    && (!runRecordPath || !contractRoot || !stagingRoot || !evaluatorRoot)) {
    throw new Error("Signed audit adaptation requires --run-record and all evidence roots");
  }
  const output = adaptPlatformAudit({
    rawBytes: readFileSync(resolve(inputPath)),
    cell,
    ...(signaturePath ? {
      signatureBytes: readFileSync(resolve(signaturePath)),
      publicKey: readFileSync(resolve(publicKeyPath)),
      runRecord: JSON.parse(readFileSync(resolve(runRecordPath), "utf8")),
      evidenceContext: { contractRoot, stagingRoot, evaluatorRoot }
    } : {})
  });
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    status: output.status,
    protocolCellAvailable: output.protocolCellAvailable,
    rawSha256: output.source.sha256,
    missingEvidence: output.missingEvidence
  })}\n`);
  if (!output.protocolCellAvailable) process.exitCode = 2;
}
