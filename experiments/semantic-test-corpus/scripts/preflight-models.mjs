#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function evaluateModelBindings(evidence) {
  const cells = contract.arms.filter((arm) => arm.id !== 0).map((arm) => {
    const observed = evidence.cells?.find((cell) => cell.armId === arm.id);
    const reasons = [];
    if (!evidence.beforeOutcomeInspection) reasons.push("evidence was not frozen before outcome inspection");
    if (!observed) {
      reasons.push("missing platform binding evidence");
    } else {
      if (observed.requestedModel !== arm.model) reasons.push("requested model differs from preregistration");
      if (observed.observedModel !== arm.model) reasons.push("observed parent model does not match");
      if (observed.atomicBinding !== true) reasons.push("platform did not atomically bind the requested model");
      if (!observed.sessionId) reasons.push("fresh session ID is missing");
      if (!observed.evidence || observed.evidence.startsWith("<")) reasons.push("platform evidence locator is missing");
      if (arm.delegated) {
        if (!observed.workerSessionId) reasons.push("delegated worker session ID is missing");
        if (observed.workerObservedModel !== arm.workerModel) reasons.push("observed worker model does not match");
      }
    }
    return {
      armId: arm.id,
      requestedModel: arm.model,
      workerModel: arm.workerModel ?? null,
      status: reasons.length === 0 ? "available" : "unavailable",
      reasons
    };
  });
  return {
    checkedAt: evidence.capturedAt ?? null,
    checkedBeforeOutcomes: evidence.beforeOutcomeInspection === true,
    factorialAvailable: cells.every((cell) => cell.status === "available"),
    cells
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const evidencePath = argument(args, "--evidence");
  const outputPath = argument(args, "--out");
  if (!evidencePath || !outputPath) {
    throw new Error("Usage: node scripts/preflight-models.mjs --evidence <evidence.json> --out <availability.json>");
  }
  const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
  const result = evaluateModelBindings(evidence);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.factorialAvailable) process.exitCode = 2;
}
