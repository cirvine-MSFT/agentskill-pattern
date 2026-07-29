'use strict';

function metricSemanticErrors(metric, location) {
  const errors = [];
  if (!metric || typeof metric !== 'object') return [`${location} must be a metric object`];
  if (metric.status === 'available') {
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) errors.push(`${location} available metric requires a finite numeric value`);
    if (typeof metric.source !== 'string' || metric.source.length === 0) errors.push(`${location} available metric requires a source`);
    if (metric.unavailableReason !== null) errors.push(`${location} available metric requires null unavailableReason`);
  } else if (metric.status === 'unavailable') {
    if (metric.value !== null) errors.push(`${location} unavailable metric requires null value`);
    if (typeof metric.unavailableReason !== 'string' || metric.unavailableReason.length === 0) errors.push(`${location} unavailable metric requires a reason`);
  } else if (metric.status === 'not_applicable') {
    if (metric.value !== null) errors.push(`${location} not_applicable metric requires null value`);
  } else {
    errors.push(`${location} has invalid metric status`);
  }
  return errors;
}

function telemetryMetricErrors(telemetry) {
  const errors = [];
  Object.entries(telemetry.metrics || {}).forEach(([name, metric]) => {
    errors.push(...metricSemanticErrors(metric, `metrics.${name}`));
  });
  (telemetry.models || []).forEach((model, index) => {
    for (const name of ['aiCredits', 'nanoAiu', 'inputTokens', 'peakInputTokens', 'outputTokens', 'cachedTokens']) {
      errors.push(...metricSemanticErrors(model[name], `models[${index}].${name}`));
    }
  });
  (telemetry.tools || []).forEach((tool, index) => {
    errors.push(...metricSemanticErrors(tool.resultBytes, `tools[${index}].resultBytes`));
  });
  (telemetry.compaction || []).forEach((event, index) => {
    errors.push(...metricSemanticErrors(event.returnBytes, `compaction[${index}].returnBytes`));
  });
  return errors;
}

function deterministicConsistencyErrors(result) {
  const groups = ['functional', 'art', 'tamperCheck'].map((name) => result[name]?.status);
  const expected = groups.includes('unavailable')
    ? 'unavailable'
    : (groups.includes('fail') ? 'fail' : 'pass');
  return result.status === expected
    ? []
    : [`deterministic status ${result.status} is inconsistent with child groups; expected ${expected}`];
}

function deterministicPassValue(result) {
  if (!result || result.status === 'unavailable') return null;
  return Number(result.status === 'pass');
}

function conditionErrors(manifest, telemetry, constants) {
  const errors = [];
  const expectedInstruction = constants.conditions[manifest.condition]?.instruction;
  const instructionValid = manifest.conditionInstruction === expectedInstruction;
  if (!instructionValid && !(manifest.exclusion.excluded && manifest.exclusion.reason === 'condition_mismatch')) {
    errors.push(`${manifest.runId} condition instruction does not match the registered ${manifest.condition} instruction`);
  }

  const parent = manifest.sessions.parent;
  const parentRouting = telemetry.routing.parent;
  const parentModels = telemetry.models.filter((model) => model.role === 'parent');
  const parentModel = parentModels[0];
  const parentValid = parentModels.length === 1 &&
    parent.requestedModel === constants.parentModel &&
    parent.observedModel === constants.parentModel &&
    parentRouting.requestedModel === constants.parentModel &&
    parentRouting.observedModel === constants.parentModel &&
    parentModel?.requestedModel === constants.parentModel &&
    parentModel?.observedModel === constants.parentModel &&
    parentModel?.sessionId === parent.sessionId;
  if (!parentValid && !(manifest.exclusion.excluded && manifest.exclusion.reason === 'wrong_model')) {
    errors.push(`${manifest.runId} parent model provenance does not match ${constants.parentModel}`);
  }
  if (parentModels.length !== 1) errors.push(`${manifest.runId} telemetry requires exactly one parent model split`);

  const specialists = telemetry.models.filter((model) => model.role === 'specialist');
  if (manifest.condition === 'treatment') {
    const specialist = manifest.sessions.specialist;
    const routing = telemetry.routing.specialist;
    const model = specialists[0];
    const specialistValid = specialists.length === 1 &&
      specialist.requestedModel === constants.specialistModel &&
      specialist.observedModel === constants.specialistModel &&
      routing.requestedModel === constants.specialistModel &&
      routing.observedModel === constants.specialistModel &&
      model?.requestedModel === constants.specialistModel &&
      model?.observedModel === constants.specialistModel &&
      model?.sessionId === specialist.sessionId &&
      routing.sessionId === specialist.sessionId &&
      telemetry.routing.delegationEvidence.status === 'available';
    if (!specialistValid && !(manifest.exclusion.excluded && manifest.exclusion.reason === 'wrong_model')) {
      errors.push(`${manifest.runId} treatment specialist provenance does not match ${constants.specialistModel}`);
    }
  } else if (
    specialists.length !== 0 ||
    manifest.sessions.specialist.status !== 'not_applicable' ||
    telemetry.routing.specialist.status !== 'not_applicable' ||
    telemetry.routing.delegationEvidence.status !== 'not_applicable'
  ) {
    errors.push(`${manifest.runId} control must not contain specialist routing or model data`);
  }
  return errors;
}

function completePromptClusters(rows, expectedPromptIds) {
  const complete = expectedPromptIds.filter((promptId) => (
    rows.filter((row) => row.promptId === promptId).length === 3
  ));
  return {
    complete,
    eligible: complete.length === expectedPromptIds.length,
    reason: complete.length === expectedPromptIds.length
      ? null
      : `requires all ${expectedPromptIds.length} prompt clusters with three complete pairs; found ${complete.length}`
  };
}

function judgeBindingErrors(materialized, staticAssignments, selectedRuns, artifacts, bundles, judgments, constants) {
  const errors = [];
  const staticByBlind = new Map(staticAssignments.map((item) => [item.blindId, item]));
  const artifactByRun = new Map(artifacts.map((item) => [item.runId, item]));
  const bundleByBlind = new Map(bundles.map((item) => [item.blindId, item]));
  const judgmentByBlind = new Map(judgments.map((item) => [item.blindId, item]));
  const sessionsByBlock = new Map();

  for (const assignment of materialized) {
    const design = staticByBlind.get(assignment.blindId);
    const selected = selectedRuns.get(assignment.scheduleId);
    const artifact = artifactByRun.get(assignment.selectedRunId);
    const bundle = bundleByBlind.get(assignment.blindId);
    const judgment = judgmentByBlind.get(assignment.blindId);
    if (!design || design.block !== assignment.block || design.scheduleId !== assignment.scheduleId) {
      errors.push(`${assignment.blindId} materialized assignment does not match preregistered design`);
    } else if (
      design.promptId !== assignment.promptId ||
      design.presentationPosition !== assignment.presentationPosition ||
      (design.duplicateOfBlindId || null) !== assignment.duplicateOfBlindId
    ) {
      errors.push(`${assignment.blindId} materialized presentation metadata does not match preregistered design`);
    }
    if (!selected || assignment.selectedRunId !== selected.runId) {
      errors.push(`${assignment.blindId} is not bound to the selected non-excluded run`);
    }
    if (!artifact || assignment.artifactBundleSha256 !== artifact.bundleSha256) {
      errors.push(`${assignment.blindId} artifact bundle hash does not match the selected run artifact`);
    }
    if (!bundle ||
      bundle.selectedRunId !== assignment.selectedRunId ||
      bundle.artifactBundleSha256 !== assignment.artifactBundleSha256 ||
      bundle.blindBundleSha256 !== assignment.blindBundleSha256) {
      errors.push(`${assignment.blindId} blind bundle provenance does not match assignment`);
    }
    if (!judgment ||
      judgment.block !== assignment.block ||
      judgment.scheduleId !== assignment.scheduleId ||
      judgment.selectedRunId !== assignment.selectedRunId ||
      judgment.artifactBundleSha256 !== assignment.artifactBundleSha256 ||
      judgment.blindBundleSha256 !== assignment.blindBundleSha256 ||
      judgment.judgeSessionId !== assignment.judgeSessionId ||
      judgment.judgeModel !== constants.judgeModel) {
      errors.push(`${assignment.blindId} judgment provenance does not match assignment`);
    }
    if (!sessionsByBlock.has(assignment.block)) sessionsByBlock.set(assignment.block, new Set());
    sessionsByBlock.get(assignment.block).add(assignment.judgeSessionId);
  }
  if (sessionsByBlock.size !== 6 ||
    [...sessionsByBlock.values()].some((sessions) => sessions.size !== 1) ||
    new Set([...sessionsByBlock.values()].map((sessions) => [...sessions][0])).size !== 6) {
    errors.push('judge isolation requires exactly six distinct session IDs, one per block');
  }
  return errors;
}

module.exports = {
  completePromptClusters,
  conditionErrors,
  deterministicConsistencyErrors,
  deterministicPassValue,
  judgeBindingErrors,
  metricSemanticErrors,
  telemetryMetricErrors
};
