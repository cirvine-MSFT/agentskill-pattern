#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  parseArguments,
  readJson,
  resolveContainedPath,
  root,
  sha256,
  sha256RawFile,
  walkFiles
} = require('./lib');
const { sanitizedDeterministic } = require('./artifact-bundles');
const { validateTelemetryConsistency } = require('./telemetry-integrity');
const { validateSchema } = require('./validate-schema');

const args = parseArguments(process.argv.slice(2));
const dataRoot = args['data-root'] ? path.resolve(args['data-root']) : root;
const rawRoot = path.join(dataRoot, 'raw');
const artifactRoot = path.join(dataRoot, 'artifacts');
const resultRoot = path.join(dataRoot, 'results');
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};
const schema = (name) => readJson(path.join(root, 'schemas', `${name}.schema.json`));
const schemas = {
  manifest: schema('run-manifest'),
  telemetry: schema('raw-telemetry'),
  deterministic: schema('deterministic-results'),
  artifact: schema('artifacts'),
  artifactBundle: schema('artifact-bundle')
};
const prompts = readJson(path.join(root, 'prompts.json'));
const index = readJson(path.join(rawRoot, 'execution-index.json'));
const summary = readJson(path.join(resultRoot, 'collection-summary.json'));
const provenanceIndex = readJson(path.join(rawRoot, 'provenance-index.json'));
const readMatching = (suffix) => walkFiles(rawRoot)
  .filter((file) => file.endsWith(suffix))
  .map(readJson);
const manifests = readMatching('.manifest.json');
const preExecution = readMatching('.pre-execution.json');
const telemetry = readMatching('.telemetry.json');
const deterministic = readMatching('.deterministic.json');
const initialWorkspace = readMatching('.initial-workspace.json');
const artifacts = walkFiles(artifactRoot)
  .filter((file) => file.endsWith('.artifacts.json'))
  .map(readJson);
const manifestByRun = new Map(manifests.map((record) => [record.runId, record]));
const telemetryByRun = new Map(telemetry.map((record) => [record.runId, record]));
const deterministicByRun = new Map(deterministic.map((record) => [record.runId, record]));
const artifactByRun = new Map(artifacts.map((record) => [record.runId, record]));
const initialByRun = new Map(initialWorkspace.map((record) => [record.runId, record]));
const provenanceById = new Map(provenanceIndex.sources.map((source) => [source.sourceId, source]));
const originalMissingSchedules = new Set(index.selectedRuns
  .filter((run) => run.status === 'missing')
  .map((run) => run.schedule_id));
const selectedRunIds = new Set(index.selectedRuns
  .filter((run) => run.status === 'completed')
  .map((run) => `${run.schedule_id}-A${run.attempt}`));

function exactLines(file) {
  const bytes = fs.readFileSync(file);
  const lines = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end += 1;
    if (end < bytes.length && bytes[end] === 0x0d && bytes[end + 1] === 0x0a) end += 2;
    else if (end < bytes.length) end += 1;
    lines.push({
      offset,
      raw: bytes.subarray(offset, end),
      text: bytes.subarray(offset, end).toString('utf8').replace(/\r?\n$|\r$/, '')
    });
    offset = end;
  }
  return lines;
}

function validate(records, schemaValue, label) {
  for (const record of records) {
    for (const error of validateSchema(record, schemaValue)) {
      errors.push(`${label} ${record.runId}: ${error}`);
    }
  }
}

function parseSourceReference(eventId) {
  const match = eventId.match(
    /^([^:]+):line:(\d+)(?::origin:(\d+))?:offset:(\d+):sha:([a-f0-9]{20}):id:([^:]+):/
  );
  return match ? {
    sourceId: match[1],
    line: Number(match[2]),
    originalLine: match[3] ? Number(match[3]) : null,
    offset: Number(match[4]),
    lineHashPrefix: match[5],
    sourceRecordId: match[6]
  } : null;
}

function validateEventSource(record, event, rawSource) {
  const runId = record.runId;
  check(Boolean(rawSource), `${runId} event ${event.eventId} raw source descriptor is missing`);
  if (!rawSource) return;
  const source = provenanceById.get(event.rawSourceId);
  check(Boolean(source), `${runId} event ${event.eventId} source is absent from provenance index`);
  if (!source) return;
  check(source.path === rawSource.path, `${runId} event source path must match provenance index`);
  check(source.sha256 === rawSource.sha256, `${runId} event source hash must match provenance index`);
  const sourcePath = resolveContainedPath(rawRoot, source.path, `${runId} raw source`);
  const lines = exactLines(sourcePath);
  const reference = parseSourceReference(event.eventId);
  check(Boolean(reference), `${runId} event ${event.eventId} lacks line/offset/hash provenance`);
  if (!reference) return;
  check(reference.sourceId === source.sourceId, `${runId} event ${event.eventId} source ID mismatch`);
  const line = lines[reference.line - 1];
  check(Boolean(line), `${runId} event ${event.eventId} source line is missing`);
  if (!line) return;
  check(
    sha256(line.raw).startsWith(reference.lineHashPrefix),
    `${runId} event ${event.eventId} exact source line hash mismatch`
  );
  if (source.kind === 'events_jsonl_slice') {
    const rawEvent = JSON.parse(line.text);
    check(rawEvent.id === reference.sourceRecordId, `${runId} raw event ID mismatch`);
    const indexPath = resolveContainedPath(rawRoot, source.indexPath, `${runId} event index`);
    const sourceIndex = readJson(indexPath);
    const indexed = sourceIndex.records.find((record) => (
      record.sourceEventId === rawEvent.id && record.sliceLine === reference.line
    ));
    check(Boolean(indexed), `${runId} raw event index record is missing`);
    if (indexed) {
      check(indexed.originalLine === reference.originalLine, `${runId} original event line mismatch`);
      check(indexed.originalByteOffset === reference.offset, `${runId} original event offset mismatch`);
      check(indexed.exactLineSha256 === sha256(line.raw), `${runId} indexed event hash mismatch`);
    }
    if (event.type === 'tool_call') {
      check(rawEvent.type === 'tool.execution_start', `${runId} tool call source type mismatch`);
      check(rawEvent.data.toolCallId === event.callId, `${runId} tool call ID source mismatch`);
      check(rawEvent.data.toolName === event.toolName, `${runId} tool name source mismatch`);
    }
    if (event.type === 'tool_result') {
      check(rawEvent.type === 'tool.execution_complete', `${runId} tool result source type mismatch`);
      check(rawEvent.data.toolCallId === event.callId, `${runId} tool result ID source mismatch`);
    }
    if (event.type === 'file_change' && event.eventId.includes(':tool-result:file-change')) {
      check(rawEvent.type === 'tool.execution_complete', `${runId} file actor must bind to mutating tool result`);
      const specialistId = record.sessions.specialist.sessionId || null;
      if (event.sessionId === specialistId && source.role === 'parent') {
        check(
          rawEvent.data.parentToolCallId === specialistId,
          `${runId} in-process specialist file actor lacks parentToolCallId provenance`
        );
      } else {
        check(
          event.sessionId === source.actorSessionId,
          `${runId} file actor does not match authenticated source session`
        );
      }
    }
  } else {
    check(line.offset === reference.offset, `${runId} source row byte offset mismatch`);
    if (event.type === 'usage') {
      check(line.text.includes(`| ${reference.sourceRecordId} |`), `${runId} usage row ID mismatch`);
    }
    if (event.type === 'file_change') {
      check(line.text.includes(`| ${event.operation} |`), `${runId} file operation source mismatch`);
    }
    if (event.type === 'session_start') {
      check(line.text.includes(reference.sourceRecordId), `${runId} app session source mismatch`);
    }
  }
}

function validateArtifact(record, deterministicRecord, artifact, prompt) {
  try {
    const bundlePath = resolveContainedPath(artifactRoot, artifact.bundlePath, `${record.runId} artifact bundle`);
    check(fs.existsSync(bundlePath), `${record.runId} artifact bundle bytes are missing`);
    if (!fs.existsSync(bundlePath)) return;
    check(sha256RawFile(bundlePath) === artifact.bundleSha256, `${record.runId} artifact bundle hash mismatch`);
    check(artifact.bundleSha256 === record.refs.artifactBundleSha256, `${record.runId} artifact hash must match manifest`);
    const bundle = readJson(bundlePath);
    for (const error of validateSchema(bundle, schemas.artifactBundle)) {
      errors.push(`artifact-bundle ${record.runId}: ${error}`);
    }
    check(bundle.promptId === record.promptId && bundle.prompt === prompt.prompt, `${record.runId} artifact prompt provenance mismatch`);
    check(canonicalJson(bundle.deterministic) === canonicalJson(sanitizedDeterministic(deterministicRecord)), `${record.runId} artifact deterministic provenance mismatch`);
    const expectedFiles = bundle.files.map((file) => {
      const bytes = Buffer.from(file.content, 'utf8');
      return { path: file.path, sha256: sha256(bytes), bytes: bytes.length, role: file.role };
    });
    check(canonicalJson(expectedFiles) === canonicalJson(artifact.files), `${record.runId} artifact file manifest mismatch`);
  } catch (error) {
    errors.push(error.message);
  }
}

validate(manifests, schemas.manifest, 'manifest');
validate(telemetry, schemas.telemetry, 'telemetry');
validate(deterministic, schemas.deterministic, 'deterministic');
validate(artifacts, schemas.artifact, 'artifact');

check(index.selectedRuns.length === 60, 'execution index must contain 60 schedules');
check(index.attempts.length === 82, 'execution index must contain 82 attempts');
check(index.deviations.length === 5, 'execution index must preserve five deviations');
check(selectedRunIds.size === 46, 'execution index must contain 46 completed selections');
check(originalMissingSchedules.size === 14, 'execution index must contain 14 genuine missing schedules');
check(manifests.length === 82, 'all 82 created attempts must be session-started manifests');
check(preExecution.length === 0, 'created attempts must not be represented as pre-execution failures');
check(telemetry.length === 82, 'every created attempt must have telemetry');
check(deterministic.length === 82, 'every created attempt must have deterministic evidence');
check(initialWorkspace.length === 82, 'every created attempt must have initial workspace provenance');
check(artifacts.length === 54, 'only attempts from schedules with a selected run may retain artifacts');
check(new Set(manifests.map((record) => record.runId)).size === 82, 'run IDs must be unique');

for (const source of provenanceIndex.sources) {
  const sourcePath = resolveContainedPath(rawRoot, source.path, `${source.sourceId} provenance source`);
  check(fs.existsSync(sourcePath), `${source.sourceId} exact source bytes are missing`);
  if (fs.existsSync(sourcePath)) {
    check(sha256RawFile(sourcePath) === source.sha256, `${source.sourceId} exact source hash mismatch`);
  }
  if (source.kind === 'events_jsonl_slice') {
    check(
      /^[a-f0-9]{64}$/.test(source.originalEventsSha256 || ''),
      `${source.sourceId} must bind the complete original events.jsonl hash`
    );
    check(
      Number.isInteger(source.originalEventsBytes) && source.originalEventsBytes > 0,
      `${source.sourceId} must record the complete original events.jsonl byte length`
    );
  }
  if (['local-usage-export', 'local-file-change-export'].includes(source.kind)) {
    check(source.query?.dialect === 'sqlite', `${source.sourceId} must retain SQLite query provenance`);
    check(typeof source.query?.sql === 'string' && source.query.sql.startsWith('SELECT '), `${source.sourceId} SQL text is missing`);
    check(source.query?.exportSha256 === source.sha256, `${source.sourceId} query export hash mismatch`);
    check(source.query?.sourceDatabaseSnapshot?.status === 'available_post_query_snapshot', `${source.sourceId} database snapshot identity is missing`);
    check(
      /^[a-f0-9]{64}$/.test(source.query?.sourceDatabaseSnapshot?.snapshotSha256 || ''),
      `${source.sourceId} source database snapshot hash is missing`
    );
    check(
      source.query?.sourceDatabaseSnapshot?.queryTimeSnapshotStatus === 'unavailable',
      `${source.sourceId} must not imply that the post-query snapshot is the query-time snapshot`
    );
  }
  if (source.kind === 'execution-index-sqlite-export') {
    check(source.sqliteExport?.queries?.selectedRuns?.rowCount === 60, 'execution index source must bind 60 observation_runs rows');
    check(source.sqliteExport?.queries?.attempts?.rowCount === 82, 'execution index source must bind 82 observation_attempts rows');
    check(source.sqliteExport?.queries?.deviations?.rowCount === 5, 'execution index source must bind five deviation rows');
    check(source.sqliteExport?.executionIndex?.selectedCompleted === 46, 'execution index source selected count mismatch');
    check(source.sqliteExport?.executionIndex?.missingSchedules === 14, 'execution index source missing count mismatch');
  }
}

for (const record of manifests) {
  const telemetryRecord = telemetryByRun.get(record.runId);
  const deterministicRecord = deterministicByRun.get(record.runId);
  const artifact = artifactByRun.get(record.runId);
  const initial = initialByRun.get(record.runId);
  const prompt = prompts.find((item) => item.id === record.promptId);
  check(Boolean(telemetryRecord), `${record.runId} telemetry is missing`);
  check(Boolean(deterministicRecord), `${record.runId} deterministic result is missing`);
  check(Boolean(initial), `${record.runId} initial workspace provenance is missing`);
  if (!telemetryRecord || !deterministicRecord || !initial || !prompt) continue;
  check(record.refs.initialTreeSha === initial.initialTreeSha, `${record.runId} initial tree object mismatch`);
  if (initial.status === 'fail') {
    check(record.exclusion.excluded, `${record.runId} initial workspace mismatch must be rejected`);
  }
  const rawSourceById = new Map(telemetryRecord.rawSources.map((source) => [source.sourceId, source]));
  for (const rawSource of telemetryRecord.rawSources) {
    const sourcePath = resolveContainedPath(rawRoot, rawSource.path, `${record.runId} raw source`);
    check(fs.existsSync(sourcePath), `${record.runId} raw source bytes are missing`);
    if (fs.existsSync(sourcePath)) {
      check(sha256RawFile(sourcePath) === rawSource.sha256, `${record.runId} raw source hash mismatch`);
    }
  }
  for (const event of telemetryRecord.events) {
    validateEventSource(record, event, rawSourceById.get(event.rawSourceId));
  }
  if (record.exclusion.reason !== 'telemetry_collection_failure') {
    const integrity = validateTelemetryConsistency(record, telemetryRecord, prompt);
    integrity.errors.forEach((error) => errors.push(`${record.runId} ${error}`));
  } else {
    check(deterministicRecord.status === 'unavailable', `${record.runId} unavailable telemetry requires unavailable deterministic result`);
  }
  if (artifact) validateArtifact(record, deterministicRecord, artifact, prompt);
  else check(originalMissingSchedules.has(record.scheduleId), `${record.runId} missing artifact is allowed only for an exhausted original schedule`);
  if (artifact) {
    const byteAssertion = deterministicRecord.tamperCheck.assertions.find((assertion) => (
      assertion.id === 'evaluated-bundle-byte-identity'
    ));
    check(
      byteAssertion?.status === 'pass',
      `${record.runId} evaluated bytes must be authenticated to artifact bundle bytes`
    );
  }
}

for (const runId of selectedRunIds) {
  const manifest = manifestByRun.get(runId);
  check(Boolean(manifest), `${runId} selected manifest is missing`);
  if (!manifest) continue;
  check(!manifest.exclusion.excluded, `${runId} selected run must not be excluded`);
  check(
    manifest.sessions.parent.requestedModel === 'gpt-5.6-sol' &&
      manifest.sessions.parent.observedModel === 'gpt-5.6-sol',
    `${runId} selected parent requested/observed model mismatch`
  );
  if (manifest.condition === 'treatment') {
    check(
      manifest.sessions.specialist.requestedModel === 'claude-haiku-4.5' &&
        manifest.sessions.specialist.observedModel === 'claude-haiku-4.5',
      `${runId} selected specialist requested/observed model mismatch`
    );
  }
  check(artifactByRun.has(runId), `${runId} selected artifact is missing`);
}
check(!fs.existsSync(path.join(rawRoot, 'wrong-model-retry-plan.json')), 'final collection must not retain a pending retry plan');
for (const artifact of artifacts) {
  check(!originalMissingSchedules.has(artifact.scheduleId), `${artifact.runId} missing schedule must not retain an artifact`);
}

const p06Deviation = summary.noncompliance.find((item) => item.runId === 'P06-R3-treatment-A1');
check(p06Deviation?.reasons.includes('specialist wrote in its own workspace and the parent copied the banner'), 'P06-R3-treatment copy deviation must be explicit');
check(
  summary.collectionStage === 'reconciled_execution_evidence_no_judgments',
  'summary collection stage must be reconciled after final retries'
);
check(summary.counts.startedAttempts === 82, 'summary started count must reconcile');
check(summary.counts.preExecutionAttempts === 0, 'summary pre-execution count must be zero');
check(summary.counts.wrongModelExcludedAttempts === 27, 'summary wrong-model count must reconcile');
check(summary.counts.missingSchedules === 14, 'summary missing count must reconcile');
check(summary.counts.finalSelectedCount === 46, 'summary selected count must reconcile');
check(summary.counts.artifactRecords === 54, 'summary artifact count must reconcile');
check(summary.fullDatasetStageGates.observedModelMismatches.status === 'clear', 'selected model gate must be clear');
check(summary.fullDatasetStageGates.completeness.status === 'blocked', 'genuine missing schedules must block completeness');
check(summary.fullDatasetStageGates.completeness.missingSchedules.length === 14, 'completeness gate must contain 14 missing schedules');
check(summary.telemetrySources.localSessionStore.status === 'available_with_post_query_snapshot', 'summary must qualify SQLite provenance');
check(summary.telemetrySources.cloudEvents.status === 'unavailable', 'summary must disclose unavailable cloud events');
check(summary.telemetrySources.judgeUsage.status === 'not_applicable', 'summary must disclose absent judge usage');
check(!manifestByRun.get('P04-R1-control-A1').exclusion.excluded, 'P04 control-output phrase must not exclude the trial');
check(summary.fullDatasetStageGates.artifactBlinding.status === 'blocked', 'P04 phrase must remain a blinding-stage gate');
check(walkFiles(path.join(dataRoot, 'judgments')).filter((file) => file.endsWith('.json')).length === 0, 'collection stage must not contain judgments');

if (errors.length > 0) {
  errors.forEach((error) => console.error(`FAIL: ${error}`));
  process.exit(1);
}
console.log('PASS: corrected collection is schema-valid, source-authenticated, retry-aware, and judgment-free');
