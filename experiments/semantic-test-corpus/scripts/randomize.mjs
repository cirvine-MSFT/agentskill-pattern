#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  kickoffSha256ForRun,
  taskSha256ForSeed
} from "./execution-contract.mjs";
import { predeterminedSessionId, PROTOCOL_ID } from "./copilot-cli-v5.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle(values, seed) {
  const output = [...values];
  const random = randomSource(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

export function createSchedule() {
  const design = JSON.parse(
    readFileSync(resolve(root, "design", "v5", "seeds.json"), "utf8")
  );
  return {
    protocolId: PROTOCOL_ID,
    scheduleVersion: 6,
    runNamespace: design.runNamespace,
    randomizationSeed: design.randomizationSeed,
    runs: design.blocks.flatMap((block, blockIndex) =>
      shuffle([0, 1, 2, 3, 4, 5], block.seed).map((armId, order) => ({
        runId: `V5-${block.id}-A${armId}`,
        blockId: block.id,
        armId,
        order: order + 1,
        globalOrder: blockIndex * 6 + order + 1,
        seed: block.seed,
        sessionId: armId === 0
          ? null
          : predeterminedSessionId(design.runNamespace, `V5-${block.id}-A${armId}`),
        taskSha256: taskSha256ForSeed(block.seed),
        kickoffSha256: armId === 0 ? null : kickoffSha256ForRun(armId, block.seed)
      })))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("Usage: node scripts/randomize.mjs --out <schedule.json>");
  }
  const target = resolve(process.argv[index + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(createSchedule(), null, 2)}\n`);
  process.stdout.write(`Wrote 72 preregistered run slots to ${target}\n`);
}
