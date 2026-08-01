#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "start-index.schema.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));

export function validateStartOrder(index, { requireComplete = true, baseDir = null } = {}) {
  const errors = validateJsonSchema(index, schema, { schemaDir: schemaRoot })
    .map((error) => `${error.path} ${error.message}`);
  if (errors.length > 0) return errors;
  if (requireComplete && index.captures.length !== schedule.runs.length) {
    errors.push(`captured ${index.captures.length} starts; exactly 72 are required`);
  }
  let previousTimestamp = -Infinity;
  for (const [position, capture] of index.captures.entries()) {
    const planned = schedule.runs[position];
    if (!planned
      || capture.sequence !== position + 1
      || capture.sequence !== planned.globalOrder
      || capture.runId !== planned.runId
      || capture.blockId !== planned.blockId
      || capture.armId !== planned.armId) {
      errors.push(`capture ${position + 1} differs from the frozen global start sequence`);
      continue;
    }
    const timestamp = Date.parse(capture.recordedAt);
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp) {
      errors.push(`capture ${capture.runId} does not have a strictly increasing order timestamp`);
    }
    previousTimestamp = timestamp;
    if (baseDir) {
      try {
        const bytes = readFileSync(resolve(baseDir, capture.sourcePath));
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== capture.sourceSha256) {
          errors.push(`capture ${capture.runId} source SHA-256 differs`);
        }
        const source = JSON.parse(bytes);
        if (!source
          || source.runId !== capture.runId
          || source.disposition !== capture.disposition
          || source.recordedAt !== capture.recordedAt
          || (capture.disposition === "started"
            && (capture.startedAt !== capture.recordedAt
              || source.startedAt !== capture.startedAt))
          || (capture.disposition === "unavailable"
            && capture.startedAt !== null)) {
          errors.push(`capture ${capture.runId} disposition/timestamp is not derived from its raw source`);
        }
      } catch (error) {
        errors.push(`capture ${capture.runId} source cannot be verified: ${error.message}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputIndex = process.argv.indexOf("--in");
  if (inputIndex < 0 || !process.argv[inputIndex + 1]) {
    throw new Error("Usage: node scripts/validate-start-order.mjs --in <start-index.json> [--allow-prefix]");
  }
  const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"));
  const errors = validateStartOrder(input, {
    requireComplete: !process.argv.includes("--allow-prefix"),
    baseDir: dirname(resolve(process.argv[inputIndex + 1]))
  });
  if (errors.length > 0) throw new Error(`Start-order validation failed: ${errors[0]}`);
  process.stdout.write(`${input.captures.length} captured starts match the frozen global sequence\n`);
}
