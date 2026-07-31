#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticateExport } from "./authenticated-export.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

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
  publicKey
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
    const present = new Set(authenticated.payload.events.map((event) => event.type));
    const missingEvidence = requiredEventTypes.filter((type) => !present.has(type));
    output = {
      formatVersion: 1,
      provider: "github-copilot-cli",
      cell,
      source: {
        format: "signed-platform-export",
        bytes: rawBytes.length,
        sha256: sha256(rawBytes)
      },
      status: missingEvidence.length === 0 ? "available" : "unavailable",
      protocolCellAvailable: missingEvidence.length === 0,
      missingEvidence,
      observed: {
        models: [...new Set(authenticated.payload.events
          .map((event) => event.modelId)
          .filter(Boolean))].sort(),
        toolCalls: authenticated.payload.events
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
          invoked: authenticated.payload.events.some((event) =>
            event.type === "delegation.invoked"),
          completed: authenticated.payload.events.some((event) =>
            event.type === "delegation.completed"),
          agentName: authenticated.payload.events.find((event) =>
            event.type === "delegation.invoked")?.agentName ?? null,
          callId: authenticated.payload.events.find((event) =>
            event.type === "delegation.invoked")?.callId ?? null
        }
      },
      normalizedExport: missingEvidence.length === 0 ? authenticated.payload : null
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
    throw new Error("Usage: node scripts/platform-audit-adapter.mjs --in <capture.jsonl|export.json> --cell <inline|delegated> --out <audit.json> [--signature <sig> --public-key <pem>]");
  }
  const signaturePath = argument(args, "--signature");
  const publicKeyPath = argument(args, "--public-key");
  if (Boolean(signaturePath) !== Boolean(publicKeyPath)) {
    throw new Error("--signature and --public-key must be supplied together");
  }
  const output = adaptPlatformAudit({
    rawBytes: readFileSync(resolve(inputPath)),
    cell,
    ...(signaturePath ? {
      signatureBytes: readFileSync(resolve(signaturePath)),
      publicKey: readFileSync(resolve(publicKeyPath))
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
