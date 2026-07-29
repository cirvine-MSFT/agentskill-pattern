#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  canonicalJson,
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
const {
  assertNoConditionRevealingProvenance,
  assertNoProhibitedMetadata,
  buildBlindContent,
  canonicalVariants,
  sanitizedDeterministic
} = require('../artifact-bundles');
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

function unavailable(unit = 'count', reason = 'not exposed') {
  return {
    status: 'unavailable',
    value: null,
    unit,
    source: 'regression-fixture',
    unavailableReason: reason
  };
}

function sessionRef(sessionId, model) {
  return { sessionId, requestedModel: model, observedModel: model };
}

function mixedCase(value) {
  return [...value].map((character, index) => (
    index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()
  )).join('');
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
  const artifactBundles = new Map();
  const rawSources = new Map();
  const bindings = new Map();
  const blindContents = new Map();
  const judgments = new Map();

  function rawEvent(rawSourceId, eventId, sessionId, sequence, type, timestamp, values = {}) {
    return {
      eventId,
      sessionId,
      sequence,
      type,
      timestamp,
      callId: null,
      toolName: null,
      success: null,
      targetSessionId: null,
      requestedModel: null,
      scope: null,
      path: null,
      operation: null,
      resultBytes: null,
      usage: null,
      rawSourceId,
      ...values
    };
  }

  function modelMetrics() {
    return {
      aiCredits: metric(1, 'credits'),
      nanoAiu: metric(2, 'nano_aiu'),
      inputTokens: metric(100, 'tokens'),
      peakInputTokens: metric(50, 'tokens'),
      outputTokens: metric(20, 'tokens'),
      cachedTokens: metric(10, 'tokens')
    };
  }

  function addRun(observation, attempt = 1) {
    const runId = `${observation.scheduleId}-A${attempt}`;
    const parentSessionId = `parent-${observation.scheduleId}`;
    const attemptParentSessionId = attempt === 1 ? parentSessionId : `${parentSessionId}-A${attempt}`;
    const specialistSessionId = attempt === 1
      ? `specialist-${observation.scheduleId}`
      : `specialist-${observation.scheduleId}-A${attempt}`;
    const treatment = observation.condition === 'treatment';
    const prompt = readJson(path.join(root, 'prompts.json')).find((item) => item.id === observation.promptId);
    const deterministicRecord = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      promptId: observation.promptId,
      status: treatment ? 'pass' : 'fail',
      unavailableReason: null,
      functional: treatment
        ? checkGroup('functional')
        : {
          status: 'fail',
          unavailableReason: null,
          assertions: [{ id: 'functional', status: 'fail', message: 'fixture failure' }]
        },
      art: checkGroup('art'),
      tamperCheck: checkGroup('tamper'),
      startedAt: '2026-07-28T00:01:01.000Z',
      completedAt: '2026-07-28T00:01:10.000Z'
    };
    const sourceBundle = {
      protocolId,
      promptId: observation.promptId,
      prompt: prompt.prompt,
      deterministic: sanitizedDeterministic(deterministicRecord),
      files: [{
        path: 'src/TaskForge.ps1',
        role: 'source',
        content: '# synthetic controller implementation fixture\n'
      }, {
        path: prompt.banner.path,
        role: 'banner',
        content: `${prompt.banner.requiredToken} SYNTHETIC BANNER\n`
      }]
    };
    const artifactBytes = canonicalJson(sourceBundle);
    const artifactHash = sha256(Buffer.from(artifactBytes, 'utf8'));
    const manifest = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      promptId: observation.promptId,
      repetition: observation.repetition,
      condition: observation.condition,
      conditionInstruction: conditionInstructions[observation.condition],
      attempt: {
        phase: 'session_started',
        status: 'included',
        availability: 'evidence_required'
      },
      conditionEvidence: {
        status: 'available',
        delegationCallEventIds: treatment ? [`delegate-call-${runId}`] : [],
        delegationResultEventIds: treatment ? [`delegate-result-${runId}`] : [],
        specialistToolCallEventIds: treatment ? [`specialist-tool-call-${runId}`] : [],
        specialistToolResultEventIds: treatment ? [`specialist-tool-result-${runId}`] : [],
        specialistFileChangeEventIds: treatment ? [`specialist-file-${runId}`] : [],
        unavailableReason: null
      },
      execution: {
        block: observation.block,
        position: observation.position,
        attempt,
        rootSessionId: 'root-experiment-session',
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
        parent: sessionRef(attemptParentSessionId, parentModel),
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
      exclusion: { excluded: false, reason: null, retryOf: null, retryId: null }
    };
    const rawSourceId = `source-${runId}`;
    const parentStartId = `parent-start-${runId}`;
    const parentUsageId = `parent-usage-${runId}`;
    const parentToolCallId = `parent-tool-call-${runId}`;
    const parentToolResultId = `parent-tool-result-${runId}`;
    const compactId = `compact-${runId}`;
    const events = [
      rawEvent(rawSourceId, parentStartId, attemptParentSessionId, 1, 'session_start', '2026-07-28T00:00:00.000Z'),
      rawEvent(rawSourceId, parentUsageId, attemptParentSessionId, 2, 'usage', '2026-07-28T00:00:01.000Z', {
        usage: { aiCredits: 1, nanoAiu: 2, inputTokens: 100, peakInputTokens: 50, outputTokens: 20, cachedTokens: 10 }
      }),
      rawEvent(rawSourceId, parentToolCallId, attemptParentSessionId, 3, 'tool_call', '2026-07-28T00:00:02.000Z', {
        callId: `parent-call-${runId}`,
        toolName: 'view'
      }),
      rawEvent(rawSourceId, parentToolResultId, attemptParentSessionId, 4, 'tool_result', '2026-07-28T00:00:03.000Z', {
        callId: `parent-call-${runId}`,
        toolName: 'view',
        success: true,
        resultBytes: 64
      }),
      rawEvent(rawSourceId, compactId, attemptParentSessionId, 5, 'compaction', '2026-07-28T00:00:04.000Z', {
        resultBytes: 32
      })
    ];
    if (treatment) {
      events.push(
        rawEvent(rawSourceId, `delegate-call-${runId}`, attemptParentSessionId, 6, 'delegation_call', '2026-07-28T00:00:05.000Z', {
          callId: `delegate-${runId}`,
          targetSessionId: specialistSessionId,
          requestedModel: specialistModel,
          scope: 'create_banner_only',
          path: prompt.banner.path
        }),
        rawEvent(rawSourceId, `delegate-result-${runId}`, attemptParentSessionId, 7, 'delegation_result', '2026-07-28T00:00:06.000Z', {
          callId: `delegate-${runId}`,
          targetSessionId: specialistSessionId,
          scope: 'create_banner_only',
          path: prompt.banner.path
        }),
        rawEvent(rawSourceId, `specialist-start-${runId}`, specialistSessionId, 1, 'session_start', '2026-07-28T00:00:05.100Z'),
        rawEvent(rawSourceId, `specialist-usage-${runId}`, specialistSessionId, 2, 'usage', '2026-07-28T00:00:05.200Z', {
          usage: { aiCredits: 1, nanoAiu: 2, inputTokens: 100, peakInputTokens: 50, outputTokens: 20, cachedTokens: 10 }
        }),
        rawEvent(rawSourceId, `specialist-tool-call-${runId}`, specialistSessionId, 3, 'tool_call', '2026-07-28T00:00:05.300Z', {
          callId: `specialist-call-${runId}`,
          toolName: 'write_file',
          path: prompt.banner.path
        }),
        rawEvent(rawSourceId, `specialist-tool-result-${runId}`, specialistSessionId, 4, 'tool_result', '2026-07-28T00:00:05.400Z', {
          callId: `specialist-call-${runId}`,
          toolName: 'write_file',
          success: true,
          resultBytes: 48
        }),
        rawEvent(rawSourceId, `specialist-file-${runId}`, specialistSessionId, 5, 'file_change', '2026-07-28T00:00:05.500Z', {
          path: prompt.banner.path,
          operation: 'create'
        })
      );
    }
    const rawPayload = { sourceId: rawSourceId, events };
    const rawBytes = canonicalJson(rawPayload);
    const rawHash = sha256(Buffer.from(rawBytes, 'utf8'));
    const parentSplit = {
      role: 'parent',
      requestedModel: parentModel,
      observedModel: parentModel,
      sessionId: attemptParentSessionId,
      ...modelMetrics()
    };
    const specialistSplit = {
      role: 'specialist',
      requestedModel: specialistModel,
      observedModel: specialistModel,
      sessionId: specialistSessionId,
      ...modelMetrics()
    };
    const tools = [{
      sessionId: attemptParentSessionId,
      sequence: 1,
      name: 'view',
      callId: `parent-call-${runId}`,
      callEventId: parentToolCallId,
      resultEventId: parentToolResultId,
      targetPath: null,
      startedAt: '2026-07-28T00:00:02.000Z',
      completedAt: '2026-07-28T00:00:03.000Z',
      success: true,
      resultBytes: metric(64, 'bytes')
    }];
    if (treatment) {
      tools.push({
        sessionId: specialistSessionId,
        sequence: 1,
        name: 'write_file',
        callId: `specialist-call-${runId}`,
        callEventId: `specialist-tool-call-${runId}`,
        resultEventId: `specialist-tool-result-${runId}`,
        targetPath: prompt.banner.path,
        startedAt: '2026-07-28T00:00:05.300Z',
        completedAt: '2026-07-28T00:00:05.400Z',
        success: true,
        resultBytes: metric(48, 'bytes')
      });
    }
    const metrics = {
      totalSessionAiCredits: metric(treatment ? 2 : 1, 'credits'),
      totalSessionNanoAiu: metric(treatment ? 4 : 2, 'nano_aiu'),
      parentNanoAiu: metric(2, 'nano_aiu'),
      parentCumulativeInputTokens: metric(100, 'tokens'),
      parentPeakInputTokens: metric(50, 'tokens'),
      parentOutputTokens: metric(20, 'tokens'),
      specialistCumulativeInputTokens: treatment ? metric(100, 'tokens') : unavailable('tokens', 'control_condition_no_specialist'),
      specialistPeakInputTokens: treatment ? metric(50, 'tokens') : unavailable('tokens', 'control_condition_no_specialist'),
      specialistOutputTokens: treatment ? metric(20, 'tokens') : unavailable('tokens', 'control_condition_no_specialist'),
      exposedToolCount: metric(treatment ? 2 : 1),
      toolCallCount: metric(tools.length),
      toolResultCount: metric(tools.length),
      compactionEventCount: metric(1),
      compactReturnBytes: metric(32, 'bytes'),
      wallLatencyMs: metric(59000, 'milliseconds'),
      parentActiveLatencyMs: metric(50000, 'milliseconds'),
      specialistLatencyMs: treatment ? metric(1000, 'milliseconds') : unavailable('milliseconds', 'control_condition_no_specialist'),
      parentWaitLatencyMs: treatment
        ? metric(1000, 'milliseconds')
        : unavailable('milliseconds', 'control_condition_no_delegation_wait')
    };
    const telemetryRecord = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      collectedAt: '2026-07-28T00:02:00.000Z',
      metrics,
      models: treatment ? [parentSplit, specialistSplit] : [parentSplit],
      exposedTools: treatment ? ['view', 'write_file'] : ['view'],
      tools,
      compaction: [{
        sessionId: attemptParentSessionId,
        sequence: 1,
        timestamp: '2026-07-28T00:00:04.000Z',
        returnBytes: metric(32, 'bytes'),
        sourceEventId: `compact-${runId}`
      }],
      events,
      routing: {
        parent: {
          sessionId: attemptParentSessionId,
          requestedModel: parentModel,
          observedModel: parentModel,
          sourceEventIds: [parentStartId]
        },
        specialist: treatment ? {
          sessionId: specialistSessionId,
          requestedModel: specialistModel,
          observedModel: specialistModel,
          sourceEventIds: [`specialist-start-${runId}`]
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
        sourceId: rawSourceId,
        path: `${runId}.events.json`,
        sha256: rawHash,
        collector: 'regression',
        collectedBySessionId: 'collector-regression'
      }]
    };
    const artifactFiles = sourceBundle.files.map((file) => {
      const bytes = Buffer.from(file.content, 'utf8');
      return { path: file.path, sha256: sha256(bytes), bytes: bytes.length, role: file.role };
    });
    const artifact = {
      protocolId,
      runId,
      scheduleId: observation.scheduleId,
      sessionId: attemptParentSessionId,
      terminalCommitSha: gitSha,
      bundlePath: `${runId}.source.json`,
      bundleSha256: artifactHash,
      files: artifactFiles
    };
    manifests.set(runId, manifest);
    telemetry.set(runId, telemetryRecord);
    deterministic.set(runId, deterministicRecord);
    artifacts.set(runId, artifact);
  artifactBundles.set(runId, sourceBundle);
  rawSources.set(runId, structuredClone(rawPayload));
  return { manifest, telemetryRecord, deterministicRecord, artifact };
  }

  function replaceWithPreExecutionFailure(observation, attempt, reason, retryOf, retryId) {
    const runId = `${observation.scheduleId}-A${attempt}`;
    const manifest = {
      protocolId,
      recordType: 'pre_execution_failure',
      runId,
      scheduleId: observation.scheduleId,
      promptId: observation.promptId,
      repetition: observation.repetition,
      condition: observation.condition,
      conditionInstruction: conditionInstructions[observation.condition],
      attempt: {
        phase: 'pre_execution',
        status: 'excluded',
        availability: 'not_created'
      },
      execution: {
        block: observation.block,
        position: observation.position,
        attempt
      },
      exclusion: {
        excluded: true,
        reason,
        retryOf,
        retryId
      }
    };
    manifests.set(runId, manifest);
    telemetry.delete(runId);
    deterministic.delete(runId);
    artifacts.delete(runId);
    artifactBundles.delete(runId);
    rawSources.delete(runId);
    bindings.forEach((binding, blindId) => {
      if (binding.runId === runId) {
        bindings.delete(blindId);
        blindContents.delete(blindId);
        judgments.delete(blindId);
      }
    });
    return manifest;
  }

  for (const observation of observations) {
  addRun(observation, 1);
  }

  function bindAssignment(block, assignment, runId) {
  const artifact = artifacts.get(runId);
  const blindContent = buildBlindContent(assignment.blindId, artifactBundles.get(runId));
  const blindBytes = canonicalJson(blindContent);
    const binding = {
        protocolId,
        blindId: assignment.blindId,
        judgeBlock: block.block,
        scheduleId: assignment.scheduleId,
        runId,
        sourceArtifactBundleSha256: artifact.bundleSha256,
        blindBundlePath: `${assignment.blindId}.bundle.json`,
        blindBundleSha256: sha256(Buffer.from(blindBytes, 'utf8'))
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
      blindContents.set(assignment.blindId, blindContent);
      judgments.set(assignment.blindId, judgment);
  }

  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts) {
      bindAssignment(block, assignment, `${assignment.scheduleId}-A1`);
    }
  }

  function persist() {
    for (const name of ['raw', 'artifacts', 'judgments']) {
      for (const file of fs.readdirSync(path.join(directory, name))) {
        if (file.endsWith('.json')) fs.rmSync(path.join(directory, name, file));
      }
    }
    for (const [runId, value] of manifests) {
      const suffix = value.recordType === 'pre_execution_failure'
        ? 'pre-execution.json'
        : 'manifest.json';
      writeJson(path.join(directory, 'raw', `${runId}.${suffix}`), value);
    }
    for (const [runId, value] of telemetry) writeJson(path.join(directory, 'raw', `${runId}.telemetry.json`), value);
    for (const [runId, value] of deterministic) writeJson(path.join(directory, 'raw', `${runId}.deterministic.json`), value);
    for (const [runId, value] of rawSources) writeJson(path.join(directory, 'raw', `${runId}.events.json`), value);
    for (const [runId, value] of artifacts) writeJson(path.join(directory, 'artifacts', `${runId}.artifacts.json`), value);
    for (const [runId, value] of artifactBundles) writeJson(path.join(directory, 'artifacts', `${runId}.source.json`), value);
    for (const [blindId, value] of bindings) writeJson(path.join(directory, 'artifacts', `${blindId}.binding.json`), value);
    for (const [blindId, value] of blindContents) writeJson(path.join(directory, 'artifacts', `${blindId}.bundle.json`), value);
    for (const [blindId, value] of judgments) writeJson(path.join(directory, 'judgments', `${blindId}.judgment.json`), value);
  }

  persist();
  return {
    manifests,
    telemetry,
    deterministic,
    artifacts,
    artifactBundles,
    rawSources,
    bindings,
    blindContents,
    judgments,
    addRun,
    replaceWithPreExecutionFailure,
    bindAssignment,
    persist
  };
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

function refreshArtifactHash(state, runId) {
  const hash = sha256(Buffer.from(canonicalJson(state.artifactBundles.get(runId)), 'utf8'));
  state.artifacts.get(runId).bundleSha256 = hash;
  state.manifests.get(runId).refs.artifactBundleSha256 = hash;
  return hash;
}

function refreshAuthenticatedRawSource(state, runId) {
  const telemetryRecord = state.telemetry.get(runId);
  const source = state.rawSources.get(runId);
  source.events = structuredClone(telemetryRecord.events);
  telemetryRecord.rawSources[0].sha256 = sha256(Buffer.from(canonicalJson(source), 'utf8'));
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
    case 'wrongRequestedTreatmentSpecialistModelNotExcluded': {
      const treatment = firstTreatment(state);
      const treatmentTelemetry = state.telemetry.get(treatment.runId);
      treatment.sessions.specialist.requestedModel = 'wrong-specialist';
      treatmentTelemetry.routing.specialist.requestedModel = 'wrong-specialist';
      treatmentTelemetry.models.find((model) => model.role === 'specialist').requestedModel = 'wrong-specialist';
      break;
    }
    case 'wrongObservedTreatmentSpecialistModelNotExcluded': {
      const treatment = firstTreatment(state);
      const treatmentTelemetry = state.telemetry.get(treatment.runId);
      treatment.sessions.specialist.observedModel = 'wrong-specialist';
      treatmentTelemetry.routing.specialist.observedModel = 'wrong-specialist';
      treatmentTelemetry.models.find((model) => model.role === 'specialist').observedModel = 'wrong-specialist';
      break;
    }
    case 'wrongModelExcluded':
      firstManifest.sessions.parent.observedModel = 'wrong-parent';
      firstManifest.attempt.status = 'excluded';
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
    case 'deterministicEmptyChild':
      firstDeterministic.art.assertions = [];
      break;
    case 'blindBindingReplacedRun':
      firstBinding.runId = `${firstBinding.scheduleId}-A2`;
      break;
    case 'blindBindingReplacedArtifactHash':
      firstBinding.sourceArtifactBundleSha256 = 'f'.repeat(64);
      break;
    case 'judgmentReplacedArtifactHash':
      firstJudgment.sourceArtifactBundleSha256 = 'f'.repeat(64);
      break;
    case 'judgmentReplacedBlindHash':
      firstJudgment.blindBundleSha256 = 'f'.repeat(64);
      break;
    case 'judgeSessionReusedAcrossBlocks':
      state.judgments.forEach((judgment) => {
        if (judgment.judgeBlock === 2) judgment.judgeSessionId = 'judge-session-1';
      });
      break;
    case 'judgmentWrongBlock':
      firstJudgment.judgeBlock = firstJudgment.judgeBlock === 1 ? 2 : 1;
      break;
    case 'judgeSessionSplitWithinBlock':
      firstJudgment.judgeSessionId = 'judge-session-split';
      break;
    case 'wrongJudgeModel':
      firstJudgment.judgeModel = 'wrong-judge';
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
    case 'unavailableMetricMissingReason':
      firstTelemetry.metrics.totalSessionAiCredits = {
        status: 'unavailable',
        value: null,
        unit: 'credits',
        source: null,
        unavailableReason: ''
      };
      break;
    case 'notApplicableMetricMissingProvenance': {
      const control = [...state.manifests.values()].find((item) => item.condition === 'control');
      state.telemetry.get(control.runId).metrics.specialistOutputTokens = {
        status: 'not_applicable',
        value: null,
        unit: 'tokens',
        source: null,
        unavailableReason: null
      };
      break;
    }
    case 'missingParentModelSplit':
      firstTelemetry.models = firstTelemetry.models.filter((model) => model.role !== 'parent');
      break;
    case 'wrongParentModelSplitProvenance':
      firstTelemetry.models.find((model) => model.role === 'parent').sessionId = 'wrong-parent-session';
      break;
    case 'treatmentMissingSpecialistProvenance': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).models = state.telemetry.get(treatment.runId).models
        .filter((model) => model.role !== 'specialist');
      break;
    }
    case 'treatmentWrongSpecialistProvenance': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).models
        .find((model) => model.role === 'specialist').sessionId = 'wrong-specialist-session';
      break;
    }
    case 'toolWrongSessionProvenance':
      firstTelemetry.tools[0].sessionId = 'unrelated-session';
      break;
    case 'compactionWrongSessionProvenance':
      firstTelemetry.compaction[0].sessionId = 'unrelated-session';
      break;
    case 'compactionCountMismatch':
      firstTelemetry.metrics.compactionEventCount.value = 2;
      break;
    case 'authenticatedArtifactBytesTampered':
      state.artifactBundles.get(firstManifest.runId).files[0].content += '# tampered\n';
      break;
    case 'sourceArtifactMetadataLeak':
      state.artifactBundles.get(firstManifest.runId).condition = firstManifest.condition;
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactSessionLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content += firstManifest.sessions.parent.sessionId;
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactUppercaseModelLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content += parentModel.toUpperCase();
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactMixedCaseIdentifiersLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content += [
        mixedCase(firstManifest.runId),
        mixedCase(firstManifest.execution.coordinatorSessionId),
        mixedCase(firstManifest.sessions.parent.sessionId),
        mixedCase(firstManifest.workspace.identifier)
      ].join('\n');
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactMixedCaseSpecialistLeak': {
      const treatment = firstTreatment(state);
      state.artifactBundles.get(treatment.runId).files[0].content += [
        mixedCase(treatment.sessions.specialist.sessionId),
        mixedCase(specialistModel)
      ].join('\n');
      refreshArtifactHash(state, treatment.runId);
      break;
    }
    case 'blindBundleNotGenerated':
      state.blindContents.get(firstBinding.blindId).prompt += ' tampered';
      firstBinding.blindBundleSha256 = sha256(Buffer.from(
        canonicalJson(state.blindContents.get(firstBinding.blindId)),
        'utf8'
      ));
      firstJudgment.blindBundleSha256 = firstBinding.blindBundleSha256;
      break;
    case 'passedArtMissingBanner': {
      const bundle = state.artifactBundles.get(firstManifest.runId);
      bundle.files = bundle.files.filter((file) => file.role !== 'banner');
      state.artifacts.get(firstManifest.runId).files =
        state.artifacts.get(firstManifest.runId).files.filter((file) => file.role !== 'banner');
      refreshArtifactHash(state, firstManifest.runId);
      break;
    }
    case 'unboundDelegationEvent': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).routing.delegationEvidence.callEventId = 'missing-delegation-event';
      break;
    }
    case 'selfAssertedConditionCompliance':
      firstManifest.conditionCompliance = { compliant: true, evidence: ['self asserted'] };
      break;
    case 'unboundToolEvent':
      firstTelemetry.tools[0].callEventId = 'missing-tool-event';
      break;
    case 'parentSpecialistSessionOverlap': {
      const treatment = firstTreatment(state);
      treatment.sessions.specialist.sessionId = treatment.sessions.parent.sessionId;
      break;
    }
    case 'parentCoordinatorSessionOverlap':
      firstManifest.sessions.parent.sessionId = firstManifest.execution.coordinatorSessionId;
      break;
    case 'judgeTrialSessionOverlap': {
      const trialSessionId = firstManifest.sessions.parent.sessionId;
      state.judgments.forEach((judgment) => {
        if (judgment.judgeBlock === 1) judgment.judgeSessionId = trialSessionId;
      });
      break;
    }
    case 'controlSpecialistAggregateAvailable': {
      const control = [...state.manifests.values()].find((item) => item.condition === 'control');
      state.telemetry.get(control.runId).metrics.specialistOutputTokens = metric(0, 'tokens');
      break;
    }
    case 'negativeMetric':
      firstTelemetry.metrics.wallLatencyMs.value = -1;
      break;
    case 'toolCallAggregateMismatch':
      firstTelemetry.metrics.toolCallCount.value += 1;
      break;
    case 'toolResultAggregateMismatch':
      firstTelemetry.metrics.toolResultCount.value += 1;
      break;
    case 'modelAggregateMismatch':
      firstTelemetry.models.find((model) => model.role === 'parent').inputTokens.value += 1;
      break;
    case 'partialModelUsageWithAvailableTotal': {
      firstTelemetry.models.find((model) => model.role === 'parent').aiCredits =
        unavailable('credits', 'not_exposed');
      firstTelemetry.events.find((event) => (
        event.type === 'usage' && event.sessionId === firstManifest.sessions.parent.sessionId
      )).usage.aiCredits = null;
      refreshAuthenticatedRawSource(state, firstManifest.runId);
      break;
    }
    case 'rawSourceHashTampered':
      firstTelemetry.rawSources[0].sha256 = 'f'.repeat(64);
      break;
    case 'hiddenAuthenticatedRawEvent': {
      const source = state.rawSources.get(firstManifest.runId);
      const hidden = structuredClone(source.events[0]);
      hidden.eventId = `hidden-event-${firstManifest.runId}`;
      hidden.sequence = 99;
      source.events.push(hidden);
      firstTelemetry.rawSources[0].sha256 = sha256(Buffer.from(canonicalJson(source), 'utf8'));
      break;
    }
    case 'excludedWithNullReason':
      firstManifest.exclusion.excluded = true;
      break;
    case 'includedWithExclusionReason':
      firstManifest.exclusion.reason = 'hash_mismatch';
      break;
    case 'nonWindowsRunEnvironment':
      firstManifest.environment.operatingSystem = 'Linux';
      break;
    case 'blindBundleUnrelatedArtifact': {
      const unrelated = [...state.artifactBundles.entries()]
        .find(([runId]) => runId !== firstBinding.runId)[1];
      const replacement = buildBlindContent(firstBinding.blindId, unrelated);
      state.blindContents.set(firstBinding.blindId, replacement);
      firstBinding.blindBundleSha256 = sha256(Buffer.from(canonicalJson(replacement), 'utf8'));
      firstJudgment.blindBundleSha256 = firstBinding.blindBundleSha256;
      break;
    }
    case 'blindBundleMetadataLeak':
      state.blindContents.get(firstBinding.blindId).condition = 'treatment';
      firstBinding.blindBundleSha256 = sha256(Buffer.from(
        canonicalJson(state.blindContents.get(firstBinding.blindId)),
        'utf8'
      ));
      firstJudgment.blindBundleSha256 = firstBinding.blindBundleSha256;
      break;
    case 'sourceArtifactRoutingLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content +=
        '\nrouting = create_banner_only\n';
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactQuotedMetadataLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content +=
        '\n$payload = \'{"routing":"redacted"}\'\n';
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactDelegatedSpecialistLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content +=
        '\n# Generated by delegated specialist\n';
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactSubagentLeak':
      state.artifactBundles.get(firstManifest.runId).files.push({
        path: 'tests/TaskForge.Tests.ps1',
        role: 'fixture_test',
        content: '# Created by a subagent\n'
      });
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactTreatmentLeak':
      state.artifactBundles.get(firstManifest.runId).files.push({
        path: 'terminal.diff',
        role: 'diff',
        content: '# Treatment condition candidate\n'
      });
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactControlLeak':
      state.artifactBundles.get(firstManifest.runId).files
        .find((file) => file.role === 'banner').content += '\nCONTROL ARM OUTPUT\n';
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactSessionLeakPhrase':
      firstDeterministic.functional.assertions[0].message = 'Parent session produced this output.';
      state.artifactBundles.get(firstManifest.runId).deterministic =
        sanitizedDeterministic(firstDeterministic);
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'sourceArtifactModelRoutingLeak':
      state.artifactBundles.get(firstManifest.runId).files[0].content +=
        '\n# Routed to specialist model\n';
      refreshArtifactHash(state, firstManifest.runId);
      break;
    case 'manifestConditionEvidenceUnbound':
      firstManifest.conditionEvidence.delegationCallEventIds = ['missing-delegation-event'];
      break;
    case 'unavailableTreatmentEvidenceIncluded': {
      const treatment = firstTreatment(state);
      const treatmentTelemetry = state.telemetry.get(treatment.runId);
      treatment.conditionEvidence = {
        status: 'unavailable',
        delegationCallEventIds: [],
        delegationResultEventIds: [],
        specialistToolCallEventIds: [],
        specialistToolResultEventIds: [],
        specialistFileChangeEventIds: [],
        unavailableReason: 'delegation event field not exposed'
      };
      treatmentTelemetry.routing.delegationEvidence = {
        status: 'unavailable',
        callEventId: null,
        resultEventId: null,
        requestedAt: null,
        returnedAt: null,
        unavailableReason: 'delegation event field not exposed'
      };
      refreshAuthenticatedRawSource(state, treatment.runId);
      break;
    }
    case 'unavailableControlEvidenceIncluded': {
      const control = [...state.manifests.values()].find((item) => item.condition === 'control');
      const controlTelemetry = state.telemetry.get(control.runId);
      control.conditionEvidence = {
        status: 'unavailable',
        delegationCallEventIds: [],
        delegationResultEventIds: [],
        specialistToolCallEventIds: [],
        specialistToolResultEventIds: [],
        specialistFileChangeEventIds: [],
        unavailableReason: 'delegation event field not exposed'
      };
      controlTelemetry.routing.delegationEvidence = {
        status: 'unavailable',
        callEventId: null,
        resultEventId: null,
        requestedAt: null,
        returnedAt: null,
        unavailableReason: 'delegation event field not exposed'
      };
      break;
    }
    case 'crossObservationParentSpecialistOverlap': {
      const treatment = firstTreatment(state);
      const otherParent = [...state.manifests.values()]
        .find((manifest) => manifest.runId !== treatment.runId).sessions.parent.sessionId;
      treatment.sessions.specialist.sessionId = otherParent;
      break;
    }
    case 'specialistSessionReused': {
      const treatments = [...state.manifests.values()].filter((manifest) => manifest.condition === 'treatment');
      treatments[1].sessions.specialist.sessionId = treatments[0].sessions.specialist.sessionId;
      break;
    }
    case 'specialistLatencyMismatch': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).metrics.specialistLatencyMs.value += 1;
      break;
    }
    case 'controlParentWaitAvailable': {
      const control = [...state.manifests.values()].find((item) => item.condition === 'control');
      state.telemetry.get(control.runId).metrics.parentWaitLatencyMs = metric(0, 'milliseconds');
      break;
    }
    case 'treatmentParentWaitArbitraryWithoutEvidence': {
      const treatment = firstTreatment(state);
      const treatmentTelemetry = state.telemetry.get(treatment.runId);
      treatmentTelemetry.events = treatmentTelemetry.events.filter((event) => (
        event.type !== 'delegation_call' && event.type !== 'delegation_result'
      ));
      treatmentTelemetry.routing.delegationEvidence = {
        status: 'available',
        callEventId: null,
        resultEventId: null,
        requestedAt: null,
        returnedAt: null,
        unavailableReason: null
      };
      treatment.conditionEvidence.delegationCallEventIds = [];
      treatment.conditionEvidence.delegationResultEventIds = [];
      refreshAuthenticatedRawSource(state, treatment.runId);
      break;
    }
    case 'treatmentParentWaitMismatch': {
      const treatment = firstTreatment(state);
      state.telemetry.get(treatment.runId).metrics.parentWaitLatencyMs.value += 1;
      break;
    }
    case 'negativeToolDuration':
      firstTelemetry.tools[0].startedAt = '2026-07-28T00:00:04.000Z';
      break;
    case 'totalModelAggregateMismatch':
      firstTelemetry.metrics.totalSessionNanoAiu.value += 1;
      break;
    case 'outcomeBasedExclusionReason':
      firstManifest.attempt.status = 'excluded';
      firstManifest.exclusion = {
        excluded: true,
        reason: 'implementation_failure',
        retryOf: null,
        retryId: null
      };
      break;
    case 'controlSpecialistAggregateWrongReason': {
      const control = [...state.manifests.values()].find((item) => item.condition === 'control');
      state.telemetry.get(control.runId).metrics.specialistOutputTokens.unavailableReason = 'not exposed';
      break;
    }
    case 'judgeRootSessionOverlap':
      state.judgments.forEach((judgment) => {
        if (judgment.judgeBlock === 1) {
          judgment.judgeSessionId = firstManifest.execution.rootSessionId;
        }
      });
      break;
    default:
      throw new Error(`Unknown mutation ${name}`);
  }
  state.persist();
}

const temporaryRoot = path.join(root, '.scratch', 'tests', `ascii-benchmark-regression-${crypto.randomUUID()}`);
fs.mkdirSync(temporaryRoot, { recursive: true });
try {
  const positiveDirectory = path.join(temporaryRoot, 'positive');
  const positive = createDataset(positiveDirectory);
  let result = validate(positiveDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotThrow(() => assertNoConditionRevealingProvenance({
    source: 'The control flow updates the session cache model and records a treatment plan.',
    output: 'Ask a specialist when normal task policy requires one.'
  }, 'allowed normal task text'));
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    '$model = "task"\n$routing = "local"\n',
    [],
    'allowed ordinary domain assignments'
  ));
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    'An ordinary MODEL renders a user-selected identifier and updates the SESSION cache.',
    [parentModel, 'parent-P01-R1-control'],
    'allowed ordinary mixed-case content'
  ));
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    {
      paths: ['C:\\Projects\\P01-R1-output\\src\\TaskForge.ps1', null, 42],
      message: 'The user said "keep this path".\nNo run provenance is present.'
    },
    ['C:\\Trial\\P01-R1-control'],
    'allowed Windows-like content'
  ));
  const cyclicAllowed = { path: 'C:\\Projects\\ordinary\\file.ps1' };
  cyclicAllowed.self = cyclicAllowed;
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    cyclicAllowed,
    ['C:\\Trial\\P01-R1-control'],
    'allowed cyclic object'
  ));
  const windowsRunPath = String.raw`C:\Trial\P01-R1-control`;
  assert.strictEqual(windowsRunPath, 'C:\\Trial\\P01-R1-control');
  assert.strictEqual([...windowsRunPath].filter((character) => character === '\\').length, 2);
  assert.throws(
    () => assertNoProhibitedMetadata(
      JSON.parse(JSON.stringify({
        result: [null, { nested: { location: mixedCase(windowsRunPath) } }]
      })),
      [windowsRunPath],
      'nested Windows run path regression'
    ),
    (error) => error.message.includes('$[property:0].value[1]') &&
      !error.message.toLowerCase().includes(windowsRunPath.toLowerCase())
  );
  for (const [candidate, forbidden, name] of [
    [String.raw`C:\\Trial\\P01-R1-control`, windowsRunPath, 'doubled Windows separators'],
    ['C:/Trial/P01-R1-control', windowsRunPath, 'forward separators'],
    [String.raw`C:\/Trial\/P01-R1-control`, windowsRunPath, 'escaped forward separators'],
    [String.raw`\u005001-R1-control`, 'P01-R1-control', 'Unicode escape'],
    [String.raw`\\u005001-R1-control`, 'P01-R1-control', 'repeated Unicode escape'],
    [mixedCase(String.raw`C:\\Trial\\P01-R1-control`), windowsRunPath, 'decoded mixed case'],
    ['P01-R1-control', String.raw`\u005001-R1-control`, 'encoded forbidden value']
  ]) {
    assert.throws(
      () => assertNoProhibitedMetadata(
        { nested: [{ content: candidate }] },
        [forbidden],
        `${name} regression`
      ),
      /metadata leakage/,
      `${name} runtime value unexpectedly passed`
    );
  }
  const quotedForbidden = String.raw`C:\Trial\"quoted folder"\P01-R1-control`;
  const quotedRepresentation = String.raw`C:\\Trial\\\"quoted folder\"\\P01-R1-control`;
  assert.strictEqual(quotedForbidden, 'C:\\Trial\\"quoted folder"\\P01-R1-control');
  assert.ok(quotedRepresentation.includes(String.raw`\\\"`));
  assert.throws(
    () => assertNoProhibitedMetadata(
      { nested: { content: `prefix ${mixedCase(quotedRepresentation)} suffix` } },
      [quotedForbidden],
      'quoted and escaped forbidden-value regression'
    ),
    /metadata leakage/
  );
  assert.throws(
    () => assertNoProhibitedMetadata(
      { [mixedCase(windowsRunPath)]: 'redacted' },
      [windowsRunPath],
      'object-key provenance regression'
    ),
    (error) => error.message.endsWith('.key.') &&
      !error.message.toLowerCase().includes(windowsRunPath.toLowerCase())
  );
  assert.throws(
    () => assertNoProhibitedMetadata(
      { [String.raw`\u005001-R1-control`]: 'redacted' },
      ['P01-R1-control'],
      'encoded object-key provenance regression'
    ),
    /metadata leakage/
  );
  const surrogateRepresentation = String.raw`marker-\uD83D\uDE00-P01-R1-control`;
  const surrogateRuntimeValue = 'marker-😀-P01-R1-control';
  assert.ok(!surrogateRepresentation.includes('😀'));
  assert.ok(canonicalVariants(surrogateRepresentation).includes(surrogateRuntimeValue.toLowerCase()));
  assert.throws(
    () => assertNoProhibitedMetadata(
      surrogateRepresentation,
      [surrogateRuntimeValue],
      'surrogate-pair provenance regression'
    ),
    /metadata leakage/
  );
  const malformedEscapes = [
    String.raw`\u`,
    String.raw`\u12`,
    String.raw`\uZZZZ`,
    String.raw`\uD83D`,
    String.raw`\uDE00`,
    String.raw`\q`,
    '\uD800',
    'trailing-backslash' + '\\'
  ];
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    { nested: malformedEscapes },
    ['P01-R1-control'],
    'malformed escape safety regression'
  ));
  assert.throws(
    () => assertNoProhibitedMetadata(
      String.raw`\uZZZZ-P01-R1-control`,
      ['P01-R1-control'],
      'malformed escape scanning regression'
    ),
    /metadata leakage/
  );
  const beyondDecodeBound = String.raw`\\\\u005001-R1-control`;
  assert.ok(!canonicalVariants(beyondDecodeBound).includes('p01-r1-control'));
  assert.doesNotThrow(() => assertNoProhibitedMetadata(
    beyondDecodeBound,
    ['P01-R1-control'],
    'bounded repeated decoding regression'
  ));
  assert.throws(
    () => assertNoConditionRevealingProvenance(
      { 'Generated by delegated specialist': true },
      'object-key semantic provenance regression'
    ),
    /condition-revealing provenance marker/
  );
  assert.throws(
    () => assertNoConditionRevealingProvenance(
      { nested: [String.raw`Generated by delegated \u0073pecialist`] },
      'encoded semantic provenance regression'
    ),
    /condition-revealing provenance marker/
  );
  const leakageManifest = [...positive.manifests.values()][0];
  const leakageTreatment = firstTreatment(positive);
  for (const [value, forbidden] of [
    [parentModel.toUpperCase(), parentModel],
    [mixedCase(specialistModel), specialistModel],
    [mixedCase(leakageManifest.runId), leakageManifest.runId],
    [mixedCase(leakageManifest.execution.coordinatorSessionId), leakageManifest.execution.coordinatorSessionId],
    [mixedCase(leakageManifest.sessions.parent.sessionId), leakageManifest.sessions.parent.sessionId],
    [mixedCase(leakageTreatment.sessions.specialist.sessionId), leakageTreatment.sessions.specialist.sessionId],
    [mixedCase(leakageManifest.workspace.identifier), leakageManifest.workspace.identifier]
  ]) {
    assert.throws(
      () => assertNoProhibitedMetadata(value, [forbidden], 'case-variant exact-value regression'),
      /metadata leakage/
    );
  }
  const generatedBlindDirectory = path.join(temporaryRoot, 'generated-blind-bundles');
  result = runNode('bind-blind-bundles.js', [
    '--runs', path.join(positiveDirectory, 'raw'),
    '--artifacts', path.join(positiveDirectory, 'artifacts'),
    '--out', generatedBlindDirectory
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(
    fs.readdirSync(generatedBlindDirectory).filter((name) => name.endsWith('.binding.json')).length,
    66
  );
  assert.deepStrictEqual(
    readJson(path.join(generatedBlindDirectory, 'B0001.bundle.json')),
    positive.blindContents.get('B0001')
  );

  for (const testCase of cases) {
    const directory = path.join(temporaryRoot, testCase.id);
    const state = createDataset(directory);
    mutate(state, testCase.mutation);
    result = validate(directory);
    assert.notStrictEqual(result.status, 0, `${testCase.id} unexpectedly passed`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(testCase.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${testCase.id} did not emit its expected validation error`
    );
  }

  const excludedDirectory = path.join(temporaryRoot, 'wrong-model-excluded');
  const excluded = createDataset(excludedDirectory);
  const wrong = [...excluded.manifests.values()][0];
  mutate(excluded, 'wrongModelExcluded');
  const retryId = `${wrong.scheduleId}-A2`;
  const originalRunId = wrong.runId;
  const retryObservation = observations.find((item) => item.scheduleId === wrong.scheduleId);
  const retry = excluded.addRun(retryObservation, 2);
  const retryManifest = retry.manifest;
  retryManifest.exclusion = { excluded: false, reason: null, retryOf: originalRunId, retryId: null };
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => item.scheduleId === wrong.scheduleId)) {
      excluded.bindAssignment(block, assignment, retryId);
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

  const twiceExcludedDirectory = path.join(temporaryRoot, 'twice-excluded-infrastructure');
  const twiceExcluded = createDataset(twiceExcludedDirectory);
  const failedStartedManifest = [...twiceExcluded.manifests.values()][0];
  const failedObservation = observations.find((item) => (
    item.scheduleId === failedStartedManifest.scheduleId
  ));
  const failedRetryId = `${failedObservation.scheduleId}-A2`;
  const failedInitial = twiceExcluded.replaceWithPreExecutionFailure(
    failedObservation,
    1,
    'session_creation_failure',
    null,
    failedRetryId
  );
  const failedRetry = twiceExcluded.replaceWithPreExecutionFailure(
    failedObservation,
    2,
    'session_creation_failure',
    failedInitial.runId,
    null
  );
  assert.ok(!twiceExcluded.telemetry.has(failedInitial.runId));
  assert.ok(!twiceExcluded.telemetry.has(failedRetry.runId));
  assert.ok(!twiceExcluded.deterministic.has(failedInitial.runId));
  assert.ok(!twiceExcluded.deterministic.has(failedRetry.runId));
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  const expectedSelectedJudgments = assignments.blocks.flatMap((block) => block.artifacts)
    .filter((assignment) => assignment.scheduleId !== failedInitial.scheduleId).length;
  const twiceExcludedBlindDirectory = path.join(temporaryRoot, 'twice-excluded-generated-blind');
  result = runNode('bind-blind-bundles.js', [
    '--runs', path.join(twiceExcludedDirectory, 'raw'),
    '--artifacts', path.join(twiceExcludedDirectory, 'artifacts'),
    '--out', twiceExcludedBlindDirectory
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(
    fs.readdirSync(twiceExcludedBlindDirectory).filter((name) => name.endsWith('.binding.json')).length,
    expectedSelectedJudgments
  );
  const twiceExcludedSummaryPath = path.join(twiceExcludedDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(twiceExcludedDirectory, 'raw'),
    '--artifacts', path.join(twiceExcludedDirectory, 'artifacts'),
    '--judgments', path.join(twiceExcludedDirectory, 'judgments'),
    '--out', twiceExcludedSummaryPath,
    '--allow-incomplete'
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const twiceExcludedSummary = readJson(twiceExcludedSummaryPath);
  assert.strictEqual(twiceExcludedSummary.dataset.scheduled, 60);
  assert.strictEqual(twiceExcludedSummary.dataset.selectedRuns, 59);
  assert.deepStrictEqual(
    twiceExcludedSummary.dataset.completeness.missingScheduleIds,
    [failedInitial.scheduleId]
  );
  assert.deepStrictEqual(
    twiceExcludedSummary.dataset.completeness.excludedMissingSchedules,
    [{
      scheduleId: failedInitial.scheduleId,
      condition: failedInitial.condition,
      attempts: [
        { runId: failedInitial.runId, reason: 'session_creation_failure' },
        { runId: failedRetry.runId, reason: 'session_creation_failure' }
      ]
    }]
  );
  assert.ok(twiceExcludedSummary.intentToTreat.outcomes.every((outcome) => (
    outcome.completeness.inferentialOutput === 'withheld' &&
    outcome.promptClusteredBootstrap95.status === 'unavailable'
  )));
  failedRetry.exclusion.retryOf = observations
    .find((item) => item.scheduleId !== failedInitial.scheduleId).scheduleId + '-A1';
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Malformed twice-excluded retry linkage unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /reciprocal retryId\/retryOf linkage/);
  failedRetry.exclusion.retryOf = failedInitial.runId;
  failedRetry.exclusion.reason = 'implementation_failure';
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Outcome-based second infrastructure failure reason unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /must match exactly one oneOf branch/);
  failedRetry.exclusion.reason = 'session_creation_failure';

  const startedEvidence = positive.manifests.get(failedInitial.runId);
  failedInitial.execution.rootSessionId = startedEvidence.execution.rootSessionId;
  failedInitial.execution.coordinatorSessionId = startedEvidence.execution.coordinatorSessionId;
  failedInitial.sessions = structuredClone(startedEvidence.sessions);
  failedInitial.refs = structuredClone(startedEvidence.refs);
  failedInitial.completion = 'failed';
  failedInitial.conditionEvidence = {
    status: 'unavailable',
    delegationCallEventIds: [],
    delegationResultEventIds: [],
    specialistToolCallEventIds: [],
    specialistToolResultEventIds: [],
    specialistFileChangeEventIds: [],
    unavailableReason: 'fabricated'
  };
  twiceExcluded.telemetry.set(
    failedInitial.runId,
    structuredClone(positive.telemetry.get(failedInitial.runId))
  );
  twiceExcluded.rawSources.set(
    failedInitial.runId,
    structuredClone(positive.rawSources.get(failedInitial.runId))
  );
  twiceExcluded.artifacts.set(
    failedInitial.runId,
    structuredClone(positive.artifacts.get(failedInitial.runId))
  );
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Pre-execution attempt with attached session/evidence records unexpectedly passed.');
  const attachedEvidenceOutput = `${result.stdout}\n${result.stderr}`;
  assert.match(attachedEvidenceOutput, /conditionEvidence is not allowed/);
  assert.match(attachedEvidenceOutput, /sessions is not allowed/);
  assert.match(attachedEvidenceOutput, /refs is not allowed/);
  assert.match(attachedEvidenceOutput, /completion is not allowed/);
  assert.match(attachedEvidenceOutput, /additional run-associated raw records/);
  assert.match(attachedEvidenceOutput, /pre-execution attempt must not have telemetry/);
  assert.match(attachedEvidenceOutput, /pre-execution attempt must not have artifact/);
  delete failedInitial.execution.rootSessionId;
  delete failedInitial.execution.coordinatorSessionId;
  delete failedInitial.sessions;
  delete failedInitial.refs;
  delete failedInitial.completion;
  delete failedInitial.conditionEvidence;
  twiceExcluded.telemetry.delete(failedInitial.runId);
  twiceExcluded.rawSources.delete(failedInitial.runId);
  twiceExcluded.artifacts.delete(failedInitial.runId);

  delete failedInitial.attempt.phase;
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Pre-execution attempt without an explicit phase unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /attempt.*phase is required/);
  failedInitial.attempt.phase = 'pre_execution';

  delete failedInitial.recordType;
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Pre-execution attempt without its dedicated record type unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /must be either a session-started manifest or an explicit pre-execution failure|run-manifest/);
  failedInitial.recordType = 'pre_execution_failure';

  const fabricatedDeterministic = structuredClone(
    positive.deterministic.get(failedInitial.runId)
  );
  twiceExcluded.deterministic.set(failedInitial.runId, fabricatedDeterministic);
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Pre-execution attempt with a fabricated deterministic outcome unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /pre-execution attempt must not have telemetry or deterministic outcome/);
  twiceExcluded.deterministic.delete(failedInitial.runId);

  failedInitial.exclusion.reason = 'wrong_model';
  twiceExcluded.persist();
  result = validate(twiceExcludedDirectory);
  assert.notStrictEqual(result.status, 0, 'Model failure reclassified as pre-execution infrastructure unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /must match exactly one oneOf branch|allowed pre-execution infrastructure reason/);
  failedInitial.exclusion.reason = 'session_creation_failure';
  twiceExcluded.persist();

  const missingStartedDirectory = path.join(temporaryRoot, 'post-start-missing-evidence');
  const missingStarted = createDataset(missingStartedDirectory);
  const missingStartedInitial = [...missingStarted.manifests.values()][0];
  const missingStartedObservation = observations.find((item) => (
    item.scheduleId === missingStartedInitial.scheduleId
  ));
  missingStartedInitial.attempt.status = 'excluded';
  missingStartedInitial.exclusion = {
    excluded: true,
    reason: 'telemetry_collection_failure',
    retryOf: null,
    retryId: `${missingStartedInitial.scheduleId}-A2`
  };
  const missingStartedRetry = missingStarted.addRun(missingStartedObservation, 2).manifest;
  missingStartedRetry.exclusion = {
    excluded: false,
    reason: null,
    retryOf: missingStartedInitial.runId,
    retryId: null
  };
  missingStarted.telemetry.delete(missingStartedInitial.runId);
  missingStarted.deterministic.delete(missingStartedInitial.runId);
  missingStarted.rawSources.delete(missingStartedInitial.runId);
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => (
      item.scheduleId === missingStartedInitial.scheduleId
    ))) {
      missingStarted.bindAssignment(block, assignment, missingStartedRetry.runId);
    }
  }
  missingStarted.persist();
  result = validate(missingStartedDirectory);
  assert.notStrictEqual(result.status, 0, 'Session-started exclusion without telemetry/deterministic evidence unexpectedly passed.');
  assert.match(`${result.stdout}\n${result.stderr}`, /session-started attempt|matching telemetry and deterministic records/);

  const unavailableEvidenceDirectory = path.join(temporaryRoot, 'excluded-unavailable-evidence');
  const unavailableEvidence = createDataset(unavailableEvidenceDirectory);
  const unavailableManifest = firstTreatment(unavailableEvidence);
  const unavailableTelemetry = unavailableEvidence.telemetry.get(unavailableManifest.runId);
  unavailableManifest.attempt.status = 'excluded';
  unavailableManifest.exclusion = {
    excluded: true,
    reason: 'telemetry_collection_failure',
    retryOf: null,
    retryId: `${unavailableManifest.scheduleId}-A2`
  };
  unavailableManifest.conditionEvidence = {
    status: 'unavailable',
    delegationCallEventIds: [],
    delegationResultEventIds: [],
    specialistToolCallEventIds: [],
    specialistToolResultEventIds: [],
    specialistFileChangeEventIds: [],
    unavailableReason: 'delegation event field not exposed'
  };
  unavailableTelemetry.routing.delegationEvidence = {
    status: 'unavailable',
    callEventId: null,
    resultEventId: null,
    requestedAt: null,
    returnedAt: null,
    unavailableReason: 'delegation event field not exposed'
  };
  unavailableTelemetry.metrics.parentWaitLatencyMs =
    unavailable('milliseconds', 'delegation event field not exposed');
  unavailableTelemetry.events = unavailableTelemetry.events.filter((event) => (
    event.type !== 'delegation_call' && event.type !== 'delegation_result'
  ));
  refreshAuthenticatedRawSource(unavailableEvidence, unavailableManifest.runId);
  const unavailableRetry = unavailableEvidence.addRun(
    observations.find((item) => item.scheduleId === unavailableManifest.scheduleId),
    2
  ).manifest;
  unavailableRetry.exclusion = {
    excluded: false,
    reason: null,
    retryOf: unavailableManifest.runId,
    retryId: null
  };
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => (
      item.scheduleId === unavailableManifest.scheduleId
    ))) {
      unavailableEvidence.bindAssignment(block, assignment, unavailableRetry.runId);
    }
  }
  unavailableEvidence.persist();
  result = validate(unavailableEvidenceDirectory);
  assert.strictEqual(result.status, 0, result.stderr);

  const unavailableControlDirectory = path.join(temporaryRoot, 'excluded-unavailable-control-evidence');
  const unavailableControl = createDataset(unavailableControlDirectory);
  const unavailableControlManifest = [...unavailableControl.manifests.values()]
    .find((manifest) => manifest.condition === 'control');
  const unavailableControlTelemetry = unavailableControl.telemetry.get(unavailableControlManifest.runId);
  unavailableControlManifest.attempt.status = 'excluded';
  unavailableControlManifest.exclusion = {
    excluded: true,
    reason: 'telemetry_collection_failure',
    retryOf: null,
    retryId: `${unavailableControlManifest.scheduleId}-A2`
  };
  unavailableControlManifest.conditionEvidence = {
    status: 'unavailable',
    delegationCallEventIds: [],
    delegationResultEventIds: [],
    specialistToolCallEventIds: [],
    specialistToolResultEventIds: [],
    specialistFileChangeEventIds: [],
    unavailableReason: 'delegation event field not exposed'
  };
  unavailableControlTelemetry.routing.delegationEvidence = {
    status: 'unavailable',
    callEventId: null,
    resultEventId: null,
    requestedAt: null,
    returnedAt: null,
    unavailableReason: 'delegation event field not exposed'
  };
  const unavailableControlRetry = unavailableControl.addRun(
    observations.find((item) => item.scheduleId === unavailableControlManifest.scheduleId),
    2
  ).manifest;
  unavailableControlRetry.exclusion = {
    excluded: false,
    reason: null,
    retryOf: unavailableControlManifest.runId,
    retryId: null
  };
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => (
      item.scheduleId === unavailableControlManifest.scheduleId
    ))) {
      unavailableControl.bindAssignment(block, assignment, unavailableControlRetry.runId);
    }
  }
  unavailableControl.persist();
  result = validate(unavailableControlDirectory);
  assert.strictEqual(result.status, 0, result.stderr);

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
  assert.strictEqual(summary.dataset.completeness.status, 'complete');
  assert.strictEqual(binary.unit, 'percentage_points');
  assert.strictEqual(binary.meanPairedDifference, 100);
  assert.strictEqual(binary.completeness.status, 'complete');
  assert.strictEqual(binary.completeness.inferentialOutput, 'available');
  assert.strictEqual(binary.promptClusteredBootstrap95.status, 'available');
  assert.ok(summary.intentToTreat.secondaryTelemetry.treatment.models[`${'specialist'}:${specialistModel}`].cachedTokens);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.exposedTools.write_file, 30);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.control.toolEvents.view.calls, 30);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.compaction.events, 30);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.compaction.aggregateEventCount.mean, 1);
  assert.strictEqual(summary.intentToTreat.secondaryTelemetry.treatment.routingEvidence.delegationStatus.available, 30);
  assert.strictEqual(summary.intentToTreat.validatedConditionCompliance.noncompliant, 0);
  const parentWait = summary.intentToTreat.outcomes.find((item) => item.outcome === 'parentWaitLatencyMs');
  assert.strictEqual(parentWait.missingnessByCondition.control.available, 0);
  assert.strictEqual(parentWait.missingnessByCondition.control.missingOrUnavailable, 30);
  assert.strictEqual(parentWait.missingnessByCondition.treatment.available, 30);
  assert.strictEqual(parentWait.missingnessByCondition.treatment.mean, 1000);
  assert.strictEqual(
    summary.intentToTreat.secondaryTelemetry.control.unavailableCounts.aggregateMetrics.parentWaitLatencyMs,
    30
  );
  assert.strictEqual(
    summary.intentToTreat.secondaryTelemetry.treatment.unavailableCounts.aggregateMetrics.parentWaitLatencyMs,
    0
  );

  const noncompliantDirectory = path.join(temporaryRoot, 'authenticated-noncompliance');
  const noncompliant = createDataset(noncompliantDirectory);
  const noncompliantManifest = firstTreatment(noncompliant);
  const noncompliantTelemetry = noncompliant.telemetry.get(noncompliantManifest.runId);
  const specialistSessionId = noncompliantManifest.sessions.specialist.sessionId;
  noncompliantTelemetry.tools.find((tool) => tool.sessionId === specialistSessionId).targetPath = 'src/other.ps1';
  noncompliantTelemetry.events.find((event) => (
    event.type === 'tool_call' && event.sessionId === specialistSessionId
  )).path = 'src/other.ps1';
  noncompliantTelemetry.events.find((event) => (
    event.type === 'file_change' && event.sessionId === specialistSessionId
  )).path = 'src/other.ps1';
  refreshAuthenticatedRawSource(noncompliant, noncompliantManifest.runId);
  noncompliant.persist();
  result = validate(noncompliantDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  const noncompliantSummaryPath = path.join(noncompliantDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(noncompliantDirectory, 'raw'),
    '--artifacts', path.join(noncompliantDirectory, 'artifacts'),
    '--judgments', path.join(noncompliantDirectory, 'judgments'),
    '--out', noncompliantSummaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const noncompliantSummary = readJson(noncompliantSummaryPath);
  assert.strictEqual(noncompliantSummary.intentToTreat.validatedConditionCompliance.noncompliant, 1);
  assert.strictEqual(noncompliantSummary.perProtocol.observationsIncluded, 59);

  const delegatedImplementationDirectory = path.join(temporaryRoot, 'delegated-implementation');
  const delegatedImplementation = createDataset(delegatedImplementationDirectory);
  const delegatedManifest = firstTreatment(delegatedImplementation);
  const delegatedTelemetry = delegatedImplementation.telemetry.get(delegatedManifest.runId);
  delegatedTelemetry.events.filter((event) => (
    event.type === 'delegation_call' || event.type === 'delegation_result'
  )).forEach((event) => {
    event.scope = 'implement_feature';
    event.path = 'src/TaskForge.ps1';
  });
  refreshAuthenticatedRawSource(delegatedImplementation, delegatedManifest.runId);
  delegatedImplementation.persist();
  result = validate(delegatedImplementationDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  const delegatedSummaryPath = path.join(delegatedImplementationDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(delegatedImplementationDirectory, 'raw'),
    '--artifacts', path.join(delegatedImplementationDirectory, 'artifacts'),
    '--judgments', path.join(delegatedImplementationDirectory, 'judgments'),
    '--out', delegatedSummaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readJson(delegatedSummaryPath).perProtocol.observationsIncluded, 59);

  const controlDelegationDirectory = path.join(temporaryRoot, 'control-delegation');
  const controlDelegation = createDataset(controlDelegationDirectory);
  const controlManifest = [...controlDelegation.manifests.values()]
    .find((manifest) => manifest.condition === 'control');
  const controlTelemetry = controlDelegation.telemetry.get(controlManifest.runId);
  const controlSourceId = controlTelemetry.rawSources[0].sourceId;
  const controlParentId = controlManifest.sessions.parent.sessionId;
  const controlPrompt = readJson(path.join(root, 'prompts.json'))
    .find((prompt) => prompt.id === controlManifest.promptId);
  controlTelemetry.events.push(
    {
      eventId: `control-delegate-call-${controlManifest.runId}`,
      sessionId: controlParentId,
      sequence: 6,
      type: 'delegation_call',
      timestamp: '2026-07-28T00:00:05.000Z',
      callId: `control-delegate-${controlManifest.runId}`,
      toolName: null,
      success: null,
      targetSessionId: 'unrecorded-specialist',
      requestedModel: specialistModel,
      scope: 'create_banner_only',
      path: controlPrompt.banner.path,
      operation: null,
      resultBytes: null,
      usage: null,
      rawSourceId: controlSourceId
    },
    {
      eventId: `control-delegate-result-${controlManifest.runId}`,
      sessionId: controlParentId,
      sequence: 7,
      type: 'delegation_result',
      timestamp: '2026-07-28T00:00:06.000Z',
      callId: `control-delegate-${controlManifest.runId}`,
      toolName: null,
      success: null,
      targetSessionId: 'unrecorded-specialist',
      requestedModel: null,
      scope: 'create_banner_only',
      path: controlPrompt.banner.path,
      operation: null,
      resultBytes: null,
      usage: null,
      rawSourceId: controlSourceId
    }
  );
  controlManifest.conditionEvidence.delegationCallEventIds = [
    `control-delegate-call-${controlManifest.runId}`
  ];
  controlManifest.conditionEvidence.delegationResultEventIds = [
    `control-delegate-result-${controlManifest.runId}`
  ];
  refreshAuthenticatedRawSource(controlDelegation, controlManifest.runId);
  controlDelegation.persist();
  result = validate(controlDelegationDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  const controlSummaryPath = path.join(controlDelegationDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(controlDelegationDirectory, 'raw'),
    '--artifacts', path.join(controlDelegationDirectory, 'artifacts'),
    '--judgments', path.join(controlDelegationDirectory, 'judgments'),
    '--out', controlSummaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readJson(controlSummaryPath).perProtocol.observationsIncluded, 59);

  const noDelegationDirectory = path.join(temporaryRoot, 'treatment-no-delegation');
  const noDelegation = createDataset(noDelegationDirectory);
  const noDelegationManifest = firstTreatment(noDelegation);
  const noDelegationTelemetry = noDelegation.telemetry.get(noDelegationManifest.runId);
  const noDelegationSpecialistId = noDelegationManifest.sessions.specialist.sessionId;
  noDelegationManifest.sessions.specialist = {
    status: 'unavailable',
    reason: 'specialist_session_not_created'
  };
  noDelegationManifest.conditionEvidence = {
    status: 'available',
    delegationCallEventIds: [],
    delegationResultEventIds: [],
    specialistToolCallEventIds: [],
    specialistToolResultEventIds: [],
    specialistFileChangeEventIds: [],
    unavailableReason: null
  };
  noDelegationTelemetry.models = noDelegationTelemetry.models.filter((model) => model.role !== 'specialist');
  noDelegationTelemetry.exposedTools = ['view'];
  noDelegationTelemetry.tools = noDelegationTelemetry.tools.filter((tool) => tool.sessionId !== noDelegationSpecialistId);
  noDelegationTelemetry.events = noDelegationTelemetry.events.filter((event) => (
    event.sessionId !== noDelegationSpecialistId &&
    event.type !== 'delegation_call' &&
    event.type !== 'delegation_result'
  ));
  noDelegationTelemetry.routing.specialist = {
    status: 'unavailable',
    reason: 'specialist_session_not_created'
  };
  noDelegationTelemetry.routing.delegationEvidence = {
    status: 'available',
    callEventId: null,
    resultEventId: null,
    requestedAt: null,
    returnedAt: null,
    unavailableReason: null
  };
  noDelegationTelemetry.metrics.totalSessionAiCredits = unavailable('credits', 'incomplete_treatment_role_usage');
  noDelegationTelemetry.metrics.totalSessionNanoAiu = unavailable('nano_aiu', 'incomplete_treatment_role_usage');
  noDelegationTelemetry.metrics.specialistCumulativeInputTokens = unavailable('tokens', 'specialist_session_not_created');
  noDelegationTelemetry.metrics.specialistPeakInputTokens = unavailable('tokens', 'specialist_session_not_created');
  noDelegationTelemetry.metrics.specialistOutputTokens = unavailable('tokens', 'specialist_session_not_created');
  noDelegationTelemetry.metrics.specialistLatencyMs = unavailable('milliseconds', 'specialist_session_not_created');
  noDelegationTelemetry.metrics.parentWaitLatencyMs = unavailable('milliseconds', 'specialist_session_not_created');
  noDelegationTelemetry.metrics.exposedToolCount = metric(1);
  noDelegationTelemetry.metrics.toolCallCount = metric(1);
  noDelegationTelemetry.metrics.toolResultCount = metric(1);
  refreshAuthenticatedRawSource(noDelegation, noDelegationManifest.runId);
  noDelegation.persist();
  result = validate(noDelegationDirectory);
  assert.strictEqual(result.status, 0, result.stderr);
  const noDelegationSummaryPath = path.join(noDelegationDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(noDelegationDirectory, 'raw'),
    '--artifacts', path.join(noDelegationDirectory, 'artifacts'),
    '--judgments', path.join(noDelegationDirectory, 'judgments'),
    '--out', noDelegationSummaryPath
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readJson(noDelegationSummaryPath).perProtocol.observationsIncluded, 59);

  const partialDelegationDirectory = path.join(temporaryRoot, 'treatment-partial-delegation');
  const partialDelegation = createDataset(partialDelegationDirectory);
  const partialManifest = firstTreatment(partialDelegation);
  const partialTelemetry = partialDelegation.telemetry.get(partialManifest.runId);
  const partialSpecialistId = partialManifest.sessions.specialist.sessionId;
  partialManifest.sessions.specialist = {
    status: 'unavailable',
    reason: 'specialist_session_not_created'
  };
  partialManifest.conditionEvidence = {
    status: 'available',
    delegationCallEventIds: [`delegate-call-${partialManifest.runId}`],
    delegationResultEventIds: [],
    specialistToolCallEventIds: [],
    specialistToolResultEventIds: [],
    specialistFileChangeEventIds: [],
    unavailableReason: null
  };
  partialTelemetry.models = partialTelemetry.models.filter((model) => model.role !== 'specialist');
  partialTelemetry.exposedTools = ['view'];
  partialTelemetry.tools = partialTelemetry.tools.filter((tool) => tool.sessionId !== partialSpecialistId);
  partialTelemetry.events = partialTelemetry.events.filter((event) => (
    event.sessionId !== partialSpecialistId && event.type !== 'delegation_result'
  ));
  partialTelemetry.routing.specialist = {
    status: 'unavailable',
    reason: 'specialist_session_not_created'
  };
  partialTelemetry.routing.delegationEvidence = {
    status: 'available',
    callEventId: `delegate-call-${partialManifest.runId}`,
    resultEventId: null,
    requestedAt: '2026-07-28T00:00:05.000Z',
    returnedAt: null,
    unavailableReason: null
  };
  partialTelemetry.metrics.totalSessionAiCredits = unavailable('credits', 'incomplete_treatment_role_usage');
  partialTelemetry.metrics.totalSessionNanoAiu = unavailable('nano_aiu', 'incomplete_treatment_role_usage');
  partialTelemetry.metrics.specialistCumulativeInputTokens = unavailable('tokens', 'specialist_session_not_created');
  partialTelemetry.metrics.specialistPeakInputTokens = unavailable('tokens', 'specialist_session_not_created');
  partialTelemetry.metrics.specialistOutputTokens = unavailable('tokens', 'specialist_session_not_created');
  partialTelemetry.metrics.specialistLatencyMs = unavailable('milliseconds', 'specialist_session_not_created');
  partialTelemetry.metrics.parentWaitLatencyMs = unavailable('milliseconds', 'delegation result not available');
  partialTelemetry.metrics.exposedToolCount = metric(1);
  partialTelemetry.metrics.toolCallCount = metric(1);
  partialTelemetry.metrics.toolResultCount = metric(1);
  refreshAuthenticatedRawSource(partialDelegation, partialManifest.runId);
  partialDelegation.persist();
  result = validate(partialDelegationDirectory);
  assert.strictEqual(result.status, 0, result.stderr);

  const missingBannerDirectory = path.join(temporaryRoot, 'failed-missing-banner');
  const missingBanner = createDataset(missingBannerDirectory);
  const missingBannerManifest = [...missingBanner.manifests.values()][0];
  const missingBannerDeterministic = missingBanner.deterministic.get(missingBannerManifest.runId);
  const missingBannerBundle = missingBanner.artifactBundles.get(missingBannerManifest.runId);
  missingBannerDeterministic.status = 'fail';
  missingBannerDeterministic.unavailableReason = null;
  missingBannerDeterministic.art = {
    status: 'fail',
    unavailableReason: null,
    assertions: [{ id: 'art', status: 'fail', message: 'banner was not created' }]
  };
  missingBannerBundle.deterministic = sanitizedDeterministic(missingBannerDeterministic);
  missingBannerBundle.files = missingBannerBundle.files.filter((file) => file.role !== 'banner');
  missingBanner.artifacts.get(missingBannerManifest.runId).files =
    missingBanner.artifacts.get(missingBannerManifest.runId).files.filter((file) => file.role !== 'banner');
  refreshArtifactHash(missingBanner, missingBannerManifest.runId);
  for (const block of assignments.blocks) {
    for (const assignment of block.artifacts.filter((item) => item.scheduleId === missingBannerManifest.scheduleId)) {
      missingBanner.bindAssignment(block, assignment, missingBannerManifest.runId);
    }
  }
  missingBanner.persist();
  result = validate(missingBannerDirectory);
  assert.strictEqual(result.status, 0, result.stderr);

  const emptyDirectory = path.join(temporaryRoot, 'empty-foundation');
  for (const name of ['raw', 'artifacts', 'judgments']) {
    fs.mkdirSync(path.join(emptyDirectory, name), { recursive: true });
  }
  const emptySummaryPath = path.join(emptyDirectory, 'summary.json');
  result = runNode('summarize.js', [
    '--runs', path.join(emptyDirectory, 'raw'),
    '--artifacts', path.join(emptyDirectory, 'artifacts'),
    '--judgments', path.join(emptyDirectory, 'judgments'),
    '--out', emptySummaryPath
  ]);
  assert.notStrictEqual(result.status, 0, 'Empty analysis must require an intentional --allow-incomplete dry-run.');
  result = runNode('summarize.js', [
    '--runs', path.join(emptyDirectory, 'raw'),
    '--artifacts', path.join(emptyDirectory, 'artifacts'),
    '--judgments', path.join(emptyDirectory, 'judgments'),
    '--out', emptySummaryPath,
    '--allow-incomplete'
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const emptySummary = readJson(emptySummaryPath);
  assert.strictEqual(emptySummary.dataset.completeness.status, 'empty_foundation_dry_run');
  assert.ok(emptySummary.intentToTreat.outcomes.every((outcome) => (
    outcome.completeness.status === 'incomplete' &&
    outcome.completeness.inferentialOutput === 'withheld' &&
    outcome.promptClusteredBootstrap95.status === 'unavailable'
  )));

  const unavailableResult = positive.deterministic.get(observations[0].scheduleId + '-A1');
  unavailableResult.status = 'unavailable';
  unavailableResult.unavailableReason = 'acceptance runner unavailable';
  unavailableResult.functional = {
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
  assert.strictEqual(binary.completeness.status, 'incomplete');
  assert.strictEqual(binary.completeness.inferentialOutput, 'withheld');
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

  console.log(`PASS: ${cases.length} fixture integrity negatives, 6 pre-execution negatives, excluded positives, and analysis regressions`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
