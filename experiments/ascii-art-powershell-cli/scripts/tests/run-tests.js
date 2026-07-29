#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  conditionInstructions,
  parentModel,
  protocolId,
  readJson,
  root,
  sha256,
  sha256File,
  specialistModel,
  writeJson
} = require('../lib');
const { validateSchema } = require('../validate-schema');

const scriptRoot = path.join(root, 'scripts');
const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const cases = readJson(path.join(__dirname, 'fixtures', 'integrity-cases.json'));
const observations = schedule.blocks.flatMap((block) => block.observations.map((item) => ({
  ...item,
  block: block.block
})));
const hash64 = (value) => sha256(Buffer.from(value, 'utf8'));
const gitSha = 'a'.repeat(40);
const fixtureHash = sha256File(path.join(root, 'fixture', 'fixture-lock.json'));
const promptsHash = sha256File(path.join(root, 'prompts.json'));

function metric(value, unit = 'count') {
  return {
    status: 'available',
    value,
    unit,
    source: 'regression-fixture',
    unavailableReason: null
  };
}

function notApplicable(unit = 'count') {
  return {
    status: 'not_applicable',
    value: null,
    unit,
    source: null,
    unavailableReason: null
  };
}

function sessionRef(sessionId, model) {
  return { sessionId, requestedModel: model, observedModel: model };
}

function checkGroup(id) {
  return {
    status: 'pass',
    unavailableReason: null,
    assertions: [{ id, status: 'pass', message: 'fixture check passed' }]
  };
}

function createDataset(directory) {
  for (const name of ['raw', 'artifacts', 'judgments']) {
    fs.mkdirSync(path.join(directory, name), { recursive: true });
  }
  const manifests = new Map();
  const telemetry = new Map();
  const deterministic = new Map();
  const artifacts = new Map();
  const bindings = new Map();
  const judgments = new Map();

  for (const observation of observations) {
    const runId = `${observation.scheduleId}-A1`;
    const parentSessionId = `parent-${observation.scheduleId}`;
    const specialistSessionId = `specialist-${observation.scheduleId}`;
    const artifactHash = hash64(`artifact:${runId}`);
    const treatment = observation.condition === 'treatment';
    const manifest = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      promptId: observation.promptId,
      repetition: observation.repetition,
      condition: observation.condition,
      conditionInstruction: conditionInstructions[observation.condition],
      execution: {
        block: observation.block,
        position: observation.position,
        attempt: 1,
        coordinatorSessionId: `coordinator-${observation.promptId}`
      },
      environment: {
        copilotCliVersion: '1.0.71',
        hostImage: 'regression',
        operatingSystem: 'Windows_NT',
        powershellVersion: '7.5.0',
        nodeVersion: '22.0.0'
      },
      sessions: {
        parent: sessionRef(parentSessionId, parentModel),
        specialist: treatment
          ? sessionRef(specialistSessionId, specialistModel)
          : { status: 'not_applicable', reason: 'control_condition' }
      },
      refs: {
        benchmarkCommitSha: gitSha,
        fixtureLockSha256: fixtureHash,
        promptsSha256: promptsHash,
        initialTreeSha: gitSha,
        terminalCommitSha: gitSha,
        artifactBundleSha256: artifactHash
      },
      workspace: { identifier: `workspace-${runId}`, branch: `trial-${runId}` },
      timestamps: {
        createdAt: '2026-07-28T00:00:00.000Z',
        promptSentAt: '2026-07-28T00:00:01.000Z',
        completedAt: '2026-07-28T00:01:00.000Z'
      },
      completion: 'completed',
      conditionCompliance: { compliant: true, evidence: ['regression fixture'] },
      exclusion: { excluded: false, reason: null, retryOf: null, retryId: null }
    };
    const aggregateMetricNames = [
      'totalSessionAiCredits', 'totalSessionNanoAiu', 'parentNanoAiu',
      'parentCumulativeInputTokens', 'parentPeakInputTokens', 'parentOutputTokens',
      'specialistCumulativeInputTokens', 'specialistPeakInputTokens', 'specialistOutputTokens',
      'exposedToolCount', 'toolCallCount', 'toolResultCount', 'compactReturnBytes',
      'wallLatencyMs', 'parentActiveLatencyMs', 'specialistLatencyMs', 'parentWaitLatencyMs'
    ];
    const metrics = Object.fromEntries(aggregateMetricNames.map((name, index) => [
      name,
      !treatment && name.startsWith('specialist') ? notApplicable() : metric(index + 1)
    ]));
    const modelMetrics = {
      aiCredits: metric(1, 'credits'),
      nanoAiu: metric(2, 'nano_aiu'),
      inputTokens: metric(100, 'tokens'),
      peakInputTokens: metric(50, 'tokens'),
      outputTokens: metric(20, 'tokens'),
      cachedTokens: metric(10, 'tokens')
    };
    const parentSplit = {
      role: 'parent',
      requestedModel: parentModel,
      observedModel: parentModel,
      sessionId: parentSessionId,
      ...modelMetrics
    };
    const specialistSplit = {
      role: 'specialist',
      requestedModel: specialistModel,
      observedModel: specialistModel,
      sessionId: specialistSessionId,
      ...modelMetrics
    };
    const telemetryRecord = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      collectedAt: '2026-07-28T00:02:00.000Z',
      metrics,
      models: treatment ? [parentSplit, specialistSplit] : [parentSplit],
      tools: [{
        sessionId: parentSessionId,
        sequence: 1,
        name: 'view',
        callId: `call-${runId}`,
        startedAt: '2026-07-28T00:00:02.000Z',
        completedAt: '2026-07-28T00:00:03.000Z',
        success: true,
        resultBytes: metric(64, 'bytes')
      }],
      compaction: [{
        sessionId: parentSessionId,
        sequence: 1,
        timestamp: '2026-07-28T00:00:04.000Z',
        returnBytes: metric(32, 'bytes'),
        sourceEventId: `compact-${runId}`
      }],
      routing: {
        parent: {
          sessionId: parentSessionId,
          requestedModel: parentModel,
          observedModel: parentModel,
          sourceEventIds: [`parent-event-${runId}`]
        },
        specialist: treatment ? {
          sessionId: specialistSessionId,
          requestedModel: specialistModel,
          observedModel: specialistModel,
          sourceEventIds: [`specialist-event-${runId}`]
        } : { status: 'not_applicable', reason: 'control_condition' },
        delegationEvidence: treatment ? {
          status: 'available',
          callEventId: `delegate-call-${runId}`,
          resultEventId: `delegate-result-${runId}`,
          requestedAt: '2026-07-28T00:00:05.000Z',
          returnedAt: '2026-07-28T00:00:06.000Z',
          unavailableReason: null
        } : {
          status: 'not_applicable',
          callEventId: null,
          resultEventId: null,
          requestedAt: null,
          returnedAt: null,
          unavailableReason: null
        }
      },
      rawSources: [{
        path: `${runId}.json`,
        sha256: hash64(`raw:${runId}`),
        collector: 'regression',
        collectedBySessionId: 'collector-regression'
      }]
    };
    const deterministicRecord = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      promptId: observation.promptId,
      status: observation.condition === 'control' ? 'fail' : 'pass',
      unavailableReason: null,
      functional: observation.condition === 'control'
        ? {
          status: 'fail',
          unavailableReason: null,
          assertions: [{ id: 'functional', status: 'fail', message: 'fixture failure' }]
        }
        : checkGroup('functional'),
      art: checkGroup('art'),
      tamperCheck: checkGroup('tamper'),
      startedAt: '2026-07-28T00:01:01.000Z',
      completedAt: '2026-07-28T00:01:10.000Z'
    };
    const artifact = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      sessionId: parentSessionId,
      terminalCommitSha: gitSha,
      bundleSha256: artifactHash,
      files: [{
        path: 'source.ps1',
        sha256: hash64(`file:${runId}`),
        bytes: 100,
        role: 'source'
      }]
    };
    manifests.set(runId, manifest);
    telemetry.set(runId, telemetryRecord);
    deterministic.set(runId, deterministicRecord);
    artifacts.set(runId, artifact);
  }

  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts) {
      const runId = `${assignment.scheduleId}-A1`;
      const artifact = artifacts.get(runId);
      const binding = {
        protocolId,
        blindId: assignment.blindId,
        judgeBlock: block.block,
        scheduleId: assignment.scheduleId,
        runId,
        sourceArtifactBundleSha256: artifact.bundleSha256,
        blindBundleSha256: hash64(`blind:${assignment.blindId}:${runId}`)
      };
      const judgment = {
        protocolId,
        blindId: assignment.blindId,
        judgeBlock: block.block,
        judgeSessionId: `judge-session-${block.block}`,
        judgeModel: parentModel,
        runId,
        sourceArtifactBundleSha256: binding.sourceArtifactBundleSha256,
        blindBundleSha256: binding.blindBundleSha256,
        scores: {
          function: 3,
          codeQuality: 3,
          integration: 3,
          recognizability: 3,
          composition: 3,
          cleanliness: 3
        },
        overall: 3,
        rationale: 'Regression fixture judgment.',
        duplicateOf: assignment.duplicateOfBlindId || null
      };
      bindings.set(assignment.blindId, binding);
      judgments.set(assignment.blindId, judgment);
    }
  }

  function persist() {
    for (const [runId, value] of manifests) writeJson(path.join(directory, 'raw', `${runId}.manifest.json`), value);
    for (const [runId, value] of telemetry) writeJson(path.join(directory, 'raw', `${runId}.telemetry.json`), value);
    for (const [runId, value] of deterministic) writeJson(path.join(directory, 'raw', `${runId}.deterministic.json`), value);
    for (const [runId, value] of artifacts) writeJson(path.join(directory, 'artifacts', `${runId}.artifacts.json`), value);
    for (const [blindId, value] of bindings) writeJson(path.join(directory, 'artifacts', `${blindId}.binding.json`), value);
    for (const [blindId, value] of judgments) writeJson(path.join(directory, 'judgments', `${blindId}.judgment.json`), value);
  }

  persist();
  return { manifests, telemetry, deterministic, artifacts, bindings, judgments, persist };
}

function runNode(script, argumentsList) {
  return spawnSync(process.execPath, [path.join(scriptRoot, script), ...argumentsList], {
    cwd: root,
    encoding: 'utf8'
  });
}

function validate(directory) {
  return runNode('validate-dataset.js', ['--data-root', directory]);
}

function firstTreatment(state) {
  return [...state.manifests.values()].find((item) => item.condition === 'treatment');
}

function mutate(state, name) {
  const firstManifest = [...state.manifests.values()][0];
  const firstTelemetry = state.telemetry.get(firstManifest.runId);
  const firstDeterministic = state.deterministic.get(firstManifest.runId);
  const firstBinding = [...state.bindings.values()][0];
  const firstJudgment = state.judgments.get(firstBinding.blindId);
  switch (name) {
    case 'wrongConditionInstruction':
      firstManifest.conditionInstruction = conditionInstructions[firstManifest.condition === 'control' ? 'treatment' : 'control'];
      break;
    case 'wrongModelNotExcluded':
      firstManifest.sessions.parent.observedModel = 'wrong-parent';
      firstTelemetry.routing.parent.observedModel = 'wrong-parent';
      firstTelemetry.models.find((model) => model.role === 'parent').observedModel = 'wrong-parent';
      break;
    case 'wrongRequestedParentModelNotExcluded':
      firstManifest.sessions.parent.requestedModel = 'wrong-parent';
      firstTelemetry.routing.parent.requestedModel = 'wrong-parent';
      firstTelemetry.models.find((model) => model.role === 'parent').requestedModel = 'wrong-parent';
      break;
    case 'wrongTreatmentSpecialistModelNotExcluded': {
      const treatment = firstTreatment(state);
      const treatmentTelemetry = state.telemetry.get(treatment.runId);
      treatment.sessions.specialist.requestedModel = 'wrong-specialist';
      treatment.sessions.specialist.observedModel = 'wrong-specialist';
      treatmentTelemetry.routing.specialist.requestedModel = 'wrong-specialist';
      treatmentTelemetry.routing.specialist.observedModel = 'wrong-specialist';
      treatmentTelemetry.models.find((model) => model.role === 'specialist').requestedModel = 'wrong-specialist';
      treatmentTelemetry.models.find((model) => model.role === 'specialist').observedModel = 'wrong-specialist';
      break;
    }
    case 'wrongModelExcluded':
      firstManifest.sessions.parent.observedModel = 'wrong-parent';
      firstManifest.exclusion = { excluded: true, reason: 'wrong_model', retryOf: null, retryId: `${firstManifest.scheduleId}-A2` };
      firstTelemetry.routing.parent.observedModel = 'wrong-parent';
      firstTelemetry.models.find((model) => model.role === 'parent').observedModel = 'wrong-parent';
      state.bindings.forEach((binding) => {
        if (binding.scheduleId === firstManifest.scheduleId) state.bindings.delete(binding.blindId);
      });
      state.judgments.forEach((judgment) => {
        if (judgment.runId === firstManifest.runId) state.judgments.delete(judgment.blindId);
      });
      break;
    case 'deterministicPassWithUnavailableChild':
      firstDeterministic.status = 'pass';
      firstDeterministic.art = {
        status: 'unavailable',
        unavailableReason: 'runner unavailable',
        assertions: [{ id: 'art', status: 'unavailable', message: 'runner unavailable' }]
      };
      break;
    case 'deterministicPassWithFailedChild':
      firstDeterministic.status = 'pass';
      firstDeterministic.functional = {
        status: 'fail',
        unavailableReason: null,
        assertions: [{ id: 'functional', status: 'fail', message: 'failed' }]
      };
      break;
    case 'blindBindingReplacedRun':
      firstBinding.runId = `${firstBinding.scheduleId}-A2`;
      break;
    case 'judgmentReplacedArtifactHash':
      firstJudgment.sourceArtifactBundleSha256 = 'f'.repeat(64);
      break;
    case 'judgeSessionReusedAcrossBlocks':
      state.judgments.forEach((judgment) => {
        if (judgment.judgeBlock === 2) judgment.judgeSessionId = 'judge-session-1';
      });
      break;
    case 'judgmentWrongBlock':
      firstJudgment.judgeBlock = firstJudgment.judgeBlock === 1 ? 2 : 1;
      break;
    case 'availableMetricNull':
      firstTelemetry.metrics.totalSessionAiCredits.value = null;
      break;
    case 'unavailableMetricHasValue':
      firstTelemetry.metrics.totalSessionAiCredits = {
        status: 'unavailable',
        value: 1,
        unit: 'credits',
        source: null,
        unavailableReason: 'not exposed'
      };
      break;
    case 'missingParentModelSplit':
      firstTelemetry.models = firstTelemetry.models.filter((model) => model.role !== 'parent');
      break;
    case 'treatmentMissingSpecialistProvenance': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).models = state.telemetry.get(treatment.runId).models
        .filter((model) => model.role !== 'specialist');
      break;
    }
    default:
      throw new Error(`Unknown mutation ${name}`);
  }
  state.persist();
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-benchmark-regression-'));
try {
  const positiveDirectory = path.join(temporaryRoot, 'positive');
  const positive = createDataset(positiveDirectory);
  let result = validate(positiveDirectory);
  assert.strictEqual(result.status, 0, result.stderr);

  for (const testCase of cases) {
    const directory = path.join(temporaryRoot, testCase.id);
    const state = createDataset(directory);
    mutate(state, testCase.mutation);
    result = validate(directory);
    assert.notStrictEqual(result.status, 0, `${testCase.id} unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(testCase.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const excludedDirectory = path.join(temporaryRoot, 'wrong-model-excluded');
  const excluded = createDataset(excludedDirectory);
  const wrong = [...excluded.manifests.values()][0];
  mutate(excluded, 'wrongModelExcluded');
  const retryId = `${wrong.scheduleId}-A2`;
  const originalRunId = wrong.runId;
  const retryManifest = structuredClone(wrong);
  retryManifest.runId = retryId;
  retryManifest.execution.attempt = 2;
  retryManifest.sessions.parent = sessionRef(`parent-${retryId}`, parentModel);
  retryManifest.refs.artifactBundleSha256 = hash64(`artifact:${retryId}`);
  retryManifest.exclusion = { excluded: false, reason: null, retryOf: originalRunId, retryId: null };
  const retryTelemetry = structuredClone(excluded.telemetry.get(originalRunId));
  retryTelemetry.runId = retryId;
  retryTelemetry.routing.parent.sessionId = retryManifest.sessions.parent.sessionId;
  retryTelemetry.routing.parent.observedModel = parentModel;
  retryTelemetry.models[0].sessionId = retryManifest.sessions.parent.sessionId;
  retryTelemetry.models[0].observedModel = parentModel;
  const retryDeterministic = structuredClone(excluded.deterministic.get(originalRunId));
  retryDeterministic.runId = retryId;
  const retryArtifact = structuredClone(excluded.artifacts.get(originalRunId));
  retryArtifact.runId = retryId;
  retryArtifact.sessionId = retryManifest.sessions.parent.sessionId;
  retryArtifact.bundleSha256 = retryManifest.refs.artifactBundleSha256;
  excluded.manifests.set(retryId, retryManifest);
  excluded.telemetry.set(retryId, retryTelemetry);
  excluded.deterministic.set(retryId, retryDeterministic);
  excluded.artifacts.set(retryId, retryArtifact);
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => item.scheduleId === wrong.scheduleId)) {
      const binding = {
        protocolId,
        blindId: assignment.blindId,
        judgeBlock: block.block,
        scheduleId: assignment.scheduleId,
        runId: retryId,
        sourceArtifactBundleSha256: retryArtifact.bundleSha256,
        blindBundleSha256: hash64(`blind:${assignment.blindId}:${retryId}`)
      };
      excluded.bindings.set(assignment.blindId, binding);
      excluded.judgments.set(assignment.blindId, {
        ...positive.judgments.get(assignment.blindId),
        runId: retryId,
        sourceArtifactBundleSha256: binding.sourceArtifactBundleSha256,
        blindBundleSha256: binding.blindBundleSha256
      });
    }
  }
  excluded.persist();
  result = validate(excludedDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  retryManifest.exclusion.retryOf = 'unrelated-run';
  excluded.persist();
  result = validate(excludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Broken reciprocal retry linkage unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /reciprocal retryId\/retryOf linkage/);
  retryManifest.exclusion.retryOf = originalRunId;
  excluded.persist();

  const summaryPath = path.join(temporaryRoot, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(positiveDirectory, 'raw'),
    '--artifacts', path.join(positiveDirectory, 'artifacts'),
    '--judgments', path.join(positiveDirectory, 'judgments'),
    '--out', summaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  let summary = readJson(summaryPath);
  let binary = summary.intentToTreat.outcomes.find((item) => item.outcome === 'deterministicPass');
  assert.strictEqual(binary.unit, 'percentage_points');
  assert.strictEqual(binary.meanPairedDifference, 100);
  assert.strictEqual(binary.promptClusteredBootstrap95.status, 'available');
  assert.ok(summary.intentToTreat.secondaryTelemetry.treatment.models[`${'specialist'}:${specialistModel}`].cachedTokens);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.control.toolEvents.view.calls, 30);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.compaction.events, 30);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.routingEvidence.delegationStatus.available, 30);

  const unavailable = positive.deterministic.get(observations[0].scheduleId + '-A1');
  unavailable.status = 'unavailable';
  unavailable.unavailableReason = 'acceptance runner unavailable';
  unavailable.functional = {
    status: 'unavailable',
    unavailableReason: 'acceptance runner unavailable',
    assertions: [{ id: 'functional', status: 'unavailable', message: 'runner unavailable' }]
  };
  positive.persist();
  result = runNode('summarize.js', [
    '--runs', path.join(positiveDirectory, 'raw'),
    '--artifacts', path.join(positiveDirectory, 'artifacts'),
    '--judgments', path.join(positiveDirectory, 'judgments'),
    '--out', summaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  summary = readJson(summaryPath);
  binary = summary.intentToTreat.outcomes.find((item) => item.outcome === 'deterministicPass');
  assert.strictEqual(binary.completePairs, 29);
  assert.strictEqual(binary.missingPairs, 1);
  assert.strictEqual(binary.promptClusteredBootstrap95.status, 'unavailable');

  const artWorkspace = path.join(temporaryRoot, 'art-workspace');
  fs.mkdirSync(path.join(artWorkspace, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(artWorkspace, 'src'), { recursive: true });
  const artLines = Array.from({ length: 12 }, (_, index) =>
    index === 5 ? '+++++++FIND+++++++++' : '++++++++++++++++++++');
  fs.writeFileSync(path.join(artWorkspace, 'assets', 'search.txt'), `${artLines.join('\n')}\n`, 'ascii');
  fs.writeFileSync(path.join(artWorkspace, 'src', 'unexpected.txt'), 'not an asset\n', 'ascii');
  result = runNode('validate-art.js', ['--prompt', 'P01', '--workspace', artWorkspace]);
  assert.notStrictEqual(result.status, 0, 'A text asset outside assets/ unexpectedly passed art validation.');
  assert.match(result.stdout, /unexpected text assets: src\/unexpected\.txt/);

  assert.ok(validateSchema([1, 2], { type: 'array', maxItems: 1 }).length > 0);
  assert.ok(validateSchema('x', { anyOf: [{ type: 'integer' }, { const: 'y' }] }).length > 0);
  assert.ok(validateSchema({}, { allOf: [{ required: ['x'] }] }).length > 0);
  assert.ok(validateSchema({}, {
    type: 'object',
    oneOf: [{ type: 'object' }],
    required: ['x'],
    properties: { x: { type: 'integer' } }
  }).length > 0);

  console.log(`PASS: ${cases.length} integrity negatives, excluded wrong-model positive, and analysis regressions`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
