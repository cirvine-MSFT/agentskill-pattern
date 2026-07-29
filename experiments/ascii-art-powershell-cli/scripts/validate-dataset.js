#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  conditionInstructions,
  parentModel,
  parseArguments,
  readJson,
  resolveContainedPath,
  root,
  sha256,
  sha256File,
  sha256RawFile,
  specialistModel,
  walkFiles
} = require('./lib');
const { authenticateArtifactBundle, validateBlindContent } = require('./artifact-bundles');
const { validateTelemetryConsistency } = require('./telemetry-integrity');
const { validateSchema } = require('./validate-schema');

const args = parseArguments(process.argv.slice(2));
const dataRoot = args['data-root'] ? path.resolve(args['data-root']) : root;
const errors = [];
const prompts = readJson(path.join(root, 'prompts.json'));
const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const protocol = fs.readFileSync(path.join(root, 'protocol.md'), 'utf8');
const rawRoot = path.join(dataRoot, 'raw');
const artifactRoot = path.join(dataRoot, 'artifacts');
const provenanceIndexPath = path.join(rawRoot, 'provenance-index.json');
const provenanceIndex = fs.existsSync(provenanceIndexPath)
  ? readJson(provenanceIndexPath)
  : null;
const provenanceById = new Map((provenanceIndex?.sources || []).map((source) => [
  source.sourceId,
  source
]));
const infrastructureReasons = new Set([
  'session_creation_failure',
  'hash_mismatch',
  'wrong_model',
  'non_fresh_session',
  'telemetry_collection_failure',
  'external_interruption',
  'required_tool_unavailable'
]);
const preExecutionReasons = new Set([
  'session_creation_failure',
  'hash_mismatch',
  'external_interruption',
  'required_tool_unavailable'
]);

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

check(prompts.length === 10, `prompts.json must contain exactly 10 prompts, found ${prompts.length}`);
check(new Set(prompts.map((prompt) => prompt.id)).size === 10, 'prompt IDs must be unique');
check(prompts.every((prompt, index) => prompt.id === `P${String(index + 1).padStart(2, '0')}`), 'prompt IDs must be P01-P10 in order');
check(prompts.every((prompt) => !/\b(agent|skill)\b/i.test(prompt.prompt)), 'prompt text must not explicitly mention an agent or skill');
check(new Set(prompts.map((prompt) => prompt.banner.path)).size === 10, 'banner paths must be unique');
check(prompts.every((prompt) => prompt.prompt.includes(prompt.banner.path)), 'each prompt must name its banner path');
check(prompts.every((prompt) => prompt.prompt.includes(prompt.banner.requiredToken)), 'each prompt must state its required token');
for (const fixedFile of [
  'prompts.json',
  'fixture/fixture-lock.json',
  'acceptance/acceptance-lock.json',
  'design/randomization.json',
  'design/judge-assignments.json'
]) {
  check(protocol.includes(sha256File(path.join(root, ...fixedFile.split('/')))), `protocol.md must pin the current SHA-256 for ${fixedFile}`);
}

const observations = schedule.blocks.flatMap((block) => block.observations.map((item) => ({ ...item, block: block.block })));
check(schedule.blocks.length === 6, 'randomization must contain six blocks');
check(observations.length === 60, `randomization must contain 60 observations, found ${observations.length}`);
check(new Set(observations.map((item) => item.scheduleId)).size === 60, 'schedule IDs must be unique');
schedule.blocks.forEach((block) => {
  check(block.observations.length === 10, `block ${block.block} must contain 10 observations`);
  check(new Set(block.observations.map((item) => item.promptId)).size === 10, `block ${block.block} must contain every prompt once`);
  check(block.observations.filter((item) => item.condition === 'control').length === 5, `block ${block.block} must contain five controls`);
  check(block.observations.filter((item) => item.condition === 'treatment').length === 5, `block ${block.block} must contain five treatments`);
});
prompts.forEach((prompt) => {
  const rows = observations.filter((item) => item.promptId === prompt.id);
  check(rows.length === 6, `${prompt.id} must have six observations`);
  [1, 2, 3].forEach((repetition) => {
    const pair = rows.filter((item) => item.repetition === repetition);
    check(pair.length === 2 && new Set(pair.map((item) => item.condition)).size === 2, `${prompt.id} repetition ${repetition} must be paired`);
  });
});

const judged = assignments.blocks.flatMap((block) => block.artifacts.map((item) => ({ ...item, block: block.block })));
const primaryJudged = judged.filter((item) => !item.duplicateOfBlindId);
const duplicateJudged = judged.filter((item) => item.duplicateOfBlindId);
check(assignments.blocks.length === 6, 'judge design must contain six blocks');
check(judged.length === 66, 'judge design must assign 60 primary artifacts and six reliability duplicates');
check(primaryJudged.length === 60, 'judge design must assign 60 primary artifacts');
check(duplicateJudged.length === 6, 'judge design must assign six reliability duplicates');
check(new Set(judged.map((item) => item.blindId)).size === 66, 'blind IDs must be unique');
check(new Set(primaryJudged.map((item) => item.scheduleId)).size === 60, 'every observation must be judged once as a primary artifact');
check(duplicateJudged.every((item) => primaryJudged.some((primary) => primary.blindId === item.duplicateOfBlindId && primary.scheduleId === item.scheduleId)), 'each reliability duplicate must reference its primary blind ID');
assignments.blocks.forEach((block) => {
  const primary = block.artifacts.filter((item) => !item.duplicateOfBlindId);
  const duplicates = block.artifacts.filter((item) => item.duplicateOfBlindId);
  const source = primary.map((artifact) => observations.find((item) => item.scheduleId === artifact.scheduleId));
  const duplicateSource = duplicates.map((artifact) => observations.find((item) => item.scheduleId === artifact.scheduleId));
  check(block.artifacts.length === 11, `judge block ${block.block} must contain 10 primary artifacts and one duplicate`);
  check(primary.length === 10 && duplicates.length === 1, `judge block ${block.block} must have the required primary/duplicate split`);
  check(new Set(primary.map((item) => item.promptId)).size === 10, `judge block ${block.block} must contain every prompt once in its primary set`);
  check(source.filter((item) => item && item.condition === 'control').length === 5, `judge block ${block.block} must contain five hidden controls`);
  check(source.filter((item) => item && item.condition === 'treatment').length === 5, `judge block ${block.block} must contain five hidden treatments`);
  check(duplicateSource.every((duplicate) => !source.some((primaryItem) => primaryItem.promptId === duplicate.promptId && primaryItem.repetition === duplicate.repetition)), `judge block ${block.block} must not expose a duplicate beside its paired primary`);
});

const schemas = {};
for (const schemaName of ['run-manifest', 'pre-execution-failure', 'raw-telemetry', 'artifacts', 'artifact-bundle', 'blind-bundle', 'blind-content', 'deterministic-results', 'judgment']) {
  const schema = readJson(path.join(root, 'schemas', `${schemaName}.schema.json`));
  schemas[schemaName] = schema;
  check(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `${schemaName} must use JSON Schema 2020-12`);
}

for (const [directoryName, lockName] of [['fixture', 'fixture-lock.json'], ['acceptance', 'acceptance-lock.json']]) {
  const directory = path.join(root, directoryName);
  const lockPath = path.join(directory, lockName);
  check(fs.existsSync(lockPath), `${lockName} is missing`);
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const actual = walkFiles(directory)
      .filter((file) => file !== lockPath)
      .map((file) => ({
        path: path.relative(directory, file).split(path.sep).join('/'),
        sha256: sha256File(file)
      }));
    check(JSON.stringify(lock.files) === JSON.stringify(actual), `${lockName} is stale`);
  }
}

if (provenanceIndex) {
  for (const source of provenanceIndex.sources) {
    if (source.kind === 'events_jsonl_slice') {
      check(/^[a-f0-9]{64}$/.test(source.originalEventsSha256 || ''), `${source.sourceId} must bind the original events.jsonl hash`);
      check(Number.isInteger(source.originalEventsBytes) && source.originalEventsBytes > 0, `${source.sourceId} must bind the original events.jsonl byte length`);
    }
    if (['local-usage-export', 'local-file-change-export'].includes(source.kind)) {
      check(source.query?.dialect === 'sqlite' && typeof source.query?.sql === 'string', `${source.sourceId} must retain exact SQLite query text`);
      check(source.query?.exportSha256 === source.sha256, `${source.sourceId} SQLite export hash mismatch`);
      check(/^[a-f0-9]{64}$/.test(source.query?.sourceDatabaseSnapshot?.snapshotSha256 || ''), `${source.sourceId} source database snapshot hash is missing`);
      check(source.query?.sourceDatabaseSnapshot?.queryTimeSnapshotStatus === 'unavailable', `${source.sourceId} post-query snapshot must not be represented as query-time evidence`);
    }
  }
}

function validateRecords(records, schemaName) {
  records.forEach((record) => {
    const schemaErrors = validateSchema(record, schemas[schemaName]);
    schemaErrors.forEach((error) => errors.push(`${schemaName} ${record.runId || record.blindId || '<unknown>'}: ${error}`));
  });
}

function exactLines(file) {
  const bytes = fs.readFileSync(file);
  const lines = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end += 1;
    if (end < bytes.length && bytes[end] === 0x0d && bytes[end + 1] === 0x0a) end += 2;
    else if (end < bytes.length) end += 1;
    lines.push({ offset, raw: bytes.subarray(offset, end) });
    offset = end;
  }
  return lines;
}

function authenticateRawEvents(telemetryRecord) {
  const sources = new Map();
  for (const source of telemetryRecord.rawSources) {
    try {
      const sourcePath = resolveContainedPath(rawRoot, source.path, `${telemetryRecord.runId} raw source path`);
      check(fs.existsSync(sourcePath), `${telemetryRecord.runId} raw source bytes must exist`);
      if (!fs.existsSync(sourcePath)) continue;
      check(sha256RawFile(sourcePath) === source.sha256, `${telemetryRecord.runId} raw source hash must authenticate exact bytes`);
      const descriptor = provenanceById.get(source.sourceId);
      if (descriptor) {
        check(descriptor.path === source.path && descriptor.sha256 === source.sha256, `${telemetryRecord.runId} provenance index source mismatch`);
        sources.set(source.sourceId, { descriptor, lines: exactLines(sourcePath) });
      } else {
        const payload = readJson(sourcePath);
        check(
          payload && payload.sourceId === source.sourceId && Array.isArray(payload.events) &&
          Object.keys(payload).sort().join(',') === 'events,sourceId',
          `${telemetryRecord.runId} raw source must contain only its sourceId and events`
        );
        sources.set(source.sourceId, payload.events || []);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  check(sources.size === telemetryRecord.rawSources.length, `${telemetryRecord.runId} raw source IDs must be unique`);
  for (const [sourceId, sourceEvents] of sources) {
    if (!Array.isArray(sourceEvents)) continue;
    const normalizedEvents = telemetryRecord.events.filter((event) => event.rawSourceId === sourceId);
    check(
      canonicalJson(normalizedEvents) === canonicalJson(sourceEvents),
      `${telemetryRecord.runId} normalized events must include every authenticated raw-source event exactly once`
    );
  }
  telemetryRecord.events.forEach((event) => {
    const sourceEvents = sources.get(event.rawSourceId);
    if (sourceEvents && !Array.isArray(sourceEvents)) {
      const reference = event.eventId.match(
        /^([^:]+):line:(\d+)(?::origin:(\d+))?:offset:(\d+):sha:([a-f0-9]{20}):id:([^:]+):/
      );
      check(Boolean(reference), `${telemetryRecord.runId} raw event ${event.eventId} must contain immutable line provenance`);
      if (!reference) return;
      const line = sourceEvents.lines[Number(reference[2]) - 1];
      check(Boolean(line), `${telemetryRecord.runId} raw event ${event.eventId} source line is missing`);
      if (line) {
        check(sha256(line.raw).startsWith(reference[5]), `${telemetryRecord.runId} raw event ${event.eventId} source line hash mismatch`);
        if (sourceEvents.descriptor.kind !== 'events_jsonl_slice') {
          check(line.offset === Number(reference[4]), `${telemetryRecord.runId} raw event ${event.eventId} source offset mismatch`);
        }
      }
      return;
    }
    const authenticated = sourceEvents && sourceEvents.find((candidate) => candidate.eventId === event.eventId);
    check(Boolean(authenticated), `${telemetryRecord.runId} raw event ${event.eventId} must exist in its authenticated raw source`);
    if (authenticated) {
      check(
        canonicalJson(authenticated) === canonicalJson(event),
        `${telemetryRecord.runId} raw event ${event.eventId} must exactly match authenticated source bytes`
      );
    }
  });
}

const rawJson = walkFiles(path.join(dataRoot, 'raw')).filter((file) => file.endsWith('.json'));
const rawRecords = rawJson.map((file) => ({ file, value: readJson(file) }));
const rawObjects = rawRecords.map((record) => record.value);
const initialWorkspaceRecords = rawObjects.filter((item) => (
  item?.recordType === 'initial_workspace_provenance'
));
const preExecutionRecords = rawRecords.filter((record) => (
  record.value.protocolId && record.value.recordType === 'pre_execution_failure'
));
const preExecutionManifests = preExecutionRecords.map((record) => record.value);
const manifestCandidates = rawObjects.filter((item) => (
  item.protocolId && item.condition && item.exclusion && item.execution &&
  !item.metrics && !item.functional
));
const startedManifests = manifestCandidates.filter((item) => (
  item.recordType !== 'pre_execution_failure' && item.sessions && item.refs
));
const manifests = [...startedManifests, ...preExecutionManifests];
const telemetry = rawObjects.filter((item) => item.protocolId && item.metrics && item.routing);
const deterministic = rawObjects.filter((item) => item.protocolId && item.functional && item.art && item.tamperCheck);
if (rawJson.length > 0) {
  validateRecords(startedManifests, 'run-manifest');
  validateRecords(preExecutionManifests, 'pre-execution-failure');
  validateRecords(telemetry, 'raw-telemetry');
  validateRecords(deterministic, 'deterministic-results');
  check(manifests.length >= 60 && manifests.length <= 120, `complete raw dataset must contain 60-120 run attempts, found ${manifests.length}`);
  check(
    manifestCandidates.length === manifests.length,
    'every run attempt record must be either a session-started manifest or an explicit pre-execution failure'
  );
  check(telemetry.length === startedManifests.length, `raw dataset must contain one telemetry record per session-started attempt, found ${telemetry.length} for ${startedManifests.length} started attempts`);
  check(deterministic.length === startedManifests.length, `raw dataset must contain one deterministic result per session-started attempt, found ${deterministic.length} for ${startedManifests.length} started attempts`);
  check(new Set(manifests.map((item) => item.runId)).size === manifests.length, 'run manifest run IDs must be unique');
  check(new Set(telemetry.map((item) => item.runId)).size === telemetry.length, 'telemetry run IDs must be unique');
  check(new Set(deterministic.map((item) => item.runId)).size === deterministic.length, 'deterministic result run IDs must be unique');
  check(manifests.every((item) => item.runId === `${item.scheduleId}-A${item.execution.attempt}`), 'run IDs must encode schedule ID and attempt');
  check(startedManifests.every((item) => telemetry.some((record) => record.runId === item.runId) && deterministic.some((record) => record.runId === item.runId)), 'every session-started attempt must have matching telemetry and deterministic records');
  check(preExecutionManifests.every((item) => !telemetry.some((record) => record.runId === item.runId) && !deterministic.some((record) => record.runId === item.runId)), 'pre-execution attempts must not have telemetry or deterministic outcome records');
  const parentIds = startedManifests.map((item) => item.sessions.parent.sessionId);
  check(new Set(parentIds).size === startedManifests.length, 'parent session IDs must be unique across attempts');
  const specialistIds = startedManifests.filter((item) => (
    item.condition === 'treatment' && item.sessions.specialist.sessionId
  )).map((item) => item.sessions.specialist.sessionId);
  check(new Set(specialistIds).size === specialistIds.length, 'specialist session IDs must be unique across treatment attempts');
  const coordinatorIds = startedManifests.map((item) => item.execution.coordinatorSessionId);
  const rootIds = startedManifests.map((item) => item.execution.rootSessionId);
  check(startedManifests.length === 0 || new Set(rootIds).size === 1, 'all session-started attempts must record exactly one root experiment session ID');
  const promptsWithStartedAttempts = new Set(startedManifests.map((item) => item.promptId));
  check(
    new Set(coordinatorIds).size === promptsWithStartedAttempts.size,
    'session-started attempts must use exactly one case coordinator session ID per represented prompt'
  );
  prompts.forEach((prompt) => {
    check(
      new Set(startedManifests
        .filter((manifest) => manifest.promptId === prompt.id)
        .map((manifest) => manifest.execution.coordinatorSessionId)).size ===
          (promptsWithStartedAttempts.has(prompt.id) ? 1 : 0),
      `${prompt.id} attempts must use one case coordinator session ID`
    );
  });
  check(rootIds.every((id) => !coordinatorIds.includes(id)), 'root and case coordinator session ID sets must be disjoint');
  check(rootIds.every((id) => !parentIds.includes(id)), 'root and parent session ID sets must be disjoint');
  check(rootIds.every((id) => !specialistIds.includes(id)), 'root and specialist session ID sets must be disjoint');
  check(parentIds.every((id) => !specialistIds.includes(id)), 'parent and specialist session ID sets must be mutually disjoint');
  check(parentIds.every((id) => !coordinatorIds.includes(id)), 'parent and coordinator session ID sets must be disjoint');
  check(specialistIds.every((id) => !coordinatorIds.includes(id)), 'specialist and coordinator session ID sets must be disjoint');
  const allEventIds = telemetry.flatMap((record) => record.events.map((event) => event.eventId));
  check(new Set(allEventIds).size === allEventIds.length, 'raw event IDs must be globally unique across attempts');
  check(
    startedManifests.length === 0 ||
      new Set(startedManifests.map((item) => item.refs.benchmarkCommitSha)).size === 1,
    'all session-started attempts must use one benchmark commit SHA'
  );
  check(startedManifests.every((item) => item.refs.promptsSha256 === sha256File(path.join(root, 'prompts.json'))), 'all session-started attempts must use the registered prompt hash');
  check(startedManifests.every((item) => item.refs.fixtureLockSha256 === sha256File(path.join(root, 'fixture', 'fixture-lock.json'))), 'all session-started attempts must use the registered fixture lock hash');
  if (initialWorkspaceRecords.length > 0) {
    check(initialWorkspaceRecords.length === startedManifests.length, 'every session-started attempt must have initial workspace provenance');
    for (const initial of initialWorkspaceRecords) {
      const manifest = startedManifests.find((item) => item.runId === initial.runId);
      check(Boolean(manifest), `${initial.runId} initial workspace provenance must have a manifest`);
      if (!manifest) continue;
      check(manifest.refs.initialTreeSha === initial.initialTreeSha, `${initial.runId} manifest must record the actual initial Git tree SHA`);
      check(initial.fixture.files.length === 4, `${initial.runId} must validate every fixture-lock file`);
      check(initial.fixture.files.every((file) => file.status === 'pass'), `${initial.runId} fixture file hash mismatch must be rejected`);
      if (initial.status === 'fail') {
        check(manifest.exclusion.excluded && manifest.exclusion.reason === 'hash_mismatch', `${initial.runId} initial provenance mismatch must be excluded hash_mismatch`);
      }
    }
  }
  manifests.forEach((manifest) => {
    const scheduledItem = observations.find((item) => item.scheduleId === manifest.scheduleId);
    const telemetryRecord = telemetry.find((item) => item.runId === manifest.runId);
    const deterministicRecord = deterministic.find((item) => item.runId === manifest.runId);
    check(
      manifest.exclusion.excluded === (manifest.exclusion.reason !== null),
      `${manifest.runId} exclusion flag must be true iff an allowed non-null reason is recorded`
    );
    check(Boolean(scheduledItem), `${manifest.runId} must reference a scheduled observation`);
    if (scheduledItem) {
      check(manifest.promptId === scheduledItem.promptId && manifest.repetition === scheduledItem.repetition && manifest.condition === scheduledItem.condition, `${manifest.runId} must match its scheduled prompt, repetition, and condition`);
      check(manifest.execution.block === scheduledItem.block && manifest.execution.position === scheduledItem.position, `${manifest.runId} must match its scheduled block and position`);
      check(manifest.conditionInstruction === conditionInstructions[scheduledItem.condition], `${manifest.runId} must use the exact preregistered ${scheduledItem.condition} instruction`);
    }
    if (manifest.recordType === 'pre_execution_failure') {
      check(
        manifest.attempt?.phase === 'pre_execution' &&
        manifest.attempt?.status === 'excluded' &&
        manifest.attempt?.availability === 'not_created',
        `${manifest.runId} pre-execution attempt must explicitly declare excluded/not-created availability`
      );
      check(
        manifest.exclusion.excluded && preExecutionReasons.has(manifest.exclusion.reason),
        `${manifest.runId} pre-execution attempt must use an allowed pre-execution infrastructure reason`
      );
      check(!telemetryRecord && !deterministicRecord, `${manifest.runId} pre-execution attempt must not have telemetry or deterministic outcome evidence`);
      return;
    }
    check(
      manifest.attempt?.phase === 'session_started' &&
      manifest.attempt?.availability === 'evidence_required' &&
      manifest.attempt?.status === (manifest.exclusion.excluded ? 'excluded' : 'included'),
      `${manifest.runId} session-started attempt status and evidence availability must match exclusion state`
    );
    const parentModelMismatch = manifest.sessions.parent.requestedModel !== parentModel ||
      manifest.sessions.parent.observedModel !== parentModel;
    const specialistModelMismatch = manifest.condition === 'treatment' &&
      Boolean(manifest.sessions.specialist.sessionId) && (
      manifest.sessions.specialist.requestedModel !== specialistModel ||
      manifest.sessions.specialist.observedModel !== specialistModel
    );
    const modelMismatch = parentModelMismatch || specialistModelMismatch;
    const modelTelemetryUnavailable = manifest.exclusion.reason === 'telemetry_collection_failure' &&
      manifest.sessions.parent.observedModel.startsWith('unavailable:');
    check(
      !modelMismatch || modelTelemetryUnavailable ||
        (manifest.exclusion.excluded && manifest.exclusion.reason === 'wrong_model'),
      `${manifest.runId} wrong requested/observed model must be explicitly excluded with reason wrong_model`
    );
    check(
      modelMismatch || manifest.exclusion.reason !== 'wrong_model',
      `${manifest.runId} must not claim wrong_model exclusion when all requested/observed models are preregistered`
    );
    if (telemetryRecord) {
      authenticateRawEvents(telemetryRecord);
      check(telemetryRecord.scheduleId === manifest.scheduleId, `${manifest.runId} telemetry schedule ID must match`);
      check(telemetryRecord.routing.parent.sessionId === manifest.sessions.parent.sessionId, `${manifest.runId} parent routing session must match manifest`);
      check(telemetryRecord.routing.parent.requestedModel === manifest.sessions.parent.requestedModel, `${manifest.runId} parent routing requested model must match manifest`);
      check(telemetryRecord.routing.parent.observedModel === manifest.sessions.parent.observedModel, `${manifest.runId} parent routing model must match manifest`);
      const parentSplits = telemetryRecord.models.filter((model) => model.role === 'parent');
      const specialistSplits = telemetryRecord.models.filter((model) => model.role === 'specialist');
      const allowedTelemetrySessionIds = new Set([manifest.sessions.parent.sessionId]);
      if (manifest.condition === 'treatment' && manifest.sessions.specialist.sessionId) {
        allowedTelemetrySessionIds.add(manifest.sessions.specialist.sessionId);
      }
      check(parentSplits.length === 1, `${manifest.runId} telemetry must contain exactly one parent model split`);
      if (parentSplits.length === 1) {
        const parentSplit = parentSplits[0];
        check(
          parentSplit.sessionId === manifest.sessions.parent.sessionId &&
          parentSplit.requestedModel === manifest.sessions.parent.requestedModel &&
          parentSplit.observedModel === manifest.sessions.parent.observedModel,
          `${manifest.runId} parent model split must match manifest provenance`
        );
      }
      if (manifest.condition === 'treatment') {
        if (manifest.sessions.specialist.sessionId) {
          check(telemetryRecord.routing.specialist.sessionId === manifest.sessions.specialist.sessionId, `${manifest.runId} specialist routing session must match manifest`);
          check(telemetryRecord.routing.specialist.requestedModel === manifest.sessions.specialist.requestedModel && telemetryRecord.routing.specialist.observedModel === manifest.sessions.specialist.observedModel, `${manifest.runId} specialist routing model must match manifest`);
          check(specialistSplits.length === 1, `${manifest.runId} treatment telemetry must contain exactly one specialist model split when a specialist session exists`);
          if (specialistSplits.length === 1) {
            const specialistSplit = specialistSplits[0];
            check(
              specialistSplit.sessionId === manifest.sessions.specialist.sessionId &&
              specialistSplit.requestedModel === manifest.sessions.specialist.requestedModel &&
              specialistSplit.observedModel === manifest.sessions.specialist.observedModel,
              `${manifest.runId} specialist model split must match manifest provenance`
            );
          }
        } else {
          check(manifest.sessions.specialist.status === 'unavailable', `${manifest.runId} treatment without a specialist session must mark it unavailable`);
          check(telemetryRecord.routing.specialist.status === 'unavailable', `${manifest.runId} treatment routing without a specialist session must be unavailable`);
          check(specialistSplits.length === 0, `${manifest.runId} treatment without a specialist session must not contain a specialist model split`);
        }
      } else {
        check(manifest.sessions.specialist.status === 'not_applicable', `${manifest.runId} control manifest specialist must be not_applicable`);
        check(telemetryRecord.routing.specialist.status === 'not_applicable', `${manifest.runId} control routing specialist must be not_applicable`);
        check(specialistSplits.length === 0, `${manifest.runId} control telemetry must not contain a specialist model split`);
        check(
          ['not_applicable', 'unavailable'].includes(telemetryRecord.routing.delegationEvidence.status),
          `${manifest.runId} control delegation evidence must be not_applicable or excluded-unavailable`
        );
      }
      telemetryRecord.tools.forEach((tool) => {
        check(allowedTelemetrySessionIds.has(tool.sessionId), `${manifest.runId} tool event session must belong to the manifest parent or treatment specialist`);
      });
      telemetryRecord.compaction.forEach((event) => {
        check(allowedTelemetrySessionIds.has(event.sessionId), `${manifest.runId} compaction event session must belong to the manifest parent or treatment specialist`);
      });
      const compactionEventCount = telemetryRecord.metrics.compactionEventCount;
      if (compactionEventCount.status === 'available') {
        check(
          Number.isInteger(compactionEventCount.value) &&
          compactionEventCount.value >= 0 &&
          compactionEventCount.value === telemetryRecord.compaction.length,
          `${manifest.runId} available compaction event count must exactly match source event records`
        );
      }
      const prompt = prompts.find((item) => item.id === manifest.promptId);
      const noExecutionTelemetry = manifest.exclusion.reason === 'telemetry_collection_failure' &&
        telemetryRecord.events.every((event) => event.type === 'session_start') &&
        telemetryRecord.models.every((model) => (
          ['aiCredits', 'nanoAiu', 'inputTokens', 'peakInputTokens', 'outputTokens', 'cachedTokens']
            .every((field) => model[field].status === 'unavailable')
        ));
      if (!noExecutionTelemetry) {
        const integrity = validateTelemetryConsistency(manifest, telemetryRecord, prompt);
        integrity.errors.forEach((error) => errors.push(`${manifest.runId} ${error}`));
      } else {
        check(
          deterministicRecord?.status === 'unavailable',
          `${manifest.runId} telemetry collection failure requires unavailable deterministic evidence`
        );
      }
    }
    if (deterministicRecord) {
      check(deterministicRecord.scheduleId === manifest.scheduleId && deterministicRecord.promptId === manifest.promptId, `${manifest.runId} deterministic provenance must match manifest`);
      const groups = [deterministicRecord.functional, deterministicRecord.art, deterministicRecord.tamperCheck];
      groups.forEach((group, groupIndex) => {
        const assertionStatuses = group.assertions.map((assertion) => assertion.status);
        const expectedGroupStatus = assertionStatuses.includes('fail')
          ? 'fail'
          : (assertionStatuses.includes('unavailable') ? 'unavailable' : 'pass');
        check(group.status === expectedGroupStatus, `${manifest.runId} deterministic child group ${groupIndex + 1} status must reflect all assertion statuses`);
        check(
          group.status === 'unavailable'
            ? typeof group.unavailableReason === 'string' && group.unavailableReason.length > 0
            : group.unavailableReason === null,
          `${manifest.runId} deterministic child group ${groupIndex + 1} must record a reason only when unavailable`
        );
      });
      const groupStatuses = groups.map((group) => group.status);
      const expectedStatus = groupStatuses.includes('fail')
        ? 'fail'
        : (groupStatuses.includes('unavailable') ? 'unavailable' : 'pass');
      check(deterministicRecord.status === expectedStatus, `${manifest.runId} deterministic top-level status must reflect every child check`);
      check(
        deterministicRecord.status === 'unavailable'
          ? typeof deterministicRecord.unavailableReason === 'string' && deterministicRecord.unavailableReason.length > 0
          : deterministicRecord.unavailableReason === null,
        `${manifest.runId} deterministic result must record a reason only when unavailable`
      );
    }
  });
  observations.forEach((scheduledItem) => {
    const attempts = manifests
      .filter((item) => item.scheduleId === scheduledItem.scheduleId)
      .sort((left, right) => left.execution.attempt - right.execution.attempt);
    const included = attempts.filter((item) => !item.exclusion.excluded);
    check(attempts.length >= 1 && attempts.length <= 2, `${scheduledItem.scheduleId} must have one or two attempts`);
    if (attempts.length === 1) {
      const first = attempts[0];
      check(
        first.execution.attempt === 1 &&
        !first.exclusion.excluded &&
        first.exclusion.retryOf === null &&
        first.exclusion.retryId === null,
        `${scheduledItem.scheduleId} single-attempt schedule must contain one included initial attempt without retry linkage`
      );
    } else if (attempts.length === 2) {
      const [first, retry] = attempts;
      check(
        first.execution.attempt === 1 && retry.execution.attempt === 2,
        `${scheduledItem.scheduleId} retry schedule must contain attempts 1 and 2 exactly once`
      );
      check(first.exclusion.excluded, `${scheduledItem.scheduleId} retry requires an excluded first attempt`);
      if (first && retry) {
        check(
          first.exclusion.retryOf === null &&
          first.exclusion.retryId === retry.runId &&
          retry.exclusion.retryOf === first.runId &&
          retry.exclusion.retryId === null,
          `${scheduledItem.scheduleId} retry attempts must have reciprocal retryId/retryOf linkage`
        );
      }
      check(
        included.length === 1
          ? !retry.exclusion.excluded
          : (included.length === 0 && retry.exclusion.excluded),
        `${scheduledItem.scheduleId} retry schedule must have one included retry or two excluded infrastructure attempts`
      );
      if (included.length === 0) {
        check(
          attempts.every((attempt) => infrastructureReasons.has(attempt.exclusion.reason)),
          `${scheduledItem.scheduleId} twice-excluded schedule must use allowed infrastructure reasons`
        );
      }
    }
  });
}

const selectedBySchedule = new Map(observations.map((scheduledItem) => [
  scheduledItem.scheduleId,
  manifests.find((manifest) => manifest.scheduleId === scheduledItem.scheduleId && !manifest.exclusion.excluded)
]));
const selectedManifests = [...selectedBySchedule.values()].filter(Boolean);
if (args['require-complete']) {
  observations.forEach((scheduledItem) => {
    check(
      Boolean(selectedBySchedule.get(scheduledItem.scheduleId)),
      `${scheduledItem.scheduleId} completeness gate requires one selected included run`
    );
  });
}
const expectedJudged = judged.filter((assignment) => selectedBySchedule.has(assignment.scheduleId) &&
  selectedBySchedule.get(assignment.scheduleId));

const artifactJson = walkFiles(path.join(dataRoot, 'artifacts')).filter((file) => file.endsWith('.json'));
const artifactObjects = artifactJson.map(readJson);
const artifactManifests = artifactObjects.filter((item) => item.protocolId && item.bundleSha256 && item.files);
const blindBundles = artifactObjects.filter((item) => item.protocolId && item.blindId && item.blindBundleSha256);
preExecutionRecords.forEach(({ file, value: manifest }) => {
  const runIdPrefix = `${manifest.runId}.`;
  check(
    path.basename(file).startsWith(runIdPrefix) &&
    path.basename(file).endsWith('.pre-execution.json'),
    `${manifest.runId} pre-execution record filename must end with .pre-execution.json`
  );
  check(
    !rawRecords.some((record) => (
      record.file !== file && path.basename(record.file).startsWith(runIdPrefix)
    )),
    `${manifest.runId} pre-execution attempt must not have additional run-associated raw records`
  );
});
preExecutionManifests.forEach((manifest) => {
  check(
    !artifactObjects.some((item) => item && item.runId === manifest.runId),
    `${manifest.runId} pre-execution attempt must not have artifact or blind-binding records`
  );
});
const authenticatedArtifacts = new Map();
if (artifactJson.length > 0) {
  validateRecords(artifactManifests, 'artifacts');
  check(
    artifactManifests.length >= selectedManifests.length && artifactManifests.length <= startedManifests.length,
    `artifact dataset must contain every selected included schedule and may retain excluded-attempt artifacts, found ${artifactManifests.length} for ${selectedManifests.length} selected schedules`
  );
  check(new Set(artifactManifests.map((item) => item.runId)).size === artifactManifests.length, 'artifact run IDs must be unique');
  selectedManifests.forEach((manifest) => {
    check(
      artifactManifests.some((artifact) => artifact.runId === manifest.runId),
      `${manifest.runId} selected included attempt must have an artifact manifest`
    );
  });
  artifactManifests.forEach((artifact) => {
    const manifest = startedManifests.find((item) => item.runId === artifact.runId);
    check(Boolean(manifest), `${artifact.runId} artifact must have a matching session-started run manifest`);
    if (manifest) {
      check(artifact.scheduleId === manifest.scheduleId, `${artifact.runId} artifact schedule ID must match manifest`);
      check(artifact.sessionId === manifest.sessions.parent.sessionId, `${artifact.runId} artifact parent session must match manifest`);
      check(artifact.terminalCommitSha === manifest.refs.terminalCommitSha, `${artifact.runId} artifact commit must match manifest`);
      check(artifact.bundleSha256 === manifest.refs.artifactBundleSha256, `${artifact.runId} artifact bundle hash must match manifest`);
      const deterministicRecord = deterministic.find((item) => item.runId === artifact.runId);
      const prompt = prompts.find((item) => item.id === manifest.promptId);
      if (deterministicRecord && prompt) {
        try {
          authenticatedArtifacts.set(
            artifact.runId,
            authenticateArtifactBundle(artifactRoot, artifact, manifest, prompt, deterministicRecord)
          );
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
  });
}

if (blindBundles.length > 0) {
  validateRecords(blindBundles, 'blind-bundle');
  check(
    blindBundles.length === expectedJudged.length,
    `bound blind bundle dataset must contain ${expectedJudged.length} records for selected schedules, found ${blindBundles.length}`
  );
  check(new Set(blindBundles.map((item) => item.blindId)).size === blindBundles.length, 'bound blind bundle IDs must be unique');
  blindBundles.forEach((binding) => {
    const assignment = judged.find((item) => item.blindId === binding.blindId);
    const selected = selectedBySchedule.get(binding.scheduleId);
    const artifact = artifactManifests.find((item) => item.runId === binding.runId);
    check(Boolean(assignment), `${binding.blindId} bound blind bundle must have a preregistered assignment`);
    if (assignment) {
      check(binding.scheduleId === assignment.scheduleId, `${binding.blindId} bound schedule must match preregistered assignment`);
      check(binding.judgeBlock === assignment.block, `${binding.blindId} bound judge block must match preregistered assignment`);
    }
    check(Boolean(selected), `${binding.blindId} must bind to a selected non-excluded run`);
    if (selected) {
      check(binding.runId === selected.runId, `${binding.blindId} must bind to selected run ${selected.runId}`);
      check(binding.sourceArtifactBundleSha256 === selected.refs.artifactBundleSha256, `${binding.blindId} source artifact hash must match selected run`);
    }
    check(Boolean(artifact), `${binding.blindId} must bind to an existing artifact manifest`);
    if (artifact) {
      check(binding.sourceArtifactBundleSha256 === artifact.bundleSha256, `${binding.blindId} source artifact hash must match artifact manifest`);
    }
    const authenticated = authenticatedArtifacts.get(binding.runId);
    if (authenticated) {
      check(
        binding.sourceArtifactBundleSha256 === authenticated.actualHash,
        `${binding.blindId} source artifact hash must authenticate exact selected artifact bytes`
      );
      try {
        const blindPath = resolveContainedPath(artifactRoot, binding.blindBundlePath, `${binding.blindId} blind bundle path`);
        check(fs.existsSync(blindPath), `${binding.blindId} generated blind bundle bytes must exist`);
        if (fs.existsSync(blindPath)) {
          const actualBlindHash = validateBlindContent(binding.blindId, authenticated.source, blindPath);
          check(actualBlindHash === binding.blindBundleSha256, `${binding.blindId} blind bundle hash must authenticate generated bytes`);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  });
}

const judgmentJson = walkFiles(path.join(dataRoot, 'judgments')).filter((file) => file.endsWith('.json'));
const judgmentRecords = judgmentJson.map(readJson).filter((item) => item.protocolId && item.blindId && item.scores);
if (judgmentJson.length > 0) {
  validateRecords(judgmentRecords, 'judgment');
  check(
    judgmentRecords.length === expectedJudged.length,
    `judgment dataset must contain ${expectedJudged.length} records for selected schedules including duplicates, found ${judgmentRecords.length}`
  );
  check(
    blindBundles.length === expectedJudged.length,
    `judgments require ${expectedJudged.length} run- and hash-bound blind bundles, found ${blindBundles.length}`
  );
  check(new Set(judgmentRecords.map((item) => item.blindId)).size === judgmentRecords.length, 'judgment blind IDs must be unique');
  judgmentRecords.forEach((judgment) => {
    const assignment = judged.find((item) => item.blindId === judgment.blindId);
    const binding = blindBundles.find((item) => item.blindId === judgment.blindId);
    check(Boolean(assignment), `${judgment.blindId} must have a judge assignment`);
    if (assignment) {
      check(judgment.duplicateOf === (assignment.duplicateOfBlindId || null), `${judgment.blindId} duplicate provenance must match assignment`);
      check(judgment.judgeBlock === assignment.block, `${judgment.blindId} judge block must match assignment`);
    }
    check(Boolean(binding), `${judgment.blindId} judgment must have a bound blind bundle`);
    if (binding) {
      check(judgment.runId === binding.runId, `${judgment.blindId} judgment run ID must match bound blind bundle`);
      check(judgment.sourceArtifactBundleSha256 === binding.sourceArtifactBundleSha256, `${judgment.blindId} judgment source artifact hash must match bound blind bundle`);
      check(judgment.blindBundleSha256 === binding.blindBundleSha256, `${judgment.blindId} judgment blind bundle hash must match bound blind bundle`);
    }
    const scoreValues = Object.values(judgment.scores);
    const expectedOverall = Math.round((scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length) * 100) / 100;
    check(Math.abs(judgment.overall - expectedOverall) < 1e-9, `${judgment.blindId} overall must equal the rounded arithmetic mean of dimension scores`);
  });
  const sessionsByBlock = assignments.blocks.map((block) => {
    const blockJudgments = judgmentRecords.filter((item) => item.judgeBlock === block.block);
    const expectedBlockArtifacts = block.artifacts.filter((item) => selectedBySchedule.get(item.scheduleId));
    const sessionIds = new Set(blockJudgments.map((item) => item.judgeSessionId));
    check(blockJudgments.length === expectedBlockArtifacts.length, `judge block ${block.block} must contain exactly ${expectedBlockArtifacts.length} judgments for selected schedules`);
    check(sessionIds.size === (expectedBlockArtifacts.length > 0 ? 1 : 0), `non-empty judge block ${block.block} must use exactly one judge session`);
    return sessionIds.size === 1 ? [...sessionIds][0] : null;
  });
  const expectedJudgeSessionCount = assignments.blocks.filter((block) => (
    block.artifacts.some((item) => selectedBySchedule.get(item.scheduleId))
  )).length;
  check(
    new Set(sessionsByBlock.filter(Boolean)).size === expectedJudgeSessionCount,
    expectedJudgeSessionCount === 6
      ? 'judgments must use exactly six distinct judge session IDs, one per non-empty assigned block'
      : `judgments must use exactly ${expectedJudgeSessionCount} distinct judge session IDs, one per non-empty assigned block`
  );
  const trialSessionIds = new Set(startedManifests.flatMap((manifest) => [
    manifest.execution.rootSessionId,
    manifest.execution.coordinatorSessionId,
    manifest.sessions.parent.sessionId,
    ...(manifest.condition === 'treatment' && manifest.sessions.specialist.sessionId
      ? [manifest.sessions.specialist.sessionId]
      : [])
  ]));
  check(
    sessionsByBlock.filter(Boolean).every((sessionId) => !trialSessionIds.has(sessionId)),
    'judge session IDs must be disjoint from all coordinator, parent, and specialist trial sessions'
  );
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`FAIL: ${error}`));
  process.exit(1);
}
console.log('PASS: preregistered dataset design is complete and internally consistent');
