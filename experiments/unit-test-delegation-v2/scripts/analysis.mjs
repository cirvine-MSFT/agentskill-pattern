import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonical, readJson, root, writeJson } from "./lib.mjs";

const study = readJson(path.join(root, "design", "study.json"));
const schedule = readJson(path.join(root, "design", "schedule.json"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function finalizeDuplicateFlags(input) {
  const observations = clone(input);
  const countByHash = new Map();
  for (const observation of observations) {
    const hash = observation.evaluation?.tests?.normalizedHash;
    if (!hash) continue;
    countByHash.set(hash, (countByHash.get(hash) ?? 0) + 1);
  }
  for (const observation of observations) {
    const tests = observation.evaluation?.tests;
    if (!tests) continue;
    tests.duplicate = (countByHash.get(tests.normalizedHash) ?? 0) > 1;
    tests.components.nontrivial = tests.trivial || tests.duplicate ? 0 : 1;
    tests.composite = Object.values(tests.components).reduce((sum, value) => sum + value, 0) / Object.keys(tests.components).length;
  }
  return observations;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function geometricMean(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  return Math.exp(mean(values.map(Math.log)));
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function random(seed) {
  let counter = 0;
  return () => {
    const bytes = crypto.createHash("sha256").update(`${seed}|${counter++}`).digest();
    return bytes.readUInt32BE(0) / 0x100000000;
  };
}

function metric(observation, name) {
  const evaluation = observation.evaluation;
  const imputed = {
    combinedCredits: study.envelope.combinedCredits,
    parentCredits: study.envelope.combinedCredits,
    parentCumulativeInput: study.envelope.modelTokens,
    parentPeakInput: study.envelope.modelTokens,
    totalModelTokens: study.envelope.modelTokens,
    wallMs: study.envelope.wallSeconds * 1000
  };
  const values = {
    combinedCredits: observation.usage.combinedCredits,
    parentCredits: observation.usage.parent.credits,
    parentCumulativeInput: observation.parentContext.cumulativeInputTokens,
    parentPeakInput: observation.parentContext.peakInputTokens,
    totalModelTokens: observation.usage.totalModelTokens,
    wallMs: observation.timing.wallMs,
    feature: evaluation?.feature?.score ?? 0,
    testComposite: evaluation?.tests?.composite ?? 0,
    mutantKill: evaluation?.tests?.components?.mutantKill ?? 0,
    branchCoverage: evaluation?.tests?.branchCoverage ?? 0,
    falsePositive: evaluation?.tests?.goldPass ? 0 : 1,
    reliability: observation.status === "complete" ? 1 : 0,
    adherence: observation.arm === "A1" ? 1 : evaluation?.adherence?.adherent ? 1 : 0
  };
  const value = values[name];
  if (Number.isFinite(value)) return value;
  return observation.startDisposition === "started" && Object.hasOwn(imputed, name) ? imputed[name] : null;
}

function pairRows(observations) {
  const blocks = new Map();
  for (const observation of observations.filter((entry) => entry.startDisposition === "started")) {
    const block = blocks.get(observation.blockId) ?? {};
    if (block[observation.arm]) throw new Error(`duplicate arm in ${observation.blockId}`);
    block[observation.arm] = observation;
    blocks.set(observation.blockId, block);
  }
  return [...blocks.entries()].map(([blockId, arms]) => {
    assert(arms.A1 && arms.A2, `incomplete started pair ${blockId}`);
    assert.equal(arms.A1.taskId, arms.A2.taskId, `task mismatch in ${blockId}`);
    return { blockId, taskId: arms.A1.taskId, A1: arms.A1, A2: arms.A2 };
  });
}

function assertUniqueIdentities(observations) {
  for (const field of ["observationId", "sessionId", "worktreeId"]) {
    const values = observations.map((observation) => observation[field]);
    assert(values.every((value) => typeof value === "string" && value.length >= 8), `${field} missing`);
    assert.equal(new Set(values).size, values.length, `${field} must be unique`);
  }
}

function validateEvidence(observations, phase) {
  const expected = schedule[phase].flatMap((block) => block.observations.map((observation) => ({
    ...observation,
    blockId: block.blockId,
    taskId: block.taskId,
    repetition: block.repetition
  })));
  assert.equal(observations.length, expected.length, `${phase} evidence count mismatch`);
  const byId = new Map(observations.map((observation) => [observation.observationId, observation]));
  assert.equal(byId.size, observations.length, "duplicate observation ID");
  for (const frozen of expected) {
    const observed = byId.get(frozen.observationId);
    assert(observed, `missing scheduled observation ${frozen.observationId}`);
    for (const field of ["blockId", "taskId", "repetition", "arm"]) assert.equal(observed[field], frozen[field], `${frozen.observationId} ${field} drift`);
    if (observed.arm === "A1") {
      for (const field of ["credits", "nanoAiu", "inputTokens", "outputTokens", "completions"]) assert.equal(observed.usage.worker[field], 0, `${frozen.observationId} A1 worker ${field} must be zero`);
    }
    const actorCredits = observed.usage.parent.credits + observed.usage.worker.credits;
    if (Number.isFinite(actorCredits) && Number.isFinite(observed.usage.combinedCredits)) assert(Math.abs(actorCredits - observed.usage.combinedCredits) < 1e-9, `${frozen.observationId} credit arithmetic mismatch`);
    const actorNanoAiu = observed.usage.parent.nanoAiu + observed.usage.worker.nanoAiu;
    if (Number.isFinite(actorNanoAiu) && Number.isFinite(observed.usage.combinedNanoAiu)) assert.equal(actorNanoAiu, observed.usage.combinedNanoAiu, `${frozen.observationId} nano-AIU arithmetic mismatch`);
    if (Number.isFinite(observed.usage.combinedCredits) && Number.isFinite(observed.usage.combinedNanoAiu)) assert(Math.abs(observed.usage.combinedCredits - observed.usage.combinedNanoAiu / 1e9) < 1e-9, `${frozen.observationId} credit/nano-AIU mismatch`);
    for (const actor of ["parent", "worker"]) {
      const usage = observed.usage[actor];
      if (Number.isFinite(usage.credits) && Number.isFinite(usage.nanoAiu)) assert(Math.abs(usage.credits - usage.nanoAiu / 1e9) < 1e-9, `${frozen.observationId} ${actor} credit/nano-AIU mismatch`);
    }
    const actorTokens = observed.usage.parent.inputTokens + observed.usage.parent.outputTokens + observed.usage.worker.inputTokens + observed.usage.worker.outputTokens;
    if (Number.isFinite(actorTokens) && Number.isFinite(observed.usage.totalModelTokens)) assert.equal(actorTokens, observed.usage.totalModelTokens, `${frozen.observationId} token arithmetic mismatch`);
  }
}

function contrast(pairs, name, kind) {
  const values = pairs.map((pair) => {
    const control = metric(pair.A1, name);
    const treatment = metric(pair.A2, name);
    if (control === null || treatment === null) return null;
    return kind === "ratio" ? (control > 0 ? treatment / control : null) : treatment - control;
  }).filter((value) => value !== null);
  return kind === "ratio" ? geometricMean(values) : mean(values);
}

function bootstrap(pairs, name, kind) {
  const rng = random(`${study.seed}|bootstrap|${name}|${kind}|10000`);
  const values = [];
  for (let iteration = 0; iteration < 10000; iteration += 1) {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(rng() * pairs.length)]);
    const value = contrast(sample, name, kind);
    if (value !== null) values.push(value);
  }
  values.sort((left, right) => left - right);
  return values.length ? [quantile(values, 0.025), quantile(values, 0.975)] : [null, null];
}

export function analyzeMain(input) {
  const observations = finalizeDuplicateFlags(input);
  validateEvidence(observations, "main");
  assertUniqueIdentities(observations);
  const pairs = pairRows(observations);
  assert.equal(pairs.length, study.main.plannedPairs, `main analysis requires all ${study.main.plannedPairs} started ITT pairs`);
  const ratios = Object.fromEntries(["combinedCredits", "parentCredits", "parentCumulativeInput", "parentPeakInput", "totalModelTokens", "wallMs"].map((name) => [name, { estimate: contrast(pairs, name, "ratio"), interval95: bootstrap(pairs, name, "ratio") }]));
  const differences = Object.fromEntries(["feature", "testComposite", "mutantKill", "branchCoverage", "falsePositive", "reliability", "adherence"].map((name) => [name, { estimate: contrast(pairs, name, "difference"), interval95: bootstrap(pairs, name, "difference") }]));
  const taskCreditRatios = Object.fromEntries(study.main.tasks.map((taskId) => [taskId, contrast(pairs.filter((pair) => pair.taskId === taskId), "combinedCredits", "ratio")]));
  const taskFeatureDifferences = Object.fromEntries(study.main.tasks.map((taskId) => [taskId, contrast(pairs.filter((pair) => pair.taskId === taskId), "feature", "difference")]));
  const catastrophic = pairs.some((pair) => metric(pair.A1, "feature") >= 0.9 && metric(pair.A2, "feature") < 0.5);
  const treatmentReliability = mean(pairs.map((pair) => metric(pair.A2, "reliability")));
  const treatmentAdherence = mean(pairs.map((pair) => metric(pair.A2, "adherence")));
  const threshold = study.positiveSignal;
  const finiteAtMost = (value, maximum) => Number.isFinite(value) && value <= maximum;
  const finiteAtLeast = (value, minimum) => Number.isFinite(value) && value >= minimum;
  const gates = {
    combinedCredits: finiteAtMost(ratios.combinedCredits.estimate, threshold.combinedCreditRatioMax) && Object.values(taskCreditRatios).filter((value) => finiteAtMost(value, threshold.taskCreditRatioMax)).length >= threshold.tasksMeetingCreditRatioMin,
    parentEconomics: finiteAtMost(ratios.parentCredits.estimate, threshold.parentCreditRatioMax) && finiteAtMost(ratios.parentCumulativeInput.estimate, threshold.parentCumulativeInputRatioMax) && finiteAtMost(ratios.parentPeakInput.estimate, threshold.parentPeakInputRatioMax),
    featureCorrectness: finiteAtLeast(differences.feature.estimate, threshold.featureDifferenceMin) && Object.values(taskFeatureDifferences).every((value) => finiteAtLeast(value, threshold.perTaskFeatureDifferenceMin)) && !catastrophic,
    testQuality: finiteAtLeast(differences.testComposite.estimate, threshold.testCompositeDifferenceMin) && finiteAtLeast(differences.mutantKill.estimate, threshold.mutantKillDifferenceMin) && finiteAtLeast(differences.branchCoverage.estimate, threshold.branchCoverageDifferenceMin) && finiteAtMost(differences.falsePositive.estimate, threshold.falsePositiveDifferenceMax),
    reliabilityAdherence: finiteAtLeast(treatmentReliability, threshold.treatmentReliabilityMin) && finiteAtLeast(treatmentAdherence, threshold.treatmentAdherenceMin) && finiteAtLeast(differences.reliability.estimate, threshold.reliabilityDifferenceMin),
    guardrails: finiteAtMost(ratios.totalModelTokens.estimate, threshold.totalTokenRatioMax) && finiteAtMost(ratios.wallMs.estimate, threshold.wallTimeRatioMax)
  };
  return {
    schemaVersion: 2,
    analysis: "descriptive-paired-itt",
    pairCount: pairs.length,
    ratios,
    differences,
    taskCreditRatios,
    taskFeatureDifferences,
    treatmentReliability,
    treatmentAdherence,
    catastrophic,
    gates,
    positiveSignal: Object.values(gates).every(Boolean)
  };
}

export function evaluatePilot(input) {
  const observations = finalizeDuplicateFlags(input);
  validateEvidence(observations, "pilot");
  assertUniqueIdentities(observations);
  assert.equal(observations.length, study.pilot.plannedObservations,
    `pilot requires exactly ${study.pilot.plannedObservations} observations`);
  assert.equal(new Set(observations.map((entry) => entry.observationId)).size,
    study.pilot.plannedObservations);
  assert(observations.every((entry) => entry.taskId.startsWith("P")));
  const treatment = observations.filter((entry) => entry.arm === "A2");
  const operational = observations.filter((entry) => entry.status === "complete");
  const validTreatments = treatment.filter((entry) =>
    entry.status === "complete"
    && metric(entry, "adherence") === 1
    && entry.evaluation?.tests?.goldPass
    && entry.evaluation?.tests?.visiblePass);
  const validPairs = schedule.pilot.filter((block) => {
    const pair = observations.filter((entry) => entry.blockId === block.blockId);
    return pair.length === 2
      && pair.every((entry) => entry.status === "complete")
      && validTreatments.some((entry) => entry.blockId === block.blockId);
  });
  const started = observations.filter((entry) => entry.startDisposition === "started");
  const reasons = [];
  if (operational.length < study.pilot.operationalCompletionsForGoMin) {
    reasons.push("operational completion minimum not met");
  }
  if (validPairs.length < study.pilot.validPairsForGoMin) reasons.push("valid pair minimum not met");
  if (!operational.every((entry) => metric(entry, "feature") === 1)) {
    reasons.push("operational feature correctness below 100%");
  }
  if (validTreatments.length < study.pilot.validPairsForGoMin) {
    reasons.push("insufficient adherent A2 candidate/gold test passes");
  }
  if (validTreatments.length === 0
    || mean(validTreatments.map((entry) => metric(entry, "mutantKill"))) < 0.7) {
    reasons.push("valid A2 mutant kill below 0.70");
  }
  if (validTreatments.some((entry) => metric(entry, "falsePositive") !== 0)) {
    reasons.push("valid A2 false positive against gold");
  }
  if (started.some((entry) => !Number.isFinite(entry.usage.combinedCredits)
    || !Number.isFinite(entry.usage.totalModelTokens)
    || !Number.isFinite(entry.timing.wallMs))) reasons.push("resource telemetry unavailable");
  if (started.some((entry) =>
    entry.usage.combinedCredits > study.envelope.combinedCredits
    || entry.usage.totalModelTokens > study.envelope.modelTokens
    || entry.timing.wallMs > study.envelope.wallSeconds * 1000)) {
    reasons.push("resource envelope exceeded");
  }
  const sourceManifestRootHash = readJson(path.join(root, "design", "source-manifest.json")).rootHash;
  return {
    schemaVersion: 2,
    sourceManifestRootHash,
    observations: observations.map((entry) => entry.observationId).sort(),
    operationalCompletions: operational.length,
    validPairs: validPairs.map((entry) => entry.blockId),
    validTreatments: validTreatments.map((entry) => entry.observationId),
    decision: reasons.length ? "NO-GO" : "GO",
    reasons
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  const phaseIndex = process.argv.indexOf("--phase");
  if (inputIndex < 0 || outputIndex < 0 || phaseIndex < 0) throw new Error("usage: analysis.mjs --phase pilot|main --in observations.json --out summary.json");
  const observations = readJson(path.resolve(process.argv[inputIndex + 1]));
  const result = process.argv[phaseIndex + 1] === "pilot" ? evaluatePilot(observations) : analyzeMain(observations);
  writeJson(path.resolve(process.argv[outputIndex + 1]), result);
}
