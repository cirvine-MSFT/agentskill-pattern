#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readJson, root, sha256RawFile, walkFiles } = require('../lib');

const rawRoot = path.join(root, 'raw');
const artifactRoot = path.join(root, 'artifacts');
const summary = readJson(path.join(root, 'results', 'collection-summary.json'));
const retryPlan = readJson(path.join(rawRoot, 'wrong-model-retry-plan.json'));
const provenance = readJson(path.join(rawRoot, 'provenance-index.json'));
const manifests = walkFiles(rawRoot)
  .filter((file) => file.endsWith('.manifest.json'))
  .map(readJson);
const telemetry = walkFiles(rawRoot)
  .filter((file) => file.endsWith('.telemetry.json'))
  .map(readJson);
const initial = walkFiles(rawRoot)
  .filter((file) => file.endsWith('.initial-workspace.json'))
  .map(readJson);
const manifestByRun = new Map(manifests.map((record) => [record.runId, record]));

assert.strictEqual(
  summary.collectionStage,
  'provisional_execution_evidence_awaiting_wrong_model_retries'
);
assert.strictEqual(retryPlan.mismatchedSelectedAttempts.length, 19);
assert.strictEqual(retryPlan.requiresRealA2.length, 15);
assert.strictEqual(retryPlan.exhaustedMissingSchedules.length, 4);
for (const entry of retryPlan.mismatchedSelectedAttempts) {
  const manifest = manifestByRun.get(entry.runId);
  assert(manifest, `${entry.runId} manifest missing`);
  assert.strictEqual(entry.parentSessionId, manifest.sessions.parent.sessionId);
  assert.strictEqual(entry.requestedParentModel, manifest.sessions.parent.requestedModel);
  assert.strictEqual(entry.observedParentModel, manifest.sessions.parent.observedModel);
  if (manifest.condition === 'treatment') {
    assert.strictEqual(entry.specialistSessionId, manifest.sessions.specialist.sessionId || null);
  }
  assert.strictEqual(manifest.exclusion.reason, 'wrong_model');
  if (entry.action === 'requires_real_A2') {
    assert.strictEqual(manifest.exclusion.retryId, `${entry.scheduleId}-A2`);
    assert(!manifestByRun.has(`${entry.scheduleId}-A2`), `${entry.scheduleId} A2 was fabricated`);
  } else {
    assert.strictEqual(entry.attempt, 2);
    assert.strictEqual(manifest.exclusion.retryId, null);
  }
}

const createdWithoutCli = new Set([
  'P09-R2-treatment-A1',
  'P09-R2-treatment-A2',
  'P09-R3-treatment-A1',
  'P09-R3-treatment-A2'
]);
assert.strictEqual(
  walkFiles(rawRoot).filter((file) => file.endsWith('.pre-execution.json')).length,
  0
);
for (const runId of createdWithoutCli) {
  const manifest = manifestByRun.get(runId);
  const telemetryRecord = telemetry.find((record) => record.runId === runId);
  assert.strictEqual(manifest.attempt.phase, 'session_started');
  assert.strictEqual(manifest.exclusion.reason, 'telemetry_collection_failure');
  assert(telemetryRecord, `${runId} telemetry missing`);
  assert.strictEqual(telemetryRecord.routing.delegationEvidence.status, 'unavailable');
}

assert(provenance.sources.some((source) => source.kind === 'local-usage-export'));
assert(provenance.sources.some((source) => source.kind === 'local-file-change-export'));
assert(provenance.sources.some((source) => source.kind === 'app-session-export'));
for (const source of provenance.sources) {
  const sourcePath = path.join(rawRoot, ...source.path.split('/'));
  assert(fs.existsSync(sourcePath), `${source.sourceId} source bytes missing`);
  assert.strictEqual(sha256RawFile(sourcePath), source.sha256);
  if (source.kind === 'events_jsonl_slice') {
    assert.match(source.originalEventsSha256, /^[a-f0-9]{64}$/);
    assert(source.originalEventsBytes > 0);
  }
}
for (const kind of ['local-usage-export', 'local-file-change-export']) {
  const source = provenance.sources.find((candidate) => candidate.kind === kind);
  assert.strictEqual(source.query.dialect, 'sqlite');
  assert.match(source.query.sql, /^SELECT /);
  assert.strictEqual(source.query.exportSha256, source.sha256);
  assert.match(source.query.sourceDatabaseSnapshot.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(
    source.query.sourceDatabaseSnapshot.queryTimeSnapshotStatus,
    'unavailable'
  );
}
for (const record of telemetry) {
  for (const event of record.events) {
    assert.match(
      event.eventId,
      /:line:\d+(?::origin:\d+)?:offset:\d+:sha:[a-f0-9]{20}:id:/
    );
    assert(!event.rawSourceId.startsWith('local-authenticated-'));
  }
}

assert.strictEqual(initial.length, 67);
for (const record of initial) {
  assert.match(record.initialTreeSha, /^[a-f0-9]{40}$/);
  assert.strictEqual(manifestByRun.get(record.runId).refs.initialTreeSha, record.initialTreeSha);
  assert.strictEqual(record.fixture.files.length, 4);
  if (record.status === 'fail') {
    assert.strictEqual(manifestByRun.get(record.runId).exclusion.excluded, true);
  }
}

const p05 = telemetry.find((record) => record.runId === 'P05-R1-treatment-A1');
const p05Specialist = p05.routing.specialist.sessionId;
const p05Changes = p05.events.filter((event) => (
  event.type === 'file_change' && event.sessionId === p05Specialist
));
assert(p05Changes.length > 0);
assert(p05Changes.every((event) => event.eventId.includes(':tool-result:file-change')));
const p06Deviation = summary.noncompliance.find((record) => (
  record.runId === 'P06-R3-treatment-A1'
));
assert(p06Deviation);
assert(p06Deviation.reasons.includes(
  'specialist wrote in its own workspace and the parent copied the banner'
));

assert.strictEqual(summary.counts.finalSelectedCount, null);
assert.strictEqual(summary.counts.pendingRealA2Schedules, 15);
assert.strictEqual(summary.counts.retryExhaustedMissingSchedules, 4);
assert.strictEqual(summary.counts.knownMissingSchedules, 6);
assert.strictEqual(summary.fullDatasetStageGates.artifactBlinding.status, 'blocked');
assert.strictEqual(manifestByRun.get('P04-R1-control-A1').exclusion.excluded, false);
assert.strictEqual(
  walkFiles(artifactRoot).filter((file) => file.endsWith('.artifacts.json')).length,
  63
);

console.log('PASS: wrong-model, started-attempt, raw-source, initial-tree, and file-actor regressions');
