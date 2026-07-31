#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBaseline } from "../baseline/generate.mjs";
import { validateStaging } from "../validators/staging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function runDeterministicBlock(blockId) {
  const planned = schedule.runs.find((run) => run.blockId === blockId && run.armId === 0);
  if (!planned) throw new Error(`No deterministic run is scheduled for ${blockId}`);
  const started = process.hrtime.bigint();
  const staging = generateBaseline({ blockId, seed: planned.seed });
  const errors = validateStaging(staging);
  if (errors.length > 0) throw new Error(`Deterministic staging is invalid: ${JSON.stringify(errors[0])}`);
  if (staging.cases.length !== 60) throw new Error(`${planned.runId} did not produce exactly 60 cases`);
  const bytes = Buffer.from(`${JSON.stringify(staging, null, 2)}\n`, "utf8");
  const wallMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return {
    planned,
    staging,
    bytes,
    execution: {
      formatVersion: 1,
      protocolId: schedule.protocolId,
      runId: planned.runId,
      blockId,
      armId: 0,
      seed: planned.seed,
      scheduleOrder: planned.order,
      cases: staging.cases.length,
      wallMs,
      stagingSha256: sha256(bytes)
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const blockId = argument(args, "--block");
  const outputRoot = argument(args, "--out");
  if (!blockId || !outputRoot) {
    throw new Error("Usage: node scripts/run-deterministic-block.mjs --block <B01..B12> --out <artifact-root>");
  }
  const result = runDeterministicBlock(blockId);
  const destination = resolve(outputRoot);
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, `${result.planned.runId}.json`), result.bytes, { flag: "wx" });
  writeFileSync(
    resolve(destination, `${result.planned.runId}.execution.json`),
    `${JSON.stringify(result.execution, null, 2)}\n`,
    { flag: "wx" }
  );
  process.stdout.write(`${result.planned.runId}: 60 deterministic cases - ${result.execution.stagingSha256}\n`);
}
