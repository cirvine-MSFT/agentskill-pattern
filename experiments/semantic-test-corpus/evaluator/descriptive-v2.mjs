#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(evaluatorRoot, "..");
const schemaRoot = resolve(root, "schemas");
const inputSchema = JSON.parse(readFileSync(resolve(schemaRoot, "descriptive-input.schema.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function point(values) {
  return {
    n: values.length,
    mean: values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values)
  };
}

export function summarizeDescriptive(runs) {
  const seen = new Set();
  for (const run of runs) {
    const planned = schedule.runs.find((item) => item.runId === run.runId);
    if (!planned
      || planned.blockId !== run.blockId
      || planned.armId !== run.armId
      || seen.has(run.runId)) {
      throw new Error(`Run identity is duplicate or differs from the frozen schedule: ${run.runId}`);
    }
    seen.add(run.runId);
  }
  const endpointNames = [...new Set(runs.flatMap((run) => Object.keys(run.endpoints)))].sort();
  const armPoints = schedule.runs
    .map((run) => run.armId)
    .filter((armId, index, values) => values.indexOf(armId) === index)
    .sort((left, right) => left - right)
    .map((armId) => {
      const armRuns = runs.filter((run) => run.armId === armId);
      return {
        armId,
        planned: 12,
        observed: armRuns.length,
        endpoints: Object.fromEntries(endpointNames.map((endpoint) => [
          endpoint,
          {
            ...point(armRuns.map((run) => run.endpoints[endpoint]).filter(Number.isFinite)),
            blockValues: Array.from({ length: 12 }, (_, index) => {
              const blockId = `B${String(index + 1).padStart(2, "0")}`;
              return {
                blockId,
                value: armRuns.find((run) => run.blockId === blockId)?.endpoints[endpoint] ?? null
              };
            })
          }
        ]))
      };
    });
  const pairs = [];
  for (let armId = 1; armId <= 5; armId += 1) {
    for (const endpoint of endpointNames) {
      const blockPairs = [];
      for (let index = 1; index <= 12; index += 1) {
        const blockId = `B${String(index).padStart(2, "0")}`;
        const baseline = runs.find((run) => run.blockId === blockId && run.armId === 0)
          ?.endpoints[endpoint];
        const treatment = runs.find((run) => run.blockId === blockId && run.armId === armId)
          ?.endpoints[endpoint];
        if (Number.isFinite(baseline) && Number.isFinite(treatment)) {
          blockPairs.push({ blockId, baseline, treatment, difference: treatment - baseline });
        }
      }
      pairs.push({
        armId,
        endpoint,
        ...point(blockPairs.map((pair) => pair.difference)),
        blockPairs
      });
    }
  }
  return {
    formatVersion: 1,
    protocolId: "semantic-test-corpus-execution-v2",
    analysis: "descriptive-point-estimates-and-within-block-pairs-only",
    plannedRuns: 72,
    observedRuns: runs.length,
    armPoints,
    pairs
  };
}

export function analyzeDescriptiveInput(input) {
  const errors = validateJsonSchema(input, inputSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Descriptive input is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return summarizeDescriptive(input.runs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = argument(process.argv, "--in");
  const outputPath = argument(process.argv, "--out");
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node evaluator/descriptive-v2.mjs --in <descriptive-input.json> --out <summary.json>");
  }
  const output = analyzeDescriptiveInput(JSON.parse(readFileSync(resolve(inputPath), "utf8")));
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.observedRuns}/72 run units summarized descriptively\n`);
}
