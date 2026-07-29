#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { readJson, root } = require('./lib');
const { validateSchema } = require('./validate-schema');
const {
  completePromptClusters,
  conditionErrors,
  deterministicConsistencyErrors,
  deterministicPassValue,
  judgeBindingErrors,
  metricSemanticErrors
} = require('./integrity');

const constants = readJson(path.join(root, 'design', 'conditions.json'));
const deterministicSchema = readJson(path.join(root, 'schemas', 'deterministic-results.schema.json'));
const telemetrySchema = readJson(path.join(root, 'schemas', 'raw-telemetry.schema.json'));
const judgmentSchema = readJson(path.join(root, 'schemas', 'judgment.schema.json'));
let assertions = 0;

function rejects(errors, message) {
  assert(errors.length > 0, message);
  assertions += 1;
}

function accepts(errors, message) {
  assert.deepStrictEqual(errors, [], message);
  assertions += 1;
}

function metric(status = 'available', value = 1) {
  return {
    status,
    value: status === 'available' ? value : null,
    unit: 'count',
    source: status === 'available' ? 'event:test' : null,
    unavailableReason: status === 'available' ? null : 'not exposed'
  };
}

function makeConditionPair(condition = 'treatment') {
  const specialist = condition === 'treatment'
    ? { sessionId: 'specialist-1', requestedModel: constants.specialistModel, observedModel: constants.specialistModel }
    : { status: 'not_applicable', reason: 'control_condition' };
  const manifest = {
    runId: `P01-R1-${condition}-A1`,
    condition,
    conditionInstruction: constants.conditions[condition].instruction,
    sessions: {
      parent: { sessionId: 'parent-1', requestedModel: constants.parentModel, observedModel: constants.parentModel },
      specialist
    },
    exclusion: { excluded: false, reason: null }
  };
  const telemetry = {
    routing: {
      parent: {
        sessionId: 'parent-1',
        requestedModel: constants.parentModel,
        observedModel: constants.parentModel,
        sourceEventIds: ['parent-event']
      },
      specialist: condition === 'treatment'
        ? {
            sessionId: 'specialist-1',
            requestedModel: constants.specialistModel,
            observedModel: constants.specialistModel,
            sourceEventIds: ['specialist-event']
          }
        : { status: 'not_applicable', reason: 'control_condition' },
      delegationEvidence: condition === 'treatment'
        ? { status: 'available' }
        : { status: 'not_applicable' }
    },
    models: [
      {
        role: 'parent',
        sessionId: 'parent-1',
        requestedModel: constants.parentModel,
        observedModel: constants.parentModel
      },
      ...(condition === 'treatment'
        ? [{
            role: 'specialist',
            sessionId: 'specialist-1',
            requestedModel: constants.specialistModel,
            observedModel: constants.specialistModel
          }]
        : [])
    ]
  };
  return { manifest, telemetry };
}

accepts(metricSemanticErrors(metric(), 'metric'), 'valid available metric should pass');
rejects(metricSemanticErrors({ ...metric(), value: null }, 'metric'), 'available metric with null value must fail');
rejects(metricSemanticErrors({ ...metric('unavailable'), unavailableReason: null }, 'metric'), 'unavailable metric without reason must fail');

const passGroup = { status: 'pass', assertions: [] };
const failGroup = { status: 'fail', assertions: [] };
const unavailableGroup = { status: 'unavailable', assertions: [] };
const deterministicBase = {
  protocolId: 'ascii-art-powershell-cli-v1',
  runId: 'P01-R1-control-A1',
  scheduleId: 'P01-R1-control',
  promptId: 'P01',
  status: 'pass',
  functional: passGroup,
  art: passGroup,
  tamperCheck: passGroup,
  startedAt: '2026-07-28T00:00:00Z',
  completedAt: '2026-07-28T00:01:00Z'
};
accepts(deterministicConsistencyErrors(deterministicBase), 'consistent deterministic pass should pass');
rejects(deterministicConsistencyErrors({ ...deterministicBase, art: failGroup }), 'top-level pass with failed child must fail');
rejects(validateSchema({ ...deterministicBase, art: failGroup }, deterministicSchema), 'schema must reject top-level pass with failed child');
assert.strictEqual(deterministicPassValue({ ...deterministicBase, status: 'unavailable', art: unavailableGroup }), null);
assertions += 1;

const validCondition = makeConditionPair();
accepts(conditionErrors(validCondition.manifest, validCondition.telemetry, constants), 'registered treatment condition should pass');
const badInstruction = makeConditionPair();
badInstruction.manifest.conditionInstruction = 'Different instruction';
rejects(conditionErrors(badInstruction.manifest, badInstruction.telemetry, constants), 'wrong condition instruction must fail');
badInstruction.manifest.exclusion = { excluded: true, reason: 'condition_mismatch' };
accepts(conditionErrors(badInstruction.manifest, badInstruction.telemetry, constants), 'explicit condition-mismatch exclusion should pass integrity validation');
const badParent = makeConditionPair();
badParent.manifest.sessions.parent.observedModel = 'wrong-model';
rejects(conditionErrors(badParent.manifest, badParent.telemetry, constants), 'wrong parent model must fail');
badParent.manifest.exclusion = { excluded: true, reason: 'wrong_model' };
accepts(conditionErrors(badParent.manifest, badParent.telemetry, constants), 'explicit wrong-model exclusion should pass integrity validation');
const missingSpecialist = makeConditionPair();
missingSpecialist.telemetry.models = missingSpecialist.telemetry.models.filter((model) => model.role !== 'specialist');
rejects(conditionErrors(missingSpecialist.manifest, missingSpecialist.telemetry, constants), 'missing treatment specialist split must fail');

const promptIds = Array.from({ length: 10 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`);
const completeRows = promptIds.flatMap((promptId) => [1, 2, 3].map((repetition) => ({ promptId, repetition })));
assert.strictEqual(completePromptClusters(completeRows, promptIds).eligible, true);
assert.strictEqual(completePromptClusters(completeRows.slice(0, -1), promptIds).eligible, false);
assertions += 2;

function makeJudgeData() {
  const hash = 'a'.repeat(64);
  const materialized = [];
  const staticAssignments = [];
  const selectedRuns = new Map();
  const artifacts = [];
  const bundles = [];
  const judgments = [];
  for (let block = 1; block <= 6; block += 1) {
    const promptId = `P${String(block).padStart(2, '0')}`;
    const scheduleId = `${promptId}-R1-control`;
    const runId = `${scheduleId}-A1`;
    const blindId = `B${String(block).padStart(4, '0')}`;
    const judgeSessionId = `judge-${block}`;
    staticAssignments.push({
      blindId,
      block,
      scheduleId,
      promptId,
      presentationPosition: 1,
      duplicateOfBlindId: null
    });
    selectedRuns.set(scheduleId, { runId });
    artifacts.push({ runId, bundleSha256: hash });
    materialized.push({
      blindId,
      block,
      scheduleId,
      promptId,
      presentationPosition: 1,
      duplicateOfBlindId: null,
      selectedRunId: runId,
      artifactBundleSha256: hash,
      blindBundleSha256: hash,
      judgeSessionId
    });
    bundles.push({ blindId, selectedRunId: runId, artifactBundleSha256: hash, blindBundleSha256: hash });
    judgments.push({
      blindId,
      block,
      scheduleId,
      selectedRunId: runId,
      artifactBundleSha256: hash,
      blindBundleSha256: hash,
      judgeSessionId,
      judgeModel: constants.judgeModel
    });
  }
  return { materialized, staticAssignments, selectedRuns, artifacts, bundles, judgments };
}

const judgeData = makeJudgeData();
accepts(judgeBindingErrors(...Object.values(judgeData), constants), 'valid judge bindings should pass');
const staleRun = makeJudgeData();
staleRun.materialized[0].selectedRunId = 'P01-R1-control-A2';
rejects(judgeBindingErrors(...Object.values(staleRun), constants), 'judgment assignment from replaced retry must fail');
const staleHash = makeJudgeData();
staleHash.judgments[0].artifactBundleSha256 = 'b'.repeat(64);
rejects(judgeBindingErrors(...Object.values(staleHash), constants), 'judgment with stale artifact hash must fail');
const reusedJudge = makeJudgeData();
reusedJudge.materialized[1].judgeSessionId = 'judge-1';
reusedJudge.judgments[1].judgeSessionId = 'judge-1';
rejects(judgeBindingErrors(...Object.values(reusedJudge), constants), 'judge session reused across blocks must fail');

const completeJudgment = {
  protocolId: 'ascii-art-powershell-cli-v1',
  blindId: 'B0001',
  block: 1,
  scheduleId: 'P01-R1-control',
  selectedRunId: 'P01-R1-control-A1',
  artifactBundleSha256: 'a'.repeat(64),
  blindBundleSha256: 'b'.repeat(64),
  judgeSessionId: 'judge-1',
  judgeModel: constants.judgeModel,
  scores: {
    function: 3,
    codeQuality: 3,
    integration: 3,
    recognizability: 3,
    composition: 3,
    cleanliness: 3
  },
  overall: 3,
  rationale: 'Evidence',
  duplicateOf: null
};
accepts(validateSchema(completeJudgment, judgmentSchema), 'complete judgment provenance should satisfy schema');
const incompleteJudgment = { ...completeJudgment };
delete incompleteJudgment.selectedRunId;
rejects(validateSchema(incompleteJudgment, judgmentSchema), 'judgment without selected run ID must fail');

const metricSchema = telemetrySchema.$defs.metric;
rejects(validateSchema({ ...metric(), value: null }, metricSchema), 'metric schema must reject available null value');
rejects(validateSchema({ ...metric('unavailable'), unavailableReason: null }, metricSchema), 'metric schema must reject unavailable without reason');
const delegationSchema = telemetrySchema.properties.routing.properties.delegationEvidence;
rejects(validateSchema({
  status: 'available',
  callEventId: null,
  resultEventId: null,
  requestedAt: null,
  returnedAt: null,
  unavailableReason: null
}, delegationSchema, telemetrySchema), 'available delegation evidence must require event IDs and timestamps');
accepts(validateSchema({
  status: 'available',
  callEventId: 'call-1',
  resultEventId: 'result-1',
  requestedAt: '2026-07-28T00:00:00Z',
  returnedAt: '2026-07-28T00:00:01Z',
  unavailableReason: null
}, delegationSchema, telemetrySchema), 'complete available delegation evidence should pass');

console.log(`PASS: ${assertions} targeted integrity regression assertions`);
