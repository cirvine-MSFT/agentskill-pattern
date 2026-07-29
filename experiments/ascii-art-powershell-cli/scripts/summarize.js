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
const {
  evaluateConditionCompliance,
  reconcileParentWaitLatency
} = require('./telemetry-integrity');

const args = parseArguments(process.argv.slice(2));
if (!args.runs || !args.artifacts || !args.judgments || !args.out) {
  console.error('Usage: summarize.js --runs DIR --artifacts DIR --judgments DIR --out FILE [--allow-incomplete]');
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
const prompts = readJson(path.join(root, 'prompts.json'));
const scheduled = schedule.blocks.flatMap((block) => block.observations);
const runFiles = loadJsonFiles(args.runs);
const artifactFiles = loadJsonFiles(args.artifacts);
const judgmentFiles = loadJsonFiles(args.judgments);

const manifests = new Map();
const telemetry = new Map();
const deterministic = new Map();
for (const { value } of runFiles) {
  if (!value || !value.runId || !value.scheduleId) continue;
  if ((value.sessions && value.condition && value.refs) ||
      value.recordType === 'pre_execution_failure') {
    manifests.set(value.runId, value);
  }
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
const missingScheduleIds = scheduled
  .filter((scheduledItem) => !selectedRuns.has(scheduledItem.scheduleId))
  .map((scheduledItem) => scheduledItem.scheduleId);
const excludedMissingSchedules = scheduled.flatMap((scheduledItem) => {
  if (!missingScheduleIds.includes(scheduledItem.scheduleId)) return [];
  const attempts = [...manifests.values()]
    .filter((manifest) => manifest.scheduleId === scheduledItem.scheduleId)
    .sort((left, right) => left.execution.attempt - right.execution.attempt);
  if (attempts.length === 0 || attempts.some((manifest) => !manifest.exclusion.excluded)) return [];
  return [{
    scheduleId: scheduledItem.scheduleId,
    condition: scheduledItem.condition,
    attempts: attempts.map((manifest) => ({
      runId: manifest.runId,
      reason: manifest.exclusion.reason
    }))
  }];
});
const allSchedulesSelected = selectedRuns.size === scheduled.length;

const assignmentByBlind = new Map(assignments.blocks.flatMap((block) => block.artifacts
  .map((item) => [item.blindId, { ...item, block: block.block }])));
const blindBundles = new Map(artifactFiles
  .map(({ value }) => value)
  .filter((value) => value && value.blindId && value.runId && value.blindBundleSha256)
  .map((value) => [value.blindId, value]));
const judgments = new Map();
const judgmentsByBlind = new Map();
for (const { value } of judgmentFiles) {
  if (value && value.blindId && assignmentByBlind.has(value.blindId)) {
    const assignment = assignmentByBlind.get(value.blindId);
    const binding = blindBundles.get(value.blindId);
    const selected = selectedRuns.get(assignment.scheduleId);
    if (!binding || !selected ||
        value.judgeBlock !== assignment.block ||
        binding.scheduleId !== assignment.scheduleId ||
        binding.judgeBlock !== assignment.block ||
        binding.runId !== selected.runId ||
        binding.sourceArtifactBundleSha256 !== selected.refs.artifactBundleSha256 ||
        value.runId !== binding.runId ||
        value.sourceArtifactBundleSha256 !== binding.sourceArtifactBundleSha256 ||
        value.blindBundleSha256 !== binding.blindBundleSha256) {
      throw new Error(`Judgment ${value.blindId} is not bound to the selected run and blind bundle.`);
    }
    judgmentsByBlind.set(value.blindId, value);
    if (!assignment.duplicateOfBlindId) {
      judgments.set(assignment.scheduleId, value);
    }
  }
  if (judgmentsByBlind.size === 66) {
    const sessionsByBlock = assignments.blocks.map((block) => {
      const sessions = new Set([...judgmentsByBlind.values()]
        .filter((judgment) => judgment.judgeBlock === block.block)
        .map((judgment) => judgment.judgeSessionId));
      if (sessions.size !== 1) {
        throw new Error(`Judge block ${block.block} must use exactly one judge session.`);
      }
      return [...sessions][0];
    });
    if (new Set(sessionsByBlock).size !== 6) {
      throw new Error('Judgments must use exactly six distinct judge sessions, one per assigned block.');
    }
    const trialSessions = new Set([...manifests.values()]
      .filter((manifest) => manifest.attempt.phase === 'session_started')
      .flatMap((manifest) => [
      manifest.execution.rootSessionId,
      manifest.execution.coordinatorSessionId,
      manifest.sessions.parent.sessionId,
      ...(manifest.condition === 'treatment' ? [manifest.sessions.specialist.sessionId] : [])
      ]));
    if (sessionsByBlock.some((sessionId) => trialSessions.has(sessionId))) {
      throw new Error('Judge sessions must be disjoint from all trial sessions.');
    }
  }
}

const structurallyMissing = scheduled.filter((item) => (
  !selectedRuns.has(item.scheduleId) ||
  !telemetry.has(selectedRuns.get(item.scheduleId)?.runId) ||
  !deterministic.has(selectedRuns.get(item.scheduleId)?.runId) ||
  !judgments.has(item.scheduleId)
));
const structurallyComplete = structurallyMissing.length === 0 &&
  judgmentsByBlind.size === 66 &&
  blindBundles.size === 66;
const emptyFoundationDryRun = manifests.size === 0 &&
  telemetry.size === 0 &&
  deterministic.size === 0 &&
  blindBundles.size === 0 &&
  judgmentsByBlind.size === 0;

if (!args['allow-incomplete']) {
  const missing = structurallyMissing;
  if (missing.length > 0) {
    throw new Error(`Dataset is incomplete: ${missing.length} of 60 scheduled observations lack a manifest, telemetry, deterministic result, or judgment.`);
  }
  if (judgmentsByBlind.size !== 66) {
    throw new Error(`Judgment dataset is incomplete: expected 66 primary and reliability records, found ${judgmentsByBlind.size}.`);
  }
  if (blindBundles.size !== 66) {
    throw new Error(`Blind bundle dataset is incomplete: expected 66 run- and hash-bound assignments, found ${blindBundles.size}.`);
  }
}

function buildRecords(scope) {
  return scheduled.flatMap((scheduledItem) => {
    const manifest = selectedRuns.get(scheduledItem.scheduleId);
    if (!manifest) return [];
    const telemetryRecord = telemetry.get(manifest.runId);
    const prompt = prompts.find((item) => item.id === manifest.promptId);
    const compliance = evaluateConditionCompliance(manifest, telemetryRecord, prompt);
    if (scope === 'perProtocol' && !compliance.compliant) return [];
    return [{
      ...scheduledItem,
      manifest,
      telemetry: telemetryRecord,
      compliance,
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
    const scale = binary ? 100 : 1;
    const scaled = (value) => value === null ? null : value * scale;
    const differences = complete.map((row) => row.difference * scale);
    const controls = complete.map((row) => row.control * scale);
    const treatments = complete.map((row) => row.treatment * scale);
    const promptIds = [...new Set(pairs.map((row) => row.promptId))].sort();
    const completePromptClusters = promptIds.filter((promptId) => (
      complete.filter((row) => row.promptId === promptId).length === 3
    )).length;
    const bootstrapEligible = allSchedulesSelected &&
      promptIds.length === 10 &&
      completePromptClusters === 10;
    const random = mulberry32(seedConfig.seed);
    const bootstrap = [];
    if (bootstrapEligible) {
      for (let draw = 0; draw < seedConfig.draws; draw += 1) {
        const sampled = [];
        for (let index = 0; index < promptIds.length; index += 1) {
          const selected = promptIds[Math.floor(random() * promptIds.length)];
          sampled.push(...complete.filter((row) => row.promptId === selected).map((row) => row.difference * scale));
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
        mean: mean(values.map((value) => value * scale))
      }];
    }));
    const promptMeans = promptIds.map((promptId) => {
      const rows = complete.filter((row) => row.promptId === promptId);
      return {
        promptId,
        completePairs: rows.length,
        controlMean: mean(rows.map((row) => row.control * scale)),
        treatmentMean: mean(rows.map((row) => row.treatment * scale)),
        meanPairedDifference: mean(rows.map((row) => row.difference * scale))
      };
    });
    const repetitionMeans = [1, 2, 3].map((repetition) => {
      const rows = complete.filter((row) => row.repetition === repetition);
      return {
        repetition,
        completePairs: rows.length,
        controlMean: mean(rows.map((row) => row.control * scale)),
        treatmentMean: mean(rows.map((row) => row.treatment * scale)),
        meanPairedDifference: mean(rows.map((row) => row.difference * scale))
      };
    });
    return {
      outcome: name,
      unit: binary ? 'percentage_points' : 'source_unit',
      completeness: {
        status: bootstrapEligible ? 'complete' : 'incomplete',
        requiredPromptClusters: 10,
        completePromptClusters,
        requiredPairsPerCluster: 3,
        completePairs: complete.length,
        inferentialOutput: bootstrapEligible ? 'available' : 'withheld'
      },
      completePairs: complete.length,
      missingPairs: 30 - complete.length,
      controlMean,
      treatmentMean,
      meanPairedDifference: mean(differences),
      medianPairedDifference: median(differences),
      percentChangeFromControl: binary || controlMean === null || controlMean === 0
        ? null
        : ((treatmentMean - controlMean) / controlMean) * 100,
      promptClusteredBootstrap95: bootstrapEligible
        ? {
          status: 'available',
          lower: percentile(bootstrap, 0.025),
          upper: percentile(bootstrap, 0.975),
          unit: binary ? 'percentage_points' : 'source_unit',
          unavailableReason: null
        }
        : {
          status: 'unavailable',
          lower: null,
          upper: null,
          unit: binary ? 'percentage_points' : 'source_unit',
          unavailableReason: 'requires all three pairs for each of the 10 preregistered prompt clusters'
        },
      missingnessByCondition: conditionAvailability,
      promptMeans,
      repetitionMeans,
      discordantCounts: binary ? {
        controlPassTreatmentFail: complete.filter((row) => row.control === 1 && row.treatment === 0).length,
        controlFailTreatmentPass: complete.filter((row) => row.control === 0 && row.treatment === 1).length,
        concordantPass: complete.filter((row) => row.control === 1 && row.treatment === 1).length,
        concordantFail: complete.filter((row) => row.control === 0 && row.treatment === 0).length
      } : null,
      pairs: complete.map((row) => binary ? {
        promptId: row.promptId,
        repetition: row.repetition,
        controlPercentagePoints: scaled(row.control),
        treatmentPercentagePoints: scaled(row.treatment),
        differencePercentagePoints: scaled(row.difference)
      } : row)
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
    'compactionEventCount',
    'compactReturnBytes',
    'wallLatencyMs',
    'parentActiveLatencyMs',
    'specialistLatencyMs',
    'parentWaitLatencyMs'
  ];
  const outcomes = telemetryNames.map((name) => summarize(name, (record) => {
    if (!record.telemetry) return null;
    if (name === 'parentWaitLatencyMs') {
      return reconcileParentWaitLatency(record.manifest, record.telemetry);
    }
    return metricValue(record.telemetry.metrics[name]);
  }));
  outcomes.push(summarize('deterministicPass', (record) => (
    !record.deterministic || record.deterministic.status === 'unavailable'
      ? null
      : Number(record.deterministic.status === 'pass')
  ), true));
  outcomes.push(summarize('overallQuality', (record) => (
    record.judgment && typeof record.judgment.overall === 'number' ? record.judgment.overall : null
  )));
  for (const dimension of ['function', 'codeQuality', 'integration', 'recognizability', 'composition', 'cleanliness']) {
    outcomes.push(summarize(`rubric.${dimension}`, (record) => (
      record.judgment && record.judgment.scores ? record.judgment.scores[dimension] : null
    )));
  }

  function availabilitySummary(metrics) {
    const available = metrics.filter((metric) => metric && metric.status === 'available');
    return {
      records: metrics.length,
      available: available.length,
      unavailable: metrics.filter((metric) => metric && metric.status === 'unavailable').length,
      notApplicable: metrics.filter((metric) => metric && metric.status === 'not_applicable').length,
      missing: metrics.filter((metric) => !metric).length,
      mean: mean(available.map((metric) => metric.value))
    };
  }

  function secondaryByCondition(condition) {
    const conditionRecords = records.filter((record) => record.condition === condition && record.telemetry);
    const modelMetricNames = ['aiCredits', 'nanoAiu', 'inputTokens', 'peakInputTokens', 'outputTokens', 'cachedTokens'];
    const modelKeys = [...new Set(conditionRecords.flatMap((record) => record.telemetry.models)
      .map((model) => `${model.role}:${model.observedModel}`))].sort();
    const models = Object.fromEntries(modelKeys.map((key) => {
      const [role, observedModel] = key.split(':');
      const matching = conditionRecords.flatMap((record) => record.telemetry.models)
        .filter((model) => model.role === role && model.observedModel === observedModel);
      return [key, Object.fromEntries(modelMetricNames.map((metricName) => [
        metricName,
        availabilitySummary(matching.map((model) => model[metricName]))
      ]))];
    }));
    const tools = conditionRecords.flatMap((record) => record.telemetry.tools);
    const exposedToolNames = [...new Set(conditionRecords.flatMap((record) => record.telemetry.exposedTools))].sort();
    const toolNames = [...new Set(tools.map((tool) => tool.name))].sort();
    const toolEvents = Object.fromEntries(toolNames.map((name) => {
      const matching = tools.filter((tool) => tool.name === name);
      const durations = matching.flatMap((tool) => {
        if (!tool.startedAt || !tool.completedAt) return [];
        return [Date.parse(tool.completedAt) - Date.parse(tool.startedAt)];
      }).filter((duration) => Number.isFinite(duration) && duration >= 0);
      return [name, {
        calls: matching.length,
        succeeded: matching.filter((tool) => tool.success === true).length,
        failed: matching.filter((tool) => tool.success === false).length,
        successUnavailable: matching.filter((tool) => tool.success === null).length,
        resultBytes: availabilitySummary(matching.map((tool) => tool.resultBytes)),
        durationMs: {
          available: durations.length,
          unavailable: matching.length - durations.length,
          mean: mean(durations)
        }
      }];
    }));
    const compaction = conditionRecords.flatMap((record) => record.telemetry.compaction);
    const routingStatuses = ['available', 'unavailable', 'not_applicable'];
    return {
      observations: conditionRecords.length,
      models,
      aggregateToolMetrics: Object.fromEntries(['exposedToolCount', 'toolCallCount', 'toolResultCount']
        .map((name) => [name, availabilitySummary(conditionRecords.map((record) => record.telemetry.metrics[name]))])),
      exposedTools: Object.fromEntries(exposedToolNames.map((name) => [
        name,
        conditionRecords.filter((record) => record.telemetry.exposedTools.includes(name)).length
      ])),
      toolEvents,
      compaction: {
        events: compaction.length,
        observationsWithEvents: conditionRecords.filter((record) => record.telemetry.compaction.length > 0).length,
        aggregateEventCount: availabilitySummary(conditionRecords.map((record) => record.telemetry.metrics.compactionEventCount)),
        returnBytes: availabilitySummary(compaction.map((event) => event.returnBytes)),
        aggregateCompactReturnBytes: availabilitySummary(conditionRecords.map((record) => record.telemetry.metrics.compactReturnBytes))
      },
      routingEvidence: {
        delegationStatus: Object.fromEntries(routingStatuses.map((status) => [
          status,
          conditionRecords.filter((record) => record.telemetry.routing.delegationEvidence.status === status).length
        ])),
        parentSourceEventReferences: conditionRecords.reduce((sum, record) => sum + record.telemetry.routing.parent.sourceEventIds.length, 0),
        specialistSourceEventReferences: conditionRecords.reduce((sum, record) => (
          sum + (record.telemetry.routing.specialist.sourceEventIds?.length || 0)
        ), 0)
      },
      unavailableCounts: {
        aggregateMetrics: Object.fromEntries(Object.keys(conditionRecords[0]?.telemetry.metrics || {}).map((name) => [
          name,
          conditionRecords.filter((record) => record.telemetry.metrics[name].status === 'unavailable').length
        ])),
        modelMetrics: modelMetricNames.reduce((sum, name) => (
          sum + conditionRecords.flatMap((record) => record.telemetry.models)
            .filter((model) => model[name].status === 'unavailable').length
        ), 0),
        toolResultBytes: tools.filter((tool) => tool.resultBytes.status === 'unavailable').length,
        compactionReturnBytes: compaction.filter((event) => event.returnBytes.status === 'unavailable').length,
        routingEvidence: conditionRecords.filter((record) => record.telemetry.routing.delegationEvidence.status === 'unavailable').length
      }
    };
  }

  return {
    observationsIncluded: records.length,
    completeAssignedPairs: pairs.filter((pair) => pair.control && pair.treatment).length,
    validatedConditionCompliance: {
      compliant: records.filter((record) => record.compliance.compliant).length,
      noncompliant: records.filter((record) => !record.compliance.compliant).length,
      reasons: Object.fromEntries([...new Set(records.flatMap((record) => record.compliance.reasons))]
        .sort()
        .map((reason) => [
          reason,
          records.filter((record) => record.compliance.reasons.includes(reason)).length
        ]))
    },
    secondaryTelemetry: {
      control: secondaryByCondition('control'),
      treatment: secondaryByCondition('treatment')
    },
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
    blindBundles: blindBundles.size,
    judgments: judgments.size,
    completeness: {
      status: structurallyComplete
        ? 'complete'
        : (emptyFoundationDryRun ? 'empty_foundation_dry_run' : 'incomplete'),
      structurallyMissingObservations: structurallyMissing.length,
      missingScheduleIds,
      excludedMissingSchedules,
      inferentialOutputRequiresCompleteOutcomeClusters: true
    }
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
