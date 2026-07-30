#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "./authenticated-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const evidenceContract = JSON.parse(readFileSync(resolve(root, "design", "platform-evidence-contract.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function eventsFor(payload, armId, role, type) {
  return payload.events.filter((event) =>
    event.armId === armId && event.role === role && event.type === type);
}

export function evaluateModelBindings(authenticated) {
  const { payload, authentication } = authenticated;
  const capturedAt = Date.parse(payload.capturedAt);
  const cells = [];
  const globallyUsedSessions = new Set();

  for (const arm of contract.arms.filter((item) => item.id !== 0)) {
    const reasons = [];
    const requiredRoles = arm.delegated ? ["parent", "worker"] : ["parent"];
    const armCreations = payload.events.filter((event) =>
      event.armId === arm.id && event.type === "session.created");
    const armBindings = payload.events.filter((event) =>
      event.armId === arm.id && event.type === "model.bound");
    if (armCreations.length !== requiredRoles.length) {
      reasons.push(`cell requires exactly ${requiredRoles.length} signed session.created event(s)`);
    }
    if (armBindings.length !== requiredRoles.length) {
      reasons.push(`cell requires exactly ${requiredRoles.length} signed model.bound event(s)`);
    }
    for (const event of [...armCreations, ...armBindings]) {
      if (!requiredRoles.includes(event.role)) reasons.push(`unexpected ${event.role ?? "<missing>"} role in ${event.eventId}`);
    }
    const sessions = {};
    for (const role of requiredRoles) {
      const created = eventsFor(payload, arm.id, role, "session.created");
      const bound = eventsFor(payload, arm.id, role, "model.bound");
      if (created.length !== 1) reasons.push(`${role} requires exactly one signed session.created event`);
      if (bound.length !== 1) reasons.push(`${role} requires exactly one signed model.bound event`);
      if (created.length !== 1 || bound.length !== 1) continue;

      const creation = created[0];
      const binding = bound[0];
      sessions[role] = creation.sessionId;
      if (creation.sessionId !== binding.sessionId) reasons.push(`${role} binding session does not match creation`);
      if (globallyUsedSessions.has(creation.sessionId)) reasons.push(`session ${creation.sessionId} is reused across cells`);
      globallyUsedSessions.add(creation.sessionId);
      if (Date.parse(creation.timestamp) > capturedAt || Date.parse(binding.timestamp) > capturedAt) {
        reasons.push(`${role} creation/binding was not captured before the preflight boundary`);
      }
      if (capturedAt - Date.parse(creation.timestamp) > evidenceContract.maxPreflightSessionAgeSeconds * 1000) {
        reasons.push(`${role} session creation is too old to be a fresh preflight session`);
      }
      if (Date.parse(binding.timestamp) < Date.parse(creation.timestamp)) {
        reasons.push(`${role} binding predates session creation`);
      }
      const expectedModel = role === "worker" ? arm.workerModel : arm.model;
      if (binding.modelId !== expectedModel) reasons.push(`${role} observed model ${binding.modelId ?? "<missing>"} does not match ${expectedModel}`);
      if (binding.atomic !== true) reasons.push(`${role} model binding is not atomic`);
      if (role === "worker" && creation.parentSessionId !== sessions.parent) {
        reasons.push("worker parentSessionId does not match the signed parent session");
      }
    }

    const sessionIds = new Set(Object.values(sessions));
    const earlyOutcomes = payload.events.filter((event) =>
      event.type === "outcome.accessed"
      && sessionIds.has(event.sessionId)
      && Date.parse(event.timestamp) <= capturedAt);
    if (earlyOutcomes.length > 0) reasons.push("outcome access occurred before availability was frozen");

    cells.push({
      armId: arm.id,
      requestedModel: arm.model,
      requestedWorkerModel: arm.workerModel ?? null,
      status: reasons.length === 0 ? "available" : "unavailable",
      sessionIds: Object.values(sessions),
      reasons
    });
  }

  return {
    exportId: payload.exportId,
    capturedAt: payload.capturedAt,
    evidence: authentication,
    factorialAvailable: cells.every((cell) => cell.status === "available"),
    cells
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const payloadPath = argument(args, "--payload");
  const signaturePath = argument(args, "--signature");
  const publicKeyPath = argument(args, "--public-key");
  const outputPath = argument(args, "--out");
  if (!payloadPath || !signaturePath || !publicKeyPath || !outputPath) {
    throw new Error("Usage: node scripts/preflight-models.mjs --payload <export.json> --signature <export.sig> --public-key <platform.pem> --out <availability.json>");
  }
  const authenticated = readAuthenticatedExport({ payloadPath, signaturePath, publicKeyPath });
  const result = evaluateModelBindings(authenticated);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.factorialAvailable) process.exitCode = 2;
}
