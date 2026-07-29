'use strict';

const { specialistModel } = require('./lib');

const modelMetricFields = ['aiCredits', 'nanoAiu', 'inputTokens', 'peakInputTokens', 'outputTokens', 'cachedTokens'];

function metricValue(metric) {
  return metric && metric.status === 'available' && typeof metric.value === 'number'
    ? metric.value
    : null;
}

function requireMetricValue(metric, expected, label, errors) {
  if (!metric || metric.status !== 'available' || metric.value !== expected) {
    errors.push(`${label} must be available and equal authenticated raw-event aggregate ${expected}`);
  }
}

function requireUnavailable(metric, label, errors, expectedReason = null) {
  if (!metric || metric.status !== 'unavailable' || metric.value !== null ||
      typeof metric.unavailableReason !== 'string' || metric.unavailableReason.length === 0 ||
      (expectedReason !== null && metric.unavailableReason !== expectedReason)) {
    errors.push(`${label} must be unavailable with null value and a reason`);
  }

}

function sameUniqueIds(actual, expected) {
  return Array.isArray(actual) &&
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function derivedConditionEvidence(manifest, telemetry) {
  const specialistId = manifest.condition === 'treatment' && manifest.sessions.specialist.sessionId
    ? manifest.sessions.specialist.sessionId
    : null;
  return {
    delegationCallEventIds: telemetry.events
      .filter((event) => event.type === 'delegation_call')
      .map((event) => event.eventId),
    delegationResultEventIds: telemetry.events
      .filter((event) => event.type === 'delegation_result')
      .map((event) => event.eventId),
    specialistToolCallEventIds: specialistId
      ? telemetry.tools.filter((tool) => tool.sessionId === specialistId).map((tool) => tool.callEventId)
      : [],
    specialistToolResultEventIds: specialistId
      ? telemetry.tools
        .filter((tool) => tool.sessionId === specialistId && tool.resultEventId !== null)
        .map((tool) => tool.resultEventId)
      : [],
    specialistFileChangeEventIds: specialistId
      ? telemetry.events
        .filter((event) => event.type === 'file_change' && event.sessionId === specialistId)
        .map((event) => event.eventId)
      : []
  };
}

function reconcileMetric(target, source, label, errors) {
  const value = metricValue(source);
  if (value === null) {
    requireUnavailable(target, label, errors);
  } else {
    requireMetricValue(target, value, label, errors);
  }
}

function validateEventShape(event, errors) {
  const populated = (name) => event[name] !== null;
  const requireNull = (...names) => names.forEach((name) => {
    if (populated(name)) errors.push(`raw event ${event.eventId} ${name} must be null for ${event.type}`);
  });
  switch (event.type) {
    case 'session_start':
      requireNull('callId', 'toolName', 'success', 'targetSessionId', 'requestedModel', 'scope', 'path', 'operation', 'resultBytes', 'usage');
      break;
    case 'usage':
      if (!event.usage) errors.push(`raw usage event ${event.eventId} must contain usage values`);
      requireNull('callId', 'toolName', 'success', 'targetSessionId', 'requestedModel', 'scope', 'path', 'operation', 'resultBytes');
      break;
    case 'tool_call':
      if (!populated('callId') || !populated('toolName')) {
        errors.push(`raw tool call ${event.eventId} must contain callId and toolName`);
      }
      requireNull('success', 'targetSessionId', 'requestedModel', 'scope', 'operation', 'resultBytes', 'usage');
      break;
    case 'tool_result':
      if (!populated('callId') || !populated('toolName') || !populated('success') || !populated('resultBytes')) {
        errors.push(`raw tool result ${event.eventId} must contain callId, toolName, success, and resultBytes`);
      }
      requireNull('targetSessionId', 'requestedModel', 'scope', 'path', 'operation', 'usage');
      break;
    case 'delegation_call':
      if (!populated('callId') || !populated('targetSessionId') || !populated('requestedModel') ||
          !populated('scope') || !populated('path')) {
        errors.push(`raw delegation call ${event.eventId} must contain target, model, scope, and path`);
      }
      requireNull('toolName', 'success', 'operation', 'resultBytes', 'usage');
      break;
    case 'delegation_result':
      if (!populated('callId') || !populated('targetSessionId') || !populated('scope') || !populated('path')) {
        errors.push(`raw delegation result ${event.eventId} must contain target, scope, and path`);
      }
      requireNull('toolName', 'success', 'requestedModel', 'operation', 'resultBytes', 'usage');
      break;
    case 'file_change':
      if (!populated('path') || !populated('operation')) {
        errors.push(`raw file-change event ${event.eventId} must contain path and operation`);
      }
      requireNull('callId', 'toolName', 'success', 'targetSessionId', 'requestedModel', 'scope', 'resultBytes', 'usage');
      break;
    case 'compaction':
      if (!populated('resultBytes')) errors.push(`raw compaction event ${event.eventId} must contain resultBytes`);
      requireNull('callId', 'toolName', 'success', 'targetSessionId', 'requestedModel', 'scope', 'path', 'operation', 'usage');
      break;
    default:
      break;
  }
}

function evaluateConditionCompliance(manifest, telemetry, prompt) {
  if (!manifest || !telemetry || !prompt) {
    return { compliant: false, reasons: ['missing manifest, telemetry, or prompt evidence'], evidenceEventIds: [] };
  }
  const events = telemetry.events || [];
  const delegations = events.filter((event) => event.type === 'delegation_call' || event.type === 'delegation_result');
  const evidence = telemetry.routing.delegationEvidence;
  if (evidence.status === 'unavailable') {
    return {
      compliant: false,
      reasons: ['delegation event fields were unavailable'],
      evidenceEventIds: []
    };
  }
  if (manifest.condition === 'control') {
    return {
      compliant: delegations.length === 0,
      reasons: delegations.length === 0 ? [] : ['control emitted delegation events'],
      evidenceEventIds: delegations.map((event) => event.eventId)
    };
  }

  const parentId = manifest.sessions.parent.sessionId;
  const specialistId = manifest.sessions.specialist.sessionId;
  const call = events.find((event) => event.eventId === evidence.callEventId);
  const result = events.find((event) => event.eventId === evidence.resultEventId);
  const specialistTools = telemetry.tools.filter((tool) => tool.sessionId === specialistId);
  const specialistChanges = events.filter((event) => event.type === 'file_change' && event.sessionId === specialistId);
  const reasons = [];
  if (delegations.filter((event) => event.type === 'delegation_call').length !== 1 ||
      delegations.filter((event) => event.type === 'delegation_result').length !== 1) {
    reasons.push('treatment must contain exactly one delegation call/result pair');
  }
  if (!call || call.type !== 'delegation_call' || call.sessionId !== parentId ||
      call.targetSessionId !== specialistId || call.requestedModel !== specialistModel ||
      call.scope !== 'create_banner_only' || call.path !== prompt.banner.path) {
    reasons.push('delegation call is not limited to the preregistered banner');
  }
  if (!result || result.type !== 'delegation_result' || result.sessionId !== parentId ||
      result.targetSessionId !== specialistId || result.callId !== call?.callId ||
      result.scope !== 'create_banner_only' || result.path !== prompt.banner.path) {
    reasons.push('delegation result does not match the banner-only call');
  }
  if (specialistTools.length === 0 ||
      specialistTools.some((tool) => tool.targetPath !== prompt.banner.path)) {
    reasons.push('specialist tools must target only the preregistered banner path');
  }
  if (specialistChanges.length === 0 ||
      specialistChanges.some((event) => event.path !== prompt.banner.path)) {
    reasons.push('specialist file changes must edit only the preregistered banner path');
  }
  return {
    compliant: reasons.length === 0,
    reasons,
    evidenceEventIds: [call?.eventId, result?.eventId, ...specialistChanges.map((event) => event.eventId)].filter(Boolean)
  };
}

function validateTelemetryConsistency(manifest, telemetry, prompt) {
  const errors = [];
  const events = telemetry.events || [];
  const eventIds = events.map((event) => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) errors.push('raw event IDs must be unique within each run');
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const sequenceKeys = events.map((event) => `${event.sessionId}:${event.sequence}`);
  if (new Set(sequenceKeys).size !== sequenceKeys.length) errors.push('raw event sequences must be unique per session');
  events.forEach((event) => validateEventShape(event, errors));
  for (const sessionId of new Set(events.map((event) => event.sessionId))) {
    const sessionEvents = events
      .filter((event) => event.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < sessionEvents.length; index += 1) {
      if (Date.parse(sessionEvents[index].timestamp) < Date.parse(sessionEvents[index - 1].timestamp)) {
        errors.push(`raw event timestamps must not go backwards within session ${sessionId}`);
        break;
      }
    }
  }

  const allowedSessions = new Set([manifest.sessions.parent.sessionId]);
  if (manifest.condition === 'treatment' && manifest.sessions.specialist.sessionId) {
    allowedSessions.add(manifest.sessions.specialist.sessionId);
  }
  events.forEach((event) => {
    if (!allowedSessions.has(event.sessionId)) {
      errors.push(`raw event ${event.eventId} session must belong to the manifest parent or treatment specialist`);
    }
  });

  for (const routing of [telemetry.routing.parent, telemetry.routing.specialist]) {
    if (!routing.sourceEventIds) continue;
    routing.sourceEventIds.forEach((eventId) => {
      const event = eventById.get(eventId);
      if (!event || event.type !== 'session_start' || event.sessionId !== routing.sessionId) {
        errors.push(`routing source event ${eventId} must be a session_start event for its session`);
      }
    });
  }

  const callEvents = events.filter((event) => event.type === 'tool_call');
  const resultEvents = events.filter((event) => event.type === 'tool_result');
  if (new Set(telemetry.exposedTools).size !== telemetry.exposedTools.length) {
    errors.push('exposed tool names must be unique');
  }
  telemetry.tools.forEach((tool) => {
    const call = eventById.get(tool.callEventId);
    if (!call || call.type !== 'tool_call' || call.sessionId !== tool.sessionId ||
        call.callId !== tool.callId || call.toolName !== tool.name ||
        call.path !== tool.targetPath || call.timestamp !== tool.startedAt) {
      errors.push(`tool ${tool.callId} call record must bind to its raw tool_call event`);
    }
    if (!telemetry.exposedTools.includes(tool.name)) {
      errors.push(`tool ${tool.callId} must be present in exposedTools`);
    }
    if (tool.resultEventId === null) {
      if (tool.completedAt !== null || tool.success !== null) {
        errors.push(`tool ${tool.callId} without a result event must have null completion fields`);
      }
      requireUnavailable(tool.resultBytes, `tool ${tool.callId} resultBytes`, errors);
    } else {
      const result = eventById.get(tool.resultEventId);
      if (!result || result.type !== 'tool_result' || result.sessionId !== tool.sessionId ||
          result.callId !== tool.callId || result.toolName !== tool.name ||
          result.success !== tool.success || result.timestamp !== tool.completedAt) {
        errors.push(`tool ${tool.callId} result record must bind to its raw tool_result event`);
      } else {
        requireMetricValue(tool.resultBytes, result.resultBytes, `tool ${tool.callId} resultBytes`, errors);
        if (Date.parse(tool.completedAt) < Date.parse(tool.startedAt)) {
          errors.push(`tool ${tool.callId} completion must not precede its start`);
        }
      }
    }
  });
  const toolCallEventIds = telemetry.tools.map((tool) => tool.callEventId);
  const toolResultEventIds = telemetry.tools.map((tool) => tool.resultEventId).filter(Boolean);
  if (new Set(toolCallEventIds).size !== toolCallEventIds.length ||
      new Set(toolResultEventIds).size !== toolResultEventIds.length ||
      callEvents.some((event) => !toolCallEventIds.includes(event.eventId)) ||
      resultEvents.some((event) => !toolResultEventIds.includes(event.eventId))) {
    errors.push('every raw tool call/result event must bind one-to-one to a tool record');
  }
  requireMetricValue(telemetry.metrics.exposedToolCount, telemetry.exposedTools.length, 'exposedToolCount', errors);
  requireMetricValue(telemetry.metrics.toolCallCount, callEvents.length, 'toolCallCount', errors);
  requireMetricValue(telemetry.metrics.toolResultCount, resultEvents.length, 'toolResultCount', errors);

  const compactionEvents = events.filter((event) => event.type === 'compaction');
  telemetry.compaction.forEach((entry) => {
    const event = eventById.get(entry.sourceEventId);
    if (!event || event.type !== 'compaction' || event.sessionId !== entry.sessionId ||
        event.timestamp !== entry.timestamp) {
      errors.push(`compaction source event ${entry.sourceEventId} must bind to its raw event`);
    } else {
      requireMetricValue(entry.returnBytes, event.resultBytes, `compaction ${entry.sourceEventId} returnBytes`, errors);
    }
  });
  const compactionSourceIds = telemetry.compaction.map((entry) => entry.sourceEventId);
  if (new Set(compactionSourceIds).size !== compactionSourceIds.length ||
      compactionEvents.some((event) => !compactionSourceIds.includes(event.eventId))) {
    errors.push('every raw compaction event must bind one-to-one to a compaction record');
  }
  requireMetricValue(telemetry.metrics.compactionEventCount, compactionEvents.length, 'compactionEventCount', errors);
  requireMetricValue(
    telemetry.metrics.compactReturnBytes,
    compactionEvents.reduce((sum, event) => sum + event.resultBytes, 0),
    'compactReturnBytes',
    errors
  );

  for (const split of telemetry.models) {
    const usageEvents = events.filter((event) => event.type === 'usage' && event.sessionId === split.sessionId);
    if (usageEvents.length === 0) {
      errors.push(`${split.role} model split must have authenticated usage events`);
      continue;
    }
    for (const field of modelMetricFields) {
      const values = usageEvents.map((event) => event.usage[field]);
      if (values.some((value) => value === null)) {
        requireUnavailable(split[field], `${split.role}.${field}`, errors);
      } else {
        const expected = field === 'peakInputTokens'
          ? Math.max(...values)
          : values.reduce((sum, value) => sum + value, 0);
        requireMetricValue(split[field], expected, `${split.role}.${field}`, errors);
      }
    }
  }

  const parent = telemetry.models.find((model) => model.role === 'parent');
  const specialist = telemetry.models.find((model) => model.role === 'specialist');
  if (parent) {
    reconcileMetric(telemetry.metrics.parentNanoAiu, parent.nanoAiu, 'parentNanoAiu', errors);
    reconcileMetric(telemetry.metrics.parentCumulativeInputTokens, parent.inputTokens, 'parentCumulativeInputTokens', errors);
    reconcileMetric(telemetry.metrics.parentPeakInputTokens, parent.peakInputTokens, 'parentPeakInputTokens', errors);
    reconcileMetric(telemetry.metrics.parentOutputTokens, parent.outputTokens, 'parentOutputTokens', errors);
  }
  if (manifest.condition === 'control') {
    for (const name of ['specialistCumulativeInputTokens', 'specialistPeakInputTokens', 'specialistOutputTokens', 'specialistLatencyMs']) {
      requireUnavailable(
        telemetry.metrics[name],
        name,
        errors,
        'control_condition_no_specialist'
      );
    }
  } else {
    if (specialist) {
      reconcileMetric(telemetry.metrics.specialistCumulativeInputTokens, specialist.inputTokens, 'specialistCumulativeInputTokens', errors);
      reconcileMetric(telemetry.metrics.specialistPeakInputTokens, specialist.peakInputTokens, 'specialistPeakInputTokens', errors);
      reconcileMetric(telemetry.metrics.specialistOutputTokens, specialist.outputTokens, 'specialistOutputTokens', errors);
    } else {
      for (const name of ['specialistCumulativeInputTokens', 'specialistPeakInputTokens', 'specialistOutputTokens', 'specialistLatencyMs']) {
        requireUnavailable(telemetry.metrics[name], name, errors);
      }
    }
  }
  const expectedModelCount = manifest.condition === 'treatment' ? 2 : 1;
  const completeAiCredits = telemetry.models.length === expectedModelCount &&
    telemetry.models.every((model) => metricValue(model.aiCredits) !== null);
  if (completeAiCredits) {
    requireMetricValue(
      telemetry.metrics.totalSessionAiCredits,
      telemetry.models.reduce((sum, model) => sum + model.aiCredits.value, 0),
      'totalSessionAiCredits',
      errors
    );
  } else {
    requireUnavailable(telemetry.metrics.totalSessionAiCredits, 'totalSessionAiCredits', errors);
  }
  const completeNanoAiu = telemetry.models.length === expectedModelCount &&
    telemetry.models.every((model) => metricValue(model.nanoAiu) !== null);
  if (completeNanoAiu) {
    requireMetricValue(
      telemetry.metrics.totalSessionNanoAiu,
      telemetry.models.reduce((sum, model) => sum + model.nanoAiu.value, 0),
      'totalSessionNanoAiu',
      errors
    );
  } else {
    requireUnavailable(telemetry.metrics.totalSessionNanoAiu, 'totalSessionNanoAiu', errors);
  }

  const evidence = telemetry.routing.delegationEvidence;
  if (evidence.status === 'unavailable') {
    if (!manifest.exclusion.excluded || manifest.exclusion.reason !== 'telemetry_collection_failure') {
      errors.push(`unavailable ${manifest.condition} delegation evidence must be excluded as telemetry_collection_failure`);
    }
    if (events.some((event) => event.type === 'delegation_call' || event.type === 'delegation_result')) {
      errors.push(`unavailable ${manifest.condition} delegation evidence contradicts present raw delegation events`);
    }
  } else if (manifest.condition === 'treatment') {
      if ((evidence.callEventId === null) !== (evidence.requestedAt === null)) {
        errors.push('treatment delegation callEventId and requestedAt must be present or null together');
      }
      if ((evidence.resultEventId === null) !== (evidence.returnedAt === null)) {
        errors.push('treatment delegation resultEventId and returnedAt must be present or null together');
      }
      if (evidence.resultEventId !== null && evidence.callEventId === null) {
        errors.push('treatment delegation result evidence requires call evidence');
      }
      if (evidence.callEventId !== null) {
        const call = eventById.get(evidence.callEventId);
        if (!call || call.type !== 'delegation_call' || call.timestamp !== evidence.requestedAt) {
          errors.push('treatment delegation callEventId must bind to the raw delegation_call event');
        }
      }
      if (evidence.resultEventId !== null) {
        const result = eventById.get(evidence.resultEventId);
        if (!result || result.type !== 'delegation_result' || result.timestamp !== evidence.returnedAt) {
          errors.push('treatment delegation resultEventId must bind to the raw delegation_result event');
        }
      }
      if (evidence.requestedAt !== null && evidence.returnedAt !== null) {
        const latency = Date.parse(evidence.returnedAt) - Date.parse(evidence.requestedAt);
        if (latency < 0) {
          errors.push('treatment delegation return must not precede its request');
        } else {
          requireMetricValue(telemetry.metrics.specialistLatencyMs, latency, 'specialistLatencyMs', errors);
        }
      } else {
        requireUnavailable(telemetry.metrics.specialistLatencyMs, 'specialistLatencyMs', errors);
      }
  }

  const manifestEvidence = manifest.conditionEvidence;
  const expectedEvidence = derivedConditionEvidence(manifest, telemetry);
  if (!manifestEvidence || typeof manifestEvidence.status !== 'string') {
    errors.push('manifest condition evidence is required');
  } else if (manifestEvidence.status === 'unavailable') {
    if (evidence.status !== 'unavailable' ||
        !manifest.exclusion.excluded || manifest.exclusion.reason !== 'telemetry_collection_failure') {
      errors.push('unavailable manifest condition evidence must match excluded unavailable condition telemetry');
    }
  } else {
    for (const [name, expectedIds] of Object.entries(expectedEvidence)) {
      if (!sameUniqueIds(manifestEvidence[name], expectedIds)) {
        errors.push(`manifest condition evidence ${name} must bind exactly to authenticated telemetry events`);
      }
    }
    if (manifest.condition === 'treatment' && evidence.status !== 'available') {
      errors.push('available treatment manifest condition evidence requires available telemetry evidence');
    }
  }

  const wallLatency = Date.parse(manifest.timestamps.completedAt) - Date.parse(manifest.timestamps.promptSentAt);
  if (Date.parse(manifest.timestamps.promptSentAt) < Date.parse(manifest.timestamps.createdAt) ||
      wallLatency < 0) {
    errors.push('manifest timestamps must be chronologically nondecreasing');
  } else {
    requireMetricValue(telemetry.metrics.wallLatencyMs, wallLatency, 'wallLatencyMs', errors);
  }

  return {
    errors,
    compliance: evaluateConditionCompliance(manifest, telemetry, prompt)
  };
}

module.exports = {
  derivedConditionEvidence,
  evaluateConditionCompliance,
  metricValue,
  validateTelemetryConsistency
};
