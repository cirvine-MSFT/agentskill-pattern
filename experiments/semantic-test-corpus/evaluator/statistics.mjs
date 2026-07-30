#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINTS = Object.freeze({
  promotionRate: -0.05,
  semanticPathCoverage: -0.03,
  mutantKillRate: -0.05
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertProbability(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number from 0 through 1`);
  }
}

function exactSignFlipPValue(values, alternative) {
  if (values.length === 0) throw new Error("sign-flip tests require at least one paired block");
  if (values.length > 20) throw new Error("exact sign-flip tests support at most 20 paired blocks");
  const observed = mean(values);
  const assignments = 2 ** values.length;
  let asExtreme = 0;
  for (let mask = 0; mask < assignments; mask += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += (mask & (2 ** index)) === 0 ? values[index] : -values[index];
    }
    const randomized = sum / values.length;
    if (alternative === "greater") {
      if (randomized >= observed - Number.EPSILON) asExtreme += 1;
    } else if (Math.abs(randomized) >= Math.abs(observed) - Number.EPSILON) {
      asExtreme += 1;
    }
  }
  return asExtreme / assignments;
}

function holmAdjust(hypotheses) {
  const ordered = hypotheses
    .map((hypothesis, index) => ({ ...hypothesis, index }))
    .sort((left, right) => left.rawPValue - right.rawPValue || left.index - right.index);
  let runningMaximum = 0;
  const adjusted = new Array(hypotheses.length);
  for (const [rank, hypothesis] of ordered.entries()) {
    runningMaximum = Math.max(
      runningMaximum,
      Math.min(1, hypothesis.rawPValue * (hypotheses.length - rank))
    );
    adjusted[hypothesis.index] = runningMaximum;
  }
  return adjusted;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function bootstrapBounds(values, { alpha, resamples, seed }) {
  const random = seededRandom(seed);
  const estimates = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    const selected = [];
    for (let index = 0; index < values.length; index += 1) {
      selected.push(values[Math.floor(random() * values.length)]);
    }
    estimates.push(mean(selected));
  }
  estimates.sort((left, right) => left - right);
  const valueAt = (probability) => estimates[Math.floor(probability * (resamples - 1))];
  return {
    oneSidedLower: valueAt(alpha),
    twoSided: [valueAt(alpha / 2), valueAt(1 - (alpha / 2))]
  };
}

function pairedDifferences(observations, armId, endpoint) {
  const byBlock = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") throw new Error("observations must be objects");
    if (typeof observation.blockId !== "string" || observation.blockId.length === 0) {
      throw new Error("every observation requires a blockId");
    }
    if (!Number.isInteger(observation.armId) || observation.armId < 0 || observation.armId > 4) {
      throw new Error(`invalid armId in block ${observation.blockId}`);
    }
    assertProbability(observation[endpoint], `${observation.blockId}/${observation.armId}/${endpoint}`);
    const key = `${observation.blockId}\0${observation.armId}`;
    if (byBlock.has(key)) throw new Error(`duplicate observation for ${observation.blockId}/arm ${observation.armId}`);
    byBlock.set(key, observation[endpoint]);
  }

  const blocks = [...new Set(observations.map((observation) => observation.blockId))].sort();
  const pairs = blocks.flatMap((blockId) => {
    const baseline = byBlock.get(`${blockId}\0${0}`);
    const treatment = byBlock.get(`${blockId}\0${armId}`);
    return baseline === undefined || treatment === undefined
      ? []
      : [{ blockId, difference: treatment - baseline }];
  });
  if (pairs.length === 0) throw new Error(`arm ${armId}/${endpoint} has no baseline-paired blocks`);
  return pairs;
}

export function analyzeBaselineComparisons(observations, {
  alpha = 0.05,
  endpoints = DEFAULT_ENDPOINTS,
  bootstrapResamples = 10000,
  bootstrapSeed = 20260729
} = {}) {
  if (!Array.isArray(observations)) throw new Error("observations must be an array");
  assertProbability(alpha, "alpha");
  if (!Number.isInteger(bootstrapResamples) || bootstrapResamples < 1000) {
    throw new Error("bootstrapResamples must be an integer of at least 1000");
  }
  const endpointEntries = Object.entries(endpoints);
  if (endpointEntries.length !== 3) throw new Error("exactly three primary endpoints are required");
  const comparisons = [];

  for (const armId of [1, 2, 3, 4]) {
    for (const [endpoint, margin] of endpointEntries) {
      if (!Number.isFinite(margin) || margin >= 0) {
        throw new Error(`${endpoint} noninferiority margin must be finite and negative`);
      }
      const pairs = pairedDifferences(observations, armId, endpoint);
      const differences = pairs.map((pair) => pair.difference);
      const bootstrap = bootstrapBounds(differences, {
        alpha,
        resamples: bootstrapResamples,
        seed: bootstrapSeed + comparisons.length
      });
      comparisons.push({
        armId,
        endpoint,
        margin,
        pairedBlocks: pairs.map((pair) => pair.blockId),
        differences,
        meanDifference: mean(differences),
        noninferiority: {
          alternative: "greater",
          nullHypothesis: `difference <= ${margin}`,
          rawPValue: exactSignFlipPValue(
            differences.map((difference) => difference - margin),
            "greater"
          ),
          lowerConfidenceBound: bootstrap.oneSidedLower
        },
        equality: {
          alternative: "two-sided",
          nullHypothesis: "difference = 0",
          rawPValue: exactSignFlipPValue(differences, "two-sided"),
          confidenceInterval: bootstrap.twoSided
        }
      });
    }
  }

  const noninferiorityAdjusted = holmAdjust(
    comparisons.map((comparison) => ({ rawPValue: comparison.noninferiority.rawPValue }))
  );
  const equalityAdjusted = holmAdjust(
    comparisons.map((comparison) => ({ rawPValue: comparison.equality.rawPValue }))
  );
  for (const [index, comparison] of comparisons.entries()) {
    const noninferiority = comparison.noninferiority;
    noninferiority.holmAdjustedPValue = noninferiorityAdjusted[index];
    noninferiority.noninferior = noninferiority.holmAdjustedPValue <= alpha
      && noninferiority.lowerConfidenceBound > comparison.margin;
    comparison.equality.holmAdjustedPValue = equalityAdjusted[index];
    comparison.equality.rejectEquality = comparison.equality.holmAdjustedPValue <= alpha;
  }

  return {
    formatVersion: 1,
    alpha,
    bootstrap: { resamples: bootstrapResamples, seed: bootstrapSeed, lowerTail: alpha },
    families: {
      noninferiority: {
        hypotheses: comparisons.length,
        adjustment: "Holm",
        sidedness: "one-sided"
      },
      equality: {
        hypotheses: comparisons.length,
        adjustment: "Holm",
        sidedness: "two-sided",
        separateFromNoninferiority: true
      }
    },
    comparisons
  };
}

export { DEFAULT_ENDPOINTS };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  if (inputIndex < 0 || outputIndex < 0 || !process.argv[inputIndex + 1] || !process.argv[outputIndex + 1]) {
    throw new Error("Usage: node evaluator/statistics.mjs --in <blinded-run-metrics.json> --out <analysis.json>");
  }
  const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"));
  const result = analyzeBaselineComparisons(input.observations, input.options);
  const target = resolve(process.argv[outputIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    comparisons: result.comparisons.length,
    noninferior: result.comparisons.filter((comparison) => comparison.noninferiority.noninferior).length
  })}\n`);
}
