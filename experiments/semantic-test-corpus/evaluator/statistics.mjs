#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "../scripts/authenticated-export.mjs";
import { evaluateModelBindings } from "../scripts/preflight-models.mjs";
import {
  evaluateGlobalAttribution,
  evaluateIsolationEvidence
} from "../scripts/verify-isolation-evidence.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { protocolDesignForRunId } from "../scripts/protocol-design.mjs";
import { canonicalMetricsBytes, deriveMetricsArtifact } from "./metrics.mjs";

const FROZEN_ALPHA = 0.05;
const FROZEN_BOOTSTRAP_RESAMPLES = 10000;
const FROZEN_BOOTSTRAP_SEED = 20260729;
const DEFAULT_ENDPOINTS = Object.freeze({
  promotionRate: -0.05,
  semanticPathCoverage: -0.03,
  mutantKillRate: -0.05
});
const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const schedule = JSON.parse(
  readFileSync(resolve(evaluatorRoot, "..", "design", "v4", "schedule.json"), "utf8")
);
const schemaRoot = resolve(evaluatorRoot, "..", "schemas");
const statisticsInputSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "statistics-input.schema.json"), "utf8")
);
const runRecordSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "run-record.schema.json"), "utf8")
);
const metricsArtifactSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "metrics-artifact.schema.json"), "utf8")
);
const PLANNED_BLOCKS = [...new Set(schedule.runs.map((run) => run.blockId))].sort();
const ARM_IDS = [...new Set(schedule.runs.map((run) => run.armId))].sort((left, right) => left - right);
const AI_ARM_IDS = ARM_IDS.filter((armId) => armId !== 0);

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

export function verifyMetricsArtifact({ metricsPath, runRecord, authenticated }) {
  if (!runRecord?.metrics || !runRecord?.staging) {
    throw new Error(`run record ${runRecord?.runId ?? "<missing>"} lacks staging/metrics bindings`);
  }
  if (!samePath(metricsPath, runRecord.metrics.path)) {
    throw new Error(`metrics path differs from run record for ${runRecord.runId}`);
  }
  const metricsBytes = readFileSync(resolve(metricsPath));
  const metricsSha256 = sha256(metricsBytes);
  if (metricsSha256 !== runRecord.metrics.sha256) {
    throw new Error(`metrics hash differs from run record for ${runRecord.runId}`);
  }
  const artifact = JSON.parse(metricsBytes);
  const schemaErrors = validateJsonSchema(artifact, metricsArtifactSchema, {
    schemaDir: schemaRoot
  });
  if (schemaErrors.length > 0) {
    throw new Error(`metrics artifact schema failed for ${runRecord.runId}: ${schemaErrors[0].path} ${schemaErrors[0].message}`);
  }
  if (!canonicalMetricsBytes(artifact).equals(metricsBytes)) {
    throw new Error(`metrics artifact is not canonical for ${runRecord.runId}`);
  }
  if (artifact.runId !== runRecord.runId
    || artifact.blockId !== runRecord.blockId
    || artifact.armId !== runRecord.armId
    || artifact.snapshotSha256 !== runRecord.metrics.snapshotSha256
    || artifact.snapshotSha256 !== runRecord.staging.sha256) {
    throw new Error(`metrics artifact identity differs from run record for ${runRecord.runId}`);
  }
  const snapshotBytes = readFileSync(resolve(runRecord.staging.path));
  if (sha256(snapshotBytes) !== artifact.snapshotSha256) {
    throw new Error(`snapshot hash differs from metrics artifact for ${runRecord.runId}`);
  }
  const expected = deriveMetricsArtifact(snapshotBytes, {
    runId: runRecord.runId,
    blockId: runRecord.blockId,
    armId: runRecord.armId
  });
  if (!canonicalMetricsBytes(expected).equals(metricsBytes)) {
    throw new Error(`metrics artifact does not match deterministic evaluator output for ${runRecord.runId}`);
  }
  const events = authenticated.payload.events;
  const computed = events.filter((event) =>
    event.type === "metrics.computed" && event.runId === runRecord.runId);
  if (computed.length !== 1) {
    throw new Error(`${runRecord.runId} requires exactly one signed metrics.computed event`);
  }
  const event = computed[0];
  const modelSessions = new Set(events
    .filter((item) => item.type === "session.created" || item.type === "run.started")
    .map((item) => item.sessionId));
  const runProcesses = new Set(events
    .filter((item) => item.type === "run.started")
    .map((item) => item.processId));
  if (event.role !== "evaluator"
    || event.actor !== "evaluator"
    || modelSessions.has(event.sessionId)
    || runProcesses.has(event.processId)
    || event.eventId !== runRecord.metrics.eventId
    || event.sessionId !== runRecord.metrics.evaluatorSessionId
    || event.processId !== runRecord.metrics.evaluatorProcessId
    || event.blockId !== runRecord.blockId
    || event.armId !== runRecord.armId
    || !samePath(event.metricsPath ?? "", metricsPath)
    || event.metricsSha256 !== metricsSha256
    || event.snapshotSha256 !== artifact.snapshotSha256
    || event.evaluatorCodeSha256 !== artifact.provenance.evaluator.sha256
    || event.specSha256 !== artifact.provenance.spec.sha256
    || event.oracleCodeSha256 !== artifact.provenance.oracle.sha256
    || event.mutantCodeSha256 !== artifact.provenance.mutants.sha256) {
    throw new Error(`signed metrics event differs from artifact/run identity for ${runRecord.runId}`);
  }
  const completion = events.filter((item) =>
    item.runId === runRecord.runId && item.type === "run.completed");
  const unblinding = events.filter((item) =>
    item.runId === runRecord.runId && item.type === "outcomes.unblinded");
  const starts = events.filter((item) =>
    item.runId === runRecord.runId && item.type === "run.started");
  const runSchedule = protocolDesignForRunId(runRecord.runId).schedule;
  const planned = runSchedule.runs.find((item) => item.runId === runRecord.runId);
  const boundaries = [...completion, ...unblinding];
  const expectedBoundaryRole = runRecord.armId === 0 ? "baseline" : "parent";
  const expectedBoundarySession = runRecord.armId === 0
    ? starts[0]?.sessionId
    : runRecord.modelEvidence.roles.find((role) => role.role === "parent")?.sessionId;
  if (!planned
    || planned.blockId !== runRecord.blockId
    || planned.armId !== runRecord.armId
    || starts.length !== 1
    || starts[0].blockId !== runRecord.blockId
    || starts[0].armId !== runRecord.armId
    || starts[0].sequence !== planned.order
    || starts[0].role !== expectedBoundaryRole
    || !starts[0].processId
    || (runRecord.sessionIds?.length > 0
      && !runRecord.sessionIds.includes(starts[0].sessionId))
    || completion.length !== 1
    || unblinding.length !== 1
    || boundaries.some((item) =>
      item.blockId !== runRecord.blockId
      || item.armId !== runRecord.armId
      || item.role !== expectedBoundaryRole
      || item.sessionId !== boundaries[0].sessionId
      || (expectedBoundarySession && item.sessionId !== expectedBoundarySession)
      || Date.parse(item.timestamp) <= Date.parse(starts[0]?.timestamp)
      || Date.parse(event.timestamp) <= Date.parse(item.timestamp))) {
    throw new Error(`signed metrics event precedes completion/unblinding for ${runRecord.runId}`);
  }
  if (Date.parse(completion[0].timestamp) - Date.parse(starts[0].timestamp) > 1800000) {
    throw new Error(`signed run duration exceeds the 30-minute limit for ${runRecord.runId}`);
  }
  return artifact;
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
    const requiredRoles = [2, 4, 5].includes(run.armId) ? ["parent", "worker"] : ["parent"];
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
      && binding.status === "available"
      && observation.isolationVerified === true) {
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
  const unavailableAiRuns = schedule.runs
    .filter((run) => AI_ARM_IDS.includes(run.armId))
    .filter((run) => bindingRuns.get(run.runId)?.status !== "available")
    .map((run) => run.runId);
  const unavailableIsolationRuns = observations
    .filter((observation) => observation.armId !== 0 && observation.isolationVerified !== true)
    .map((observation) => observation.runId)
    .sort();
  const confirmatoryAvailable = unavailableAiRuns.length === 0
    && unavailableIsolationRuns.length === 0
    && incompleteBlocks.length <= 2
    && completeBlocks.length > 0;
  const unavailableReason = confirmatoryAvailable
    ? null
    : unavailableAiRuns.length > 0
      ? `${unavailableAiRuns.length} measured AI run(s) lack frozen model availability`
      : unavailableIsolationRuns.length > 0
        ? `${unavailableIsolationRuns.length} measured AI run(s) lack authenticated compliant isolation/budget evidence`
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
  if (completeBlocks.length > 0
    && unavailableAiRuns.length === 0
    && unavailableIsolationRuns.length === 0) {
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
      unavailableAiRuns,
      unavailableIsolationRuns,
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
        hypotheses: AI_ARM_IDS.length * endpointEntries.length,
        evaluated: comparisons?.length ?? 0,
        adjustment: "Holm",
        sidedness: "one-sided",
        decisionAvailable: confirmatoryAvailable
      },
      equality: {
        hypotheses: AI_ARM_IDS.length * endpointEntries.length,
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
  throw new Error("authenticated platform export, signature, public key, run records, metrics artifacts, and isolation contexts are required");
}

export function assertAuthenticatedRunCoverage(runs, records, authenticated) {
  const authenticatedMetricRunIds = authenticated.payload.events
    .filter((event) => event.type === "metrics.computed")
    .map((event) => event.runId)
    .sort();
  const suppliedRunIds = runs.map((run) => run.runId).sort();
  if (new Set(suppliedRunIds).size !== suppliedRunIds.length
    || new Set(authenticatedMetricRunIds).size !== authenticatedMetricRunIds.length
    || JSON.stringify(suppliedRunIds) !== JSON.stringify(authenticatedMetricRunIds)
    || authenticatedMetricRunIds.some((runId) =>
      !records.has(runId) || records.get(runId).phase !== "complete")) {
    throw new Error("statistics runs must map one-to-one with every authenticated metrics artifact");
  }
}

export function analyzeAuthenticatedStatisticsInput(input, authenticated) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("analysis input must be an object");
  }
  const unexpectedKeys = Object.keys(input).filter((key) =>
    key !== "runs" && key !== "runRecords");
  if (unexpectedKeys.length > 0) {
    throw new Error(`caller-supplied analysis/evidence fields are forbidden: ${unexpectedKeys.join(", ")}`);
  }
  const schemaErrors = validateJsonSchema(input, statisticsInputSchema, { schemaDir: schemaRoot });
  if (schemaErrors.length > 0) {
    throw new Error(`statistics input schema failed: ${schemaErrors[0].path} ${schemaErrors[0].message}`);
  }
  if (!Array.isArray(input.runs) || !Array.isArray(input.runRecords)) {
    throw new Error("runs and runRecords arrays are required");
  }
  const records = new Map();
  for (const record of input.runRecords) {
    const errors = validateJsonSchema(record, runRecordSchema, { schemaDir: schemaRoot });
    if (errors.length > 0) {
      throw new Error(`run record schema failed for ${record?.runId ?? "<missing>"}: ${errors[0].path} ${errors[0].message}`);
    }
    if (records.has(record.runId)) throw new Error(`duplicate run record ${record.runId}`);
    records.set(record.runId, record);
  }
  const bindingAvailability = evaluateModelBindings(authenticated, input.runRecords);
  const globalAttribution = evaluateGlobalAttribution(authenticated);
  if (globalAttribution.status !== "compliant") {
    throw new Error(`global event attribution failed: ${globalAttribution.violations[0]}`);
  }
  assertAuthenticatedRunCoverage(input.runs, records, authenticated);
  const verifiedObservations = input.runs.map((run) => {
    const record = records.get(run.runId);
    if (!record
      || record.blockId !== run.blockId
      || record.armId !== run.armId
      || record.phase !== "complete") {
      throw new Error(`statistics run identity differs from run record for ${run.runId}`);
    }
    const artifact = verifyMetricsArtifact({
      metricsPath: run.metricsPath,
      runRecord: record,
      authenticated
    });
    const observation = {
      runId: run.runId,
      blockId: run.blockId,
      armId: run.armId,
      promotionRate: artifact.metrics.promotion.promotionRate,
      semanticPathCoverage: artifact.metrics.coverage.paths.rate,
      mutantKillRate: artifact.metrics.mutation.killRate
    };
    if (run.armId === 0) return { ...observation, isolationVerified: true };
    const context = run.evidenceContext;
    if (!context?.contractRoot
      || !context?.stagingRoot
      || !context?.evaluatorRoot) {
      throw new Error(`isolation evidence context is required for ${run.runId}`);
    }
    const audit = evaluateIsolationEvidence(authenticated, {
      armId: run.armId,
      runId: run.runId,
      contractRoot: context.contractRoot,
      stagingRoot: context.stagingRoot,
      evaluatorRoot: context.evaluatorRoot,
      snapshotPath: record.staging.path
    });
    return {
      ...observation,
      isolationVerified: audit.status === "compliant" && audit.budgets.met === true
    };
  });
  return analyzeBaselineComparisons(verifiedObservations, { bindingAvailability });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  const payloadIndex = process.argv.indexOf("--payload");
  const signatureIndex = process.argv.indexOf("--signature");
  const publicKeyIndex = process.argv.indexOf("--public-key");
  if ([inputIndex, outputIndex, payloadIndex, signatureIndex, publicKeyIndex].some((index) =>
    index < 0 || !process.argv[index + 1])) {
    throw new Error("Usage: node evaluator/statistics.mjs --in <run-artifacts.json> --payload <platform-export.json> --signature <export.sig> --public-key <platform.pem> --out <analysis.json>");
  }
  const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"));
  const authenticated = readAuthenticatedExport({
    payloadPath: process.argv[payloadIndex + 1],
    signaturePath: process.argv[signatureIndex + 1],
    publicKeyPath: process.argv[publicKeyIndex + 1]
  });
  const result = analyzeAuthenticatedStatisticsInput(input, authenticated);
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
