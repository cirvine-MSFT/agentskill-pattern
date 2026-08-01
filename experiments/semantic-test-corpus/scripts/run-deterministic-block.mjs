#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERAL_GENERATOR_DEPENDENCIES,
  generateGeneralBaseline
} from "../baseline/general-generate.mjs";
import { validateStaging } from "../validators/staging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const sourcePin = JSON.parse(readFileSync(resolve(root, "design", "source-pin.json"), "utf8"));
const repositoryRoot = resolve(root, "..", "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyPinnedGenerator() {
  const tree = spawnSync("git", ["rev-parse", `${sourcePin.generatorCommit}^{tree}`], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (tree.status !== 0 || tree.stdout.trim() !== sourcePin.generatorTree) {
    throw new Error("Arm 0 generator commit/tree pin is unavailable");
  }
  for (const path of GENERAL_GENERATOR_DEPENDENCIES) {
    const absolute = resolve(root, path);
    const repositoryPath = relative(repositoryRoot, absolute).replaceAll("\\", "/");
    const pinnedBlob = sourcePin.generatorBlobs[repositoryPath];
    const observed = spawnSync("git", [
      "rev-parse", `${sourcePin.generatorCommit}:${repositoryPath}`
    ], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    if (observed.status !== 0
      || observed.stdout.trim() !== pinnedBlob
      || sha256(readFileSync(absolute))
        !== sha256(spawnSync("git", ["cat-file", "blob", pinnedBlob], {
          cwd: repositoryRoot,
          encoding: null
        }).stdout)) {
      throw new Error(`Arm 0 dependency differs from pinned blob: ${path}`);
    }
  }
}

export function runDeterministicBlock(blockId, { startEvidence = null } = {}) {
  verifyPinnedGenerator();
  const planned = schedule.runs.find((run) => run.blockId === blockId && run.armId === 0);
  if (!planned) throw new Error(`No deterministic run is scheduled for ${blockId}`);
  const start = startEvidence ?? {
    formatVersion: 1,
    protocolId: schedule.protocolId,
    runId: planned.runId,
    blockId,
    armId: 0,
    seed: planned.seed,
    scheduleOrder: planned.order,
    globalOrder: planned.globalOrder,
    disposition: "started",
    recordedAt: new Date().toISOString(),
    startedAt: null
  };
  start.startedAt ??= start.recordedAt;
  if (start.runId !== planned.runId
    || start.blockId !== blockId
    || start.armId !== 0
    || start.seed !== planned.seed
    || start.scheduleOrder !== planned.order
    || start.globalOrder !== planned.globalOrder
    || start.disposition !== "started"
    || start.startedAt !== start.recordedAt) {
    throw new Error("Deterministic start evidence differs from the frozen schedule");
  }
  const startBytes = Buffer.from(`${JSON.stringify(start, null, 2)}\n`, "utf8");
  const staging = generateGeneralBaseline({ blockId, seed: planned.seed });
  const errors = validateStaging(staging);
  if (errors.length > 0) throw new Error(`Deterministic staging is invalid: ${JSON.stringify(errors[0])}`);
  if (staging.cases.length !== 60) throw new Error(`${planned.runId} did not produce exactly 60 cases`);
  const bytes = Buffer.from(`${JSON.stringify(staging, null, 2)}\n`, "utf8");
  const endedAt = new Date().toISOString();
  const endEvidence = {
    formatVersion: 1,
    protocolId: schedule.protocolId,
    runId: planned.runId,
    blockId,
    armId: 0,
    endedAt
  };
  const endBytes = Buffer.from(`${JSON.stringify(endEvidence, null, 2)}\n`, "utf8");
  const wallMs = Date.parse(endedAt) - Date.parse(start.startedAt);
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
      globalOrder: planned.globalOrder,
      startedAt: start.startedAt,
      endedAt,
      cases: staging.cases.length,
      wallMs,
      stagingSha256: sha256(bytes),
      startEvidenceSha256: sha256(startBytes),
      endEvidenceSha256: sha256(endBytes)
    },
    startEvidence: start,
    startBytes,
    endEvidence,
    endBytes
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error("Arm 0 must run through scripts/run-controlled-harness.mjs");
}
