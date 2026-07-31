import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conditions = JSON.parse(
  readFileSync(resolve(root, "design", "condition-instructions.json"), "utf8")
);
const sharedTaskBytes = readFileSync(resolve(root, "design", "shared-task-prompt.txt"));

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sharedTaskSha256() {
  return sha256(sharedTaskBytes);
}

export function kickoffBytesForArm(armId) {
  const condition = conditions.conditions.find((item) => item.armId === armId);
  if (!condition?.kickoff) throw new Error(`No AI kickoff is registered for arm ${armId}`);
  return Buffer.concat([
    Buffer.from(`${condition.kickoff}\n\n`, "utf8"),
    sharedTaskBytes
  ]);
}

export function kickoffSha256ForArm(armId) {
  return sha256(kickoffBytesForArm(armId));
}
