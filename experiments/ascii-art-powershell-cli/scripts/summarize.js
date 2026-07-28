#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  mulberry32,
  parseArguments,
  readJson,
  root,
  walkFiles,
  writeJson
} = require('./lib');

const args = parseArguments(process.argv.slice(2));
if (!args.runs || !args.judgments || !args.out) {
  console.error('Usage: summarize.js --runs DIR --judgments DIR --out FILE [--allow-incomplete]');
  process.exit(2);
}

function loadJsonFiles(directory) {
  return walkFiles(path.resolve(directory))
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => ({ file, value: readJson(file) }));
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function metricValue(metric) {
  return metric && metric.status === 'available' && typeof metric.value === 'number'
    ? metric.value
    : null;
}

const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const seedConfig = readJson(path.join(root, 'design', 'seed.json')).bootstrap;
const scheduled = schedule.blocks.flatMap((block) => block.observations);
const runFiles = loadJsonFiles(args.runs);
const judgmentFiles = loadJsonFiles(args.judgments);

const manifests = new Map();
const telemetry = new Map();
const deterministic = new Map();
for (const { value } of runFiles) {
  if (!value || !value.runId || !value.scheduleId) continue;
  if (value.sessions && value.condition && value.refs) manifests.set(value.runId, value);
  if (value.metrics && value.routing && value.models) telemetry.set(value.runId, value);
  if (value.functional && value.art && value.tamperCheck) deterministic.set(value.runId, value);
}

const selectedRuns = new Map();
for (const scheduledItem of scheduled) {
  const attempts = [...manifests.values()]
    .filter((manifest) => manifest.scheduleId === scheduledItem.scheduleId)
    .sort((left, right) => right.execution.attempt - left.execution.attempt);
  const selected = attempts.find((manifest) => !manifest.exclusion.excluded);
  if (selected) selectedRuns.set(scheduledItem.scheduleId, selected);
}

const assignmentByBlind = new Map(assignments.blocks.flatMap((block) => block.artifacts)
  .map((item) => [item.blindId, item]));
const judgments = new Map();
const judgmentsByBlind = new Map();
for (const { value } of judgmentFiles) {
  if (value && value.blindId && assignmentByBlind.has(value.blindId)) {
    const assignment = assignmentByBlind.get(value.blindId);
    judgmentsByBlind.set(value.blindId, value);
    if (!assignment.duplicateOfBlindId) {
      judgments.set(assignment.scheduleId, value);
    }
  }
}

if (!args['allow-incomplete']) {
  const missing = scheduled.filter((item) => (
    !selectedRuns.has(item.scheduleId) ||
    !telemetry.has(selectedRuns.get(item.scheduleId)?.runId) ||
    !deterministic.has(selectedRuns.get(item.scheduleId)?.runId) ||
    !judgments.has(item.scheduleId)
  ));
  if (missing.length > 0) {
    throw new Error(`Dataset is incomplete: ${missing.length} of 60 scheduled observations lack a manifest, telemetry, deterministic result, or judgment.`);
  }
  if (judgmentsByBlind.size !== 66) {
    throw new Error(`Judgment dataset is incomplete: expected 66 primary and reliability records, found ${judgmentsByBlind.size}.`);
  }
}

function buildRecords(scope) {
  return scheduled.flatMap((scheduledItem) => {
    const manifest = selectedRuns.get(scheduledItem.scheduleId);
    if (!manifest) return [];
    if (scope === 'perProtocol' && manifest.conditionCompliance && !manifest.conditionCompliance.compliant) return [];
    return [{
      ...scheduledItem,
      manifest,
      telemetry: telemetry.get(manifest.runId),
      deterministic: deterministic.get(manifest.runId),
      judgment: judgments.get(scheduledItem.scheduleId)
    }];
  });
}

function analyzeScope(records) {
  const recordMap = new Map(records.map((record) => [record.scheduleId, record]));
  const pairs = [];
  for (const promptId of [...new Set(scheduled.map((item) => item.promptId))]) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const controlId = `${promptId}-R${repetition}-control`;
      const treatmentId = `${promptId}-R${repetition}-treatment`;
      pairs.push({
        promptId,
        repetition,
        control: recordMap.get(controlId),
        treatment: recordMap.get(treatmentId)
      });
    }
  }

  function summarize(name, getter, binary = false) {
    const complete = pairs.flatMap((pair) => {
      if (!pair.control || !pair.treatment) return [];
      const control = getter(pair.control);
      const treatment = getter(pair.treatment);
      if (typeof control !== 'number' || typeof treatment !== 'number') return [];
      return [{ promptId: pair.promptId, repetition: pair.repetition, control, treatment, difference: treatment - control }];
    });
    const differences = complete.map((row) => row.difference);
    const controls = complete.map((row) => row.control);
    const treatments = complete.map((row) => row.treatment);
    const promptIds = [...new Set(complete.map((row) => row.promptId))].sort();
    const random = mulberry32(seedConfig.seed);
    const bootstrap = [];
    if (promptIds.length > 0) {
      for (let draw = 0; draw < seedConfig.draws; draw += 1) {
        const sampled = [];
        for (let index = 0; index < promptIds.length; index += 1) {
          const selected = promptIds[Math.floor(random() * promptIds.length)];
          sampled.push(...complete.filter((row) => row.promptId === selected).map((row) => row.difference));
        }
        bootstrap.push(mean(sampled));
      }
      bootstrap.sort((left, right) => left - right);
    }
    const controlMean = mean(controls);
    const treatmentMean = mean(treatments);
    const conditionAvailability = Object.fromEntries(['control', 'treatment'].map((condition) => {
      const conditionRecords = records.filter((record) => record.condition === condition);
      const values = conditionRecords.map(getter).filter((value) => typeof value === 'number');
      return [condition, {
        scheduled: 30,
        includedRecords: conditionRecords.length,
        available: values.length,
        missingOrUnavailable: 30 - values.length,
        mean: mean(values)
      }];
    }));
    const promptMeans = promptIds.map((promptId) => {
      const rows = complete.filter((row) => row.promptId === promptId);
      return {
        promptId,
        completePairs: rows.length,
        controlMean: mean(rows.map((row) => row.control)),
        treatmentMean: mean(rows.map((row) => row.treatment)),
        meanPairedDifference: mean(rows.map((row) => row.difference))
      };
    });
    const repetitionMeans = [1, 2, 3].map((repetition) => {
      const rows = complete.filter((row) => row.repetition === repetition);
      return {
        repetition,
        completePairs: rows.length,
        controlMean: mean(rows.map((row) => row.control)),
        treatmentMean: mean(rows.map((row) => row.treatment)),
        meanPairedDifference: mean(rows.map((row) => row.difference))
      };
    });
    return {
      outcome: name,
      completePairs: complete.length,
      missingPairs: 30 - complete.length,
      controlMean,
      treatmentMean,
      meanPairedDifference: mean(differences),
      medianPairedDifference: median(differences),
      percentChangeFromControl: controlMean === null || controlMean === 0
        ? null
        : ((treatmentMean - controlMean) / controlMean) * 100,
      promptClusteredBootstrap95: bootstrap.length === 0
        ? { lower: null, upper: null }
        : { lower: percentile(bootstrap, 0.025), upper: percentile(bootstrap, 0.975) },
      missingnessByCondition: conditionAvailability,
      promptMeans,
      repetitionMeans,
      discordantCounts: binary ? {
        controlPassTreatmentFail: complete.filter((row) => row.control === 1 && row.treatment === 0).length,
        controlFailTreatmentPass: complete.filter((row) => row.control === 0 && row.treatment === 1).length,
        concordantPass: complete.filter((row) => row.control === 1 && row.treatment === 1).length,
        concordantFail: complete.filter((row) => row.control === 0 && row.treatment === 0).length
      } : null,
      pairs: complete
    };
  }

  const telemetryNames = [
    'totalSessionAiCredits',
    'totalSessionNanoAiu',
    'parentNanoAiu',
    'parentCumulativeInputTokens',
    'parentPeakInputTokens',
    'parentOutputTokens',
    'specialistCumulativeInputTokens',
    'specialistPeakInputTokens',
    'specialistOutputTokens',
    'exposedToolCount',
    'toolCallCount',
    'toolResultCount',
    'compactReturnBytes',
    'wallLatencyMs',
    'parentActiveLatencyMs',
    'specialistLatencyMs',
    'parentWaitLatencyMs'
  ];
  const outcomes = telemetryNames.map((name) => summarize(name, (record) => (
    record.telemetry ? metricValue(record.telemetry.metrics[name]) : null
  )));
  outcomes.push(summarize('deterministicPass', (record) => (
    record.deterministic ? Number(record.deterministic.status === 'pass') : null
  ), true));
  outcomes.push(summarize('overallQuality', (record) => (
    record.judgment && typeof record.judgment.overall === 'number' ? record.judgment.overall : null
  )));
  for (const dimension of ['function', 'codeQuality', 'integration', 'recognizability', 'composition', 'cleanliness']) {
    outcomes.push(summarize(`rubric.${dimension}`, (record) => (
      record.judgment && record.judgment.scores ? record.judgment.scores[dimension] : null
    )));
  }

  return {
    observationsIncluded: records.length,
    completeAssignedPairs: pairs.filter((pair) => pair.control && pair.treatment).length,
    outcomes
  };
}

const output = {
  protocolId: 'ascii-art-powershell-cli-v1',
  generatedAt: new Date().toISOString(),
  analysis: {
    pairing: 'promptId + repetition',
    bootstrap: {
      seed: seedConfig.seed,
      draws: seedConfig.draws,
      cluster: seedConfig.cluster,
      interval: 'percentile 95%'
    }
  },
  dataset: {
    scheduled: 60,
    runAttempts: manifests.size,
    selectedRuns: selectedRuns.size,
    telemetryRecords: telemetry.size,
    deterministicResults: deterministic.size,
    judgments: judgments.size
  },
  judgeReliability: (() => {
    const dimensions = ['function', 'codeQuality', 'integration', 'recognizability', 'composition', 'cleanliness'];
    const comparisons = assignments.blocks.flatMap((block) => block.artifacts)
      .filter((item) => item.duplicateOfBlindId)
      .flatMap((item) => {
        const primary = judgmentsByBlind.get(item.duplicateOfBlindId);
        const duplicate = judgmentsByBlind.get(item.blindId);
        if (!primary || !duplicate) return [];
        return dimensions.map((dimension) => ({
          primaryBlindId: item.duplicateOfBlindId,
          duplicateBlindId: item.blindId,
          dimension,
          difference: duplicate.scores[dimension] - primary.scores[dimension]
        }));
      });
    return {
      comparedDimensionScores: comparisons.length,
      exactAgreementRate: comparisons.length === 0
        ? null
        : comparisons.filter((item) => item.difference === 0).length / comparisons.length,
      withinOneAgreementRate: comparisons.length === 0
        ? null
        : comparisons.filter((item) => Math.abs(item.difference) <= 1).length / comparisons.length
    };
  })(),
  intentToTreat: analyzeScope(buildRecords('intentToTreat')),
  perProtocol: analyzeScope(buildRecords('perProtocol'))
};

writeJson(path.resolve(args.out), output);
console.log(`WROTE: ${path.resolve(args.out)}`);
