#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "./authenticated-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const evidenceContract = JSON.parse(readFileSync(resolve(root, "design", "platform-evidence-contract.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function eventsFor(payload, runId, role, type) {
  return payload.events.filter((event) =>
    event.runId === runId && event.role === role && event.type === type);
}

function sameEvidence(reference, exportId, authentication) {
  return reference?.exportId === exportId
    && reference?.payloadSha256 === authentication.payloadSha256
    && reference?.signatureSha256 === authentication.signatureSha256
    && reference?.publicKeySha256 === authentication.publicKeySha256;
}

function sameRoleReference(reference, role, creation, binding) {
  return reference?.role === role
    && reference?.sessionId === creation.sessionId
    && reference?.sessionCreatedEventId === creation.eventId
    && reference?.modelBoundEventId === binding.eventId;
}

export function evaluateModelBindings(authenticated, runRecords) {
  const { payload, authentication } = authenticated;
  const capturedAt = Date.parse(payload.capturedAt);
  const records = Array.isArray(runRecords) ? runRecords : runRecords?.runs;
  if (!Array.isArray(records)) throw new Error("run records are required for per-run model binding");
  const recordIds = new Set();
  const duplicateRecordIds = new Set();
  for (const record of records) {
    if (recordIds.has(record.runId)) duplicateRecordIds.add(record.runId);
    recordIds.add(record.runId);
  }
  const globallyUsedSessions = new Map();
  const runs = [];

  for (const planned of schedule.runs.filter((run) => run.armId !== 0)) {
    const arm = contract.arms.find((item) => item.id === planned.armId);
    const reasons = [];
    const matchingRecords = records.filter((record) => record.runId === planned.runId);
    const record = matchingRecords[0];
    if (matchingRecords.length !== 1) {
      reasons.push(`requires exactly one run record; found ${matchingRecords.length}`);
    }
    if (duplicateRecordIds.has(planned.runId)) reasons.push("run ID is reused in run records");
    if (record && (record.blockId !== planned.blockId || record.armId !== planned.armId)) {
      reasons.push("run record block/arm differs from frozen schedule");
    }
    if (record && !sameEvidence(record.modelEvidence, payload.exportId, authentication)) {
      reasons.push("run record does not bind the exact authenticated raw export");
    }

    const requiredRoles = arm.delegated ? ["parent", "worker"] : ["parent"];
    const runCreations = payload.events.filter((event) =>
      event.runId === planned.runId && event.type === "session.created");
    const runBindings = payload.events.filter((event) =>
      event.runId === planned.runId && event.type === "model.bound");
    if (runCreations.length !== requiredRoles.length) {
      reasons.push(`run requires exactly ${requiredRoles.length} signed session.created event(s)`);
    }
    if (runBindings.length !== requiredRoles.length) {
      reasons.push(`run requires exactly ${requiredRoles.length} signed model.bound event(s)`);
    }
    for (const event of [...runCreations, ...runBindings]) {
      if (!requiredRoles.includes(event.role)) {
        reasons.push(`unexpected signed role ${event.role ?? "<missing>"} in ${event.eventId}`);
      }
    }
    const starts = payload.events.filter((event) =>
      event.type === "run.started" && event.runId === planned.runId);
    if (starts.length !== 1) reasons.push(`requires exactly one signed run.started event; found ${starts.length}`);
    const start = starts[0];
    if (start && (start.blockId !== planned.blockId || start.armId !== planned.armId || start.role !== "parent")) {
      reasons.push("signed run.started mapping differs from the frozen schedule");
    }
    const startedAt = start ? Date.parse(start.timestamp) : Number.NaN;
    if (start && startedAt > capturedAt) reasons.push("run start occurs after the export capture boundary");

    const roles = [];
    for (const role of requiredRoles) {
      const created = eventsFor(payload, planned.runId, role, "session.created");
      const bound = eventsFor(payload, planned.runId, role, "model.bound");
      if (created.length !== 1) reasons.push(`${role} requires exactly one signed session.created event`);
      if (bound.length !== 1) reasons.push(`${role} requires exactly one signed model.bound event`);
      if (created.length !== 1 || bound.length !== 1) continue;

      const creation = created[0];
      const binding = bound[0];
      const expectedModel = role === "worker" ? arm.workerModel : arm.model;
      const expectedParent = roles.find((item) => item.role === "parent")?.sessionId;
      for (const event of [creation, binding]) {
        if (event.blockId !== planned.blockId || event.armId !== planned.armId) {
          reasons.push(`${role} signed event mapping differs from the frozen schedule`);
        }
      }
      if (creation.sessionId !== binding.sessionId) reasons.push(`${role} binding session does not match creation`);
      const firstUse = globallyUsedSessions.get(creation.sessionId);
      if (firstUse) {
        reasons.push(`session ${creation.sessionId} is reused from ${firstUse}`);
      } else {
        globallyUsedSessions.set(creation.sessionId, `${planned.runId}/${role}`);
      }
      const createdAt = Date.parse(creation.timestamp);
      const boundAt = Date.parse(binding.timestamp);
      if (!Number.isFinite(startedAt) || createdAt > startedAt || boundAt > startedAt) {
        reasons.push(`${role} creation/binding was not completed before the measured run`);
      }
      if (Number.isFinite(startedAt)
        && startedAt - createdAt > evidenceContract.maxPreflightSessionAgeSeconds * 1000) {
        reasons.push(`${role} session creation is too old to be fresh for this run`);
      }
      if (boundAt < createdAt) reasons.push(`${role} binding predates session creation`);
      if (binding.modelId !== expectedModel) {
        reasons.push(`${role} observed model ${binding.modelId ?? "<missing>"} does not match ${expectedModel}`);
      }
      if (binding.atomic !== true) reasons.push(`${role} model binding is not atomic`);
      if (role === "worker" && creation.parentSessionId !== expectedParent) {
        reasons.push("worker parentSessionId does not match the authenticated parent session");
      }
      const reference = record?.modelEvidence?.roles?.find((item) => item.role === role);
      if (!sameRoleReference(reference, role, creation, binding)) {
        reasons.push(`${role} run record does not bind exact signed event/session IDs`);
      }
      roles.push({
        role,
        sessionId: creation.sessionId,
        sessionCreatedEventId: creation.eventId,
        modelBoundEventId: binding.eventId,
        observedModel: binding.modelId ?? null
      });
    }
    if (record?.modelEvidence?.roles?.length !== requiredRoles.length) {
      reasons.push("run record role evidence count does not match the arm contract");
    }
    const parentRole = roles.find((item) => item.role === "parent");
    if (start && start.sessionId !== parentRole?.sessionId) {
      reasons.push("signed run.started event does not use the authenticated parent session");
    }

    const status = reasons.length === 0 ? "available" : "unavailable";
    runs.push({
      runId: planned.runId,
      blockId: planned.blockId,
      armId: planned.armId,
      requestedModel: arm.model,
      requestedWorkerModel: arm.workerModel ?? null,
      status,
      roles,
      reasons
    });
  }

  const availableRuns = runs.filter((run) => run.status === "available").length;
  return {
    exportId: payload.exportId,
    capturedAt: payload.capturedAt,
    evidence: authentication,
    plannedRuns: runs.length,
    availableRuns,
    allRunsAvailable: availableRuns === runs.length,
    runs
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const payloadPath = argument(args, "--payload");
  const signaturePath = argument(args, "--signature");
  const publicKeyPath = argument(args, "--public-key");
  const runsPath = argument(args, "--runs");
  const outputPath = argument(args, "--out");
  if (!payloadPath || !signaturePath || !publicKeyPath || !runsPath || !outputPath) {
    throw new Error("Usage: node scripts/preflight-models.mjs --payload <export.json> --signature <export.sig> --public-key <platform.pem> --runs <run-records.json> --out <availability.json>");
  }
  const authenticated = readAuthenticatedExport({ payloadPath, signaturePath, publicKeyPath });
  const runRecords = JSON.parse(readFileSync(resolve(runsPath), "utf8"));
  const result = evaluateModelBindings(authenticated, runRecords);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    plannedRuns: result.plannedRuns,
    availableRuns: result.availableRuns,
    allRunsAvailable: result.allRunsAvailable
  })}\n`);
  if (!result.allRunsAvailable) process.exitCode = 2;
}
