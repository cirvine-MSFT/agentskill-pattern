#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FROZEN_ALPHA = 0.05;
const FROZEN_BOOTSTRAP_RESAMPLES = 10000;
const FROZEN_BOOTSTRAP_SEED = 20260729;
const DEFAULT_ENDPOINTS = Object.freeze({
  promotionRate: -0.05,
  semanticPathCoverage: -0.03,
  mutantKillRate: -0.05
});
const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const schedule = JSON.parse(readFileSync(resolve(evaluatorRoot, "..", "design", "schedule.json"), "utf8"));
const PLANNED_BLOCKS = [...new Set(schedule.runs.map((run) => run.blockId))].sort();
const ARM_IDS = [0, 1, 2, 3, 4];
const AI_ARM_IDS = [1, 2, 3, 4];

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + ((sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction);
}

function summarize(rows, endpoint) {
  const values = rows.map((row) => row[endpoint]);
  const byBlock = new Map(rows.map((row) => [row.blockId, row]));
  const blockValues = PLANNED_BLOCKS.map((blockId) => {
    const row = byBlock.get(blockId);
    return {
      blockId,
      runId: row?.runId ?? null,
      value: row?.[endpoint] ?? null
    };
  });
  if (values.length === 0) {
    return {
      n: 0,
      blockValues,
      mean: null,
      median: null,
      standardDeviation: null,
      q1: null,
      q3: null,
      iqr: null
    };
  }
  const average = mean(values);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    n: values.length,
    blockValues,
    mean: average,
    median: quantile(values, 0.5),
    standardDeviation: values.length < 2
      ? null
      : Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1)),
    q1,
    q3,
    iqr: q3 - q1
  };
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

function pairedDifferences(byBlockArm, completeBlocks, armId, endpoint) {
  return completeBlocks.map((blockId) =>
    byBlockArm.get(`${blockId}\0${armId}`)[endpoint]
      - byBlockArm.get(`${blockId}\0${0}`)[endpoint]);
}

function contrastValues(byBlockArm, completeBlocks, endpoint) {
  const values = {
    modelTier: [],
    delegation: [],
    interaction: [],
    delegationAtFrontier: [],
    delegationAtCheap: [],
    tierInline: [],
    tierDelegated: []
  };
  for (const blockId of completeBlocks) {
    const value = (armId) => byBlockArm.get(`${blockId}\0${armId}`)[endpoint];
    const frontierInline = value(1);
    const frontierDelegated = value(2);
    const cheapInline = value(3);
    const cheapDelegated = value(4);
    values.modelTier.push(((frontierInline + frontierDelegated) / 2)
      - ((cheapInline + cheapDelegated) / 2));
    values.delegation.push(((frontierDelegated + cheapDelegated) / 2)
      - ((frontierInline + cheapInline) / 2));
    values.interaction.push((frontierDelegated - frontierInline)
      - (cheapDelegated - cheapInline));
    values.delegationAtFrontier.push(frontierDelegated - frontierInline);
    values.delegationAtCheap.push(cheapDelegated - cheapInline);
    values.tierInline.push(frontierInline - cheapInline);
    values.tierDelegated.push(frontierDelegated - cheapDelegated);
  }
  return values;
}

function validateBindings(bindingAvailability) {
  if (bindingAvailability?.evidence?.algorithm !== "Ed25519"
    || !bindingAvailability.evidence.payloadSha256
    || !bindingAvailability.evidence.signatureSha256
    || !bindingAvailability.evidence.publicKeySha256
    || !Array.isArray(bindingAvailability.runs)) {
    throw new Error("authenticated per-run binding availability is required");
  }
  const bindingRuns = new Map();
  const bindingSessions = new Set();
  for (const run of bindingAvailability.runs) {
    if (bindingRuns.has(run.runId)) throw new Error(`reused binding availability runId ${run.runId}`);
    const requiredRoles = run.armId === 2 || run.armId === 4 ? ["parent", "worker"] : ["parent"];
    if (run.status === "available") {
      for (const role of requiredRoles) {
        const roleEvidence = run.roles?.find((item) => item.role === role);
        const expectedModel = role === "worker" ? run.requestedWorkerModel : run.requestedModel;
        if (!roleEvidence || roleEvidence.observedModel !== expectedModel) {
          throw new Error(`available binding ${run.runId}/${role} has a model mismatch`);
        }
        if (bindingSessions.has(roleEvidence.sessionId)) {
          throw new Error(`reused binding sessionId ${roleEvidence.sessionId}`);
        }
        bindingSessions.add(roleEvidence.sessionId);
      }
    }
    bindingRuns.set(run.runId, run);
  }
  return bindingRuns;
}

function sensitivityAnalysis(byBlockArm, endpointEntries) {
  const arms = ARM_IDS.map((armId) => {
    const rows = PLANNED_BLOCKS
      .map((blockId) => byBlockArm.get(`${blockId}\0${armId}`))
      .filter(Boolean);
    return {
      armId,
      endpoints: Object.fromEntries(endpointEntries.map(([endpoint]) => {
        const observedSum = rows.reduce((sum, row) => sum + row[endpoint], 0);
        const missing = PLANNED_BLOCKS.length - rows.length;
        const zero = observedSum / PLANNED_BLOCKS.length;
        const one = (observedSum + missing) / PLANNED_BLOCKS.length;
        return [endpoint, {
          observed: rows.length,
          missing,
          missingAssignedZero: zero,
          missingAssignedOne: one,
          worstBestMeanBounds: [zero, one]
        }];
      }))
    };
  });

  const baselineComparisons = AI_ARM_IDS.flatMap((armId) =>
    endpointEntries.map(([endpoint]) => {
      let worst = 0;
      let best = 0;
      for (const blockId of PLANNED_BLOCKS) {
        const baseline = byBlockArm.get(`${blockId}\0${0}`)?.[endpoint];
        const treatment = byBlockArm.get(`${blockId}\0${armId}`)?.[endpoint];
        if (baseline !== undefined && treatment !== undefined) {
          worst += treatment - baseline;
          best += treatment - baseline;
        } else if (baseline !== undefined) {
          worst += -baseline;
          best += 1 - baseline;
        } else if (treatment !== undefined) {
          worst += treatment - 1;
          best += treatment;
        } else {
          worst -= 1;
          best += 1;
        }
      }
      return {
        armId,
        endpoint,
        worstMeanDifference: worst / PLANNED_BLOCKS.length,
        bestMeanDifference: best / PLANNED_BLOCKS.length
      };
    }));
  return { arms, baselineComparisons };
}

export function analyzeBaselineComparisons(observations, options = {}) {
  const overrideKeys = Object.keys(options).filter((key) => key !== "bindingAvailability");
  if (overrideKeys.length > 0) {
    throw new Error(`preregistered analysis options are frozen; cannot override ${overrideKeys.join(", ")}`);
  }
  const alpha = FROZEN_ALPHA;
  const endpoints = DEFAULT_ENDPOINTS;
  const bootstrapResamples = FROZEN_BOOTSTRAP_RESAMPLES;
  const bootstrapSeed = FROZEN_BOOTSTRAP_SEED;
  const { bindingAvailability } = options;
  if (!Array.isArray(observations)) throw new Error("observations must be an array");
  const bindingRuns = validateBindings(bindingAvailability);
  assertProbability(alpha, "alpha");
  if (!Number.isInteger(bootstrapResamples) || bootstrapResamples < 1000) {
    throw new Error("bootstrapResamples must be an integer of at least 1000");
  }
  const endpointEntries = Object.entries(endpoints);
  if (endpointEntries.length !== 3) throw new Error("exactly three primary endpoints are required");

  const submittedByBlockArm = new Map();
  const eligibleByBlockArm = new Map();
  const runIds = new Set();
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") throw new Error("observations must be objects");
    if (!PLANNED_BLOCKS.includes(observation.blockId)) {
      throw new Error(`observation uses unplanned block ${observation.blockId}`);
    }
    if (!ARM_IDS.includes(observation.armId)) throw new Error(`invalid armId in block ${observation.blockId}`);
    if (typeof observation.runId !== "string" || observation.runId.length === 0) {
      throw new Error("every observation requires a runId");
    }
    if (runIds.has(observation.runId)) throw new Error(`reused observation runId ${observation.runId}`);
    runIds.add(observation.runId);
    for (const [endpoint] of endpointEntries) {
      assertProbability(observation[endpoint], `${observation.blockId}/${observation.armId}/${endpoint}`);
    }
    const key = `${observation.blockId}\0${observation.armId}`;
    if (submittedByBlockArm.has(key)) {
      throw new Error(`duplicate observation for ${observation.blockId}/arm ${observation.armId}`);
    }
    submittedByBlockArm.set(key, observation);
    const planned = schedule.runs.find((run) =>
      run.blockId === observation.blockId && run.armId === observation.armId);
    if (observation.runId !== planned.runId) continue;
    if (observation.armId === 0) {
      eligibleByBlockArm.set(key, observation);
      continue;
    }
    const binding = bindingRuns.get(observation.runId);
    if (binding
      && binding.blockId === observation.blockId
      && binding.armId === observation.armId
      && binding.status === "available") {
      eligibleByBlockArm.set(key, observation);
    }
  }

  const incompleteBlocks = [];
  const completeBlocks = [];
  for (const blockId of PLANNED_BLOCKS) {
    const reasons = [];
    for (const armId of ARM_IDS) {
      const submitted = submittedByBlockArm.get(`${blockId}\0${armId}`);
      const eligible = eligibleByBlockArm.get(`${blockId}\0${armId}`);
      if (!submitted) reasons.push(`missing arm ${armId} observation`);
      else if (!eligible) reasons.push(`arm ${armId} lacks valid schedule/evidence binding`);
    }
    if (reasons.length === 0) completeBlocks.push(blockId);
    else incompleteBlocks.push({ blockId, reasons });
  }
  const confirmatoryAvailable = incompleteBlocks.length <= 2 && completeBlocks.length > 0;
  const unavailableReason = confirmatoryAvailable
    ? null
    : completeBlocks.length === 0
      ? "no complete blocks are available for paired analysis"
      : `${incompleteBlocks.length} of ${PLANNED_BLOCKS.length} blocks are incomplete; protocol permits at most 2`;

  const armSummaries = ARM_IDS.map((armId) => {
    const submitted = [...submittedByBlockArm.values()].filter((row) => row.armId === armId);
    const eligible = [...eligibleByBlockArm.values()].filter((row) => row.armId === armId);
    return {
      armId,
      plannedRuns: PLANNED_BLOCKS.length,
      submittedOutcomes: submitted.length,
      eligibleOutcomes: eligible.length,
      unavailableOutcomes: submitted.length - eligible.length,
      missingOutcomes: PLANNED_BLOCKS.length - eligible.length,
      endpoints: Object.fromEntries(endpointEntries.map(([endpoint]) =>
        [endpoint, summarize(eligible, endpoint)]))
    };
  });

  let comparisons = null;
  let factorial = null;
  if (completeBlocks.length > 0) {
    comparisons = [];
    for (const armId of AI_ARM_IDS) {
      for (const [endpoint, margin] of endpointEntries) {
        if (!Number.isFinite(margin) || margin >= 0) {
          throw new Error(`${endpoint} noninferiority margin must be finite and negative`);
        }
        const differences = pairedDifferences(eligibleByBlockArm, completeBlocks, armId, endpoint);
        const bootstrap = bootstrapBounds(differences, {
          alpha,
          resamples: bootstrapResamples,
          seed: bootstrapSeed
        });
        comparisons.push({
          armId,
          endpoint,
          margin,
          pairedBlocks: [...completeBlocks],
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
      comparison.noninferiority.holmAdjustedPValue = noninferiorityAdjusted[index];
      comparison.noninferiority.decisionAvailable = confirmatoryAvailable;
      comparison.noninferiority.noninferior = confirmatoryAvailable
        ? comparison.noninferiority.holmAdjustedPValue <= alpha
        : null;
      comparison.noninferiority.unavailableReason = confirmatoryAvailable ? null : unavailableReason;
      comparison.equality.holmAdjustedPValue = equalityAdjusted[index];
      comparison.equality.decisionAvailable = confirmatoryAvailable;
      comparison.equality.rejectEquality = confirmatoryAvailable
        ? comparison.equality.holmAdjustedPValue <= alpha
        : null;
      comparison.equality.unavailableReason = confirmatoryAvailable ? null : unavailableReason;
    }

    factorial = endpointEntries.map(([endpoint]) => {
      const values = contrastValues(eligibleByBlockArm, completeBlocks, endpoint);
      return {
        endpoint,
        pairedBlocks: [...completeBlocks],
        confirmatoryAvailable,
        unavailableReason,
        multiplicityWarning: "Factorial and conditional-effect bootstrap intervals are unadjusted and descriptive.",
        contrasts: Object.fromEntries(Object.entries(values).map(([name, blockValues]) => {
          const interval = bootstrapBounds(blockValues, {
            alpha,
            resamples: bootstrapResamples,
            seed: bootstrapSeed
          }).twoSided;
          return [name, {
            estimate: mean(blockValues),
            blockValues,
            confidenceInterval: interval
          }];
        }))
      };
    });
  }

  return {
    formatVersion: 2,
    alpha,
    analysisEligibility: {
      plannedBlocks: PLANNED_BLOCKS.length,
      completeBlocks,
      incompleteBlocks,
      confirmatoryAvailable,
      unavailableReason,
      bindingEvidenceSha256: bindingAvailability.evidence.payloadSha256
    },
    descriptive: {
      armAvailability: armSummaries.map((arm) => ({
        armId: arm.armId,
        plannedRuns: arm.plannedRuns,
        submittedOutcomes: arm.submittedOutcomes,
        eligibleOutcomes: arm.eligibleOutcomes,
        unavailableOutcomes: arm.unavailableOutcomes,
        missingOutcomes: arm.missingOutcomes
      })),
      armSummaries,
      sensitivity: sensitivityAnalysis(eligibleByBlockArm, endpointEntries)
    },
    bootstrap: { resamples: bootstrapResamples, seed: bootstrapSeed, lowerTail: alpha },
    families: {
      noninferiority: {
        hypotheses: 12,
        evaluated: comparisons?.length ?? 0,
        adjustment: "Holm",
        sidedness: "one-sided",
        decisionAvailable: confirmatoryAvailable
      },
      equality: {
        hypotheses: 12,
        evaluated: comparisons?.length ?? 0,
        adjustment: "Holm",
        sidedness: "two-sided",
        separateFromNoninferiority: true,
        decisionAvailable: confirmatoryAvailable
      }
    },
    factorial,
    comparisons
  };
}

export { DEFAULT_ENDPOINTS };

export function analyzeStatisticsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("analysis input must be an object");
  }
  const unexpectedKeys = Object.keys(input).filter((key) =>
    key !== "observations" && key !== "bindingAvailability");
  if (unexpectedKeys.length > 0) {
    throw new Error(`analysis overrides are forbidden (${unexpectedKeys.join(", ")}); preregistered alpha, margins, bootstrap seed, and draws are frozen`);
  }
  return analyzeBaselineComparisons(input.observations, {
    bindingAvailability: input.bindingAvailability
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  if (inputIndex < 0 || outputIndex < 0 || !process.argv[inputIndex + 1] || !process.argv[outputIndex + 1]) {
    throw new Error("Usage: node evaluator/statistics.mjs --in <blinded-run-metrics.json> --out <analysis.json>");
  }
  const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"));
  const result = analyzeStatisticsInput(input);
  const target = resolve(process.argv[outputIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    completeBlocks: result.analysisEligibility.completeBlocks.length,
    confirmatoryAvailable: result.analysisEligibility.confirmatoryAvailable,
    noninferior: result.comparisons?.filter((comparison) =>
      comparison.noninferiority.noninferior === true).length ?? null
  })}\n`);
}
