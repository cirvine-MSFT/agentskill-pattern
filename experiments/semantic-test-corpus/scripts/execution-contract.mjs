import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conditions = JSON.parse(
  readFileSync(resolve(root, "design", "condition-instructions.json"), "utf8")
);
const repositoryRoot = resolve(root, "..", "..");
const sourcePin = JSON.parse(readFileSync(resolve(root, "design", "source-pin.json"), "utf8"));
const taskBlob = sourcePin.sourceBlobs[
  "experiments/semantic-test-corpus/design/shared-task-prompt.txt"
];
const taskResult = spawnSync("git", ["cat-file", "blob", taskBlob], {
  cwd: repositoryRoot,
  encoding: null
});
if (taskResult.status !== 0) throw new Error("Cannot read the pinned shared-task blob");
const sharedTaskBytes = taskResult.stdout;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sharedTaskSha256() {
  return sha256(sharedTaskBytes);
}

export function taskBytesForSeed(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error("A safe-integer block seed is required");
  return Buffer.concat([
    sharedTaskBytes,
    Buffer.from(`\nBenchmark block seed: ${seed}`, "utf8")
  ]);
}

export function taskSha256ForSeed(seed) {
  return sha256(taskBytesForSeed(seed));
}

export function kickoffBytesForRun(armId, seed) {
  const condition = conditions.conditions.find((item) => item.armId === armId);
  if (!condition?.kickoff) throw new Error(`No AI kickoff is registered for arm ${armId}`);
  return Buffer.concat([
    Buffer.from(`${condition.kickoff}\n\n`, "utf8"),
    taskBytesForSeed(seed)
  ]);
}

export function kickoffSha256ForRun(armId, seed) {
  return sha256(kickoffBytesForRun(armId, seed));
}

export const kickoffBytesForArm = kickoffBytesForRun;
export const kickoffSha256ForArm = kickoffSha256ForRun;
