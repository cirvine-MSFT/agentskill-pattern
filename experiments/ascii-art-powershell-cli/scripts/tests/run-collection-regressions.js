#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertMaterializedBytes,
  fileAtCommit,
  materializeGitTree
} = require('../collection-bytes');
const { readJson, root, sha256, sha256RawFile, walkFiles } = require('../lib');

const rawRoot = path.join(root, 'raw');
const artifactRoot = path.join(root, 'artifacts');
const summary = readJson(path.join(root, 'results', 'collection-summary.json'));
const index = readJson(path.join(rawRoot, 'execution-index.json'));
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
const selectedRunIds = new Set(index.selectedRuns
  .filter((record) => record.status === 'completed')
  .map((record) => `${record.schedule_id}-A${record.attempt}`));
const missingSchedules = new Set(index.selectedRuns
  .filter((record) => record.status === 'missing')
  .map((record) => record.schedule_id));

assert.strictEqual(
  summary.collectionStage,
  'reconciled_execution_evidence_no_judgments'
);
assert.strictEqual(index.selectedRuns.length, 60);
assert.strictEqual(index.attempts.length, 82);
assert.strictEqual(index.deviations.length, 5);
assert.strictEqual(selectedRunIds.size, 46);
assert.strictEqual(missingSchedules.size, 14);
assert(!fs.existsSync(path.join(rawRoot, 'wrong-model-retry-plan.json')));
for (const runId of selectedRunIds) {
  const manifest = manifestByRun.get(runId);
  assert(manifest, `${runId} manifest missing`);
  assert.strictEqual(manifest.exclusion.excluded, false);
  assert.strictEqual(manifest.sessions.parent.requestedModel, 'gpt-5.6-sol');
  assert.strictEqual(manifest.sessions.parent.observedModel, 'gpt-5.6-sol');
  if (manifest.condition === 'treatment') {
    assert.strictEqual(manifest.sessions.specialist.requestedModel, 'claude-haiku-4.5');
    assert.strictEqual(manifest.sessions.specialist.observedModel, 'claude-haiku-4.5');
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
const executionIndexSource = provenance.sources.find((source) => (
  source.kind === 'execution-index-sqlite-export'
));
assert(executionIndexSource);
assert.strictEqual(executionIndexSource.sqliteExport.queries.selectedRuns.rowCount, 60);
assert.strictEqual(executionIndexSource.sqliteExport.queries.attempts.rowCount, 82);
assert.strictEqual(executionIndexSource.sqliteExport.queries.deviations.rowCount, 5);
assert.strictEqual(executionIndexSource.sqliteExport.executionIndex.selectedCompleted, 46);
assert.strictEqual(executionIndexSource.sqliteExport.executionIndex.missingSchedules, 14);
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

assert.strictEqual(initial.length, 82);
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
const p06Selected = summary.noncompliance.find((record) => (
  record.runId === 'P06-R3-treatment-A2' &&
  record.reasons.includes('specialist wrote in its own workspace and the parent copied the banner')
));
assert.strictEqual(p06Selected, undefined);

assert.strictEqual(summary.counts.finalSelectedCount, 46);
assert.strictEqual(summary.counts.missingSchedules, 14);
assert.strictEqual(summary.counts.attempts, 82);
assert.strictEqual(summary.counts.wrongModelExcludedAttempts, 27);
assert.strictEqual(summary.fullDatasetStageGates.observedModelMismatches.status, 'clear');
assert.strictEqual(summary.fullDatasetStageGates.completeness.status, 'blocked');
assert.strictEqual(summary.fullDatasetStageGates.completeness.missingSchedules.length, 14);
assert.strictEqual(summary.fullDatasetStageGates.artifactBlinding.status, 'blocked');
assert.strictEqual(manifestByRun.get('P04-R1-control-A1').exclusion.excluded, false);
const artifactManifests = walkFiles(artifactRoot)
  .filter((file) => file.endsWith('.artifacts.json'))
  .map(readJson);
assert.strictEqual(artifactManifests.length, 54);
assert(artifactManifests.every((artifact) => !missingSchedules.has(artifact.scheduleId)));

const byteTestRoot = path.join(__dirname, '.collection-bytes-test');
fs.rmSync(byteTestRoot, { recursive: true, force: true });
fs.mkdirSync(byteTestRoot, { recursive: true });
try {
  const repo = path.join(byteTestRoot, 'repo');
  const exactWorkspace = path.join(byteTestRoot, 'exact');
  const checkoutWorkspace = path.join(byteTestRoot, 'checkout');
  fs.mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Collection Test');
  git('config', 'user.email', 'collection@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    'src/Exact.ps1 text eol=crlf\n',
    'utf8'
  );
  fs.writeFileSync(path.join(repo, 'src', 'Exact.ps1'), 'line-one\nline-two\n', 'utf8');
  git('add', '.gitattributes', 'src/Exact.ps1');
  git('commit', '--quiet', '-m', 'Exact bytes');
  const commit = git('rev-parse', 'HEAD');
  const blob = fileAtCommit(repo, commit, 'src/Exact.ps1');
  const expected = [{
    path: 'src/Exact.ps1',
    bytes: blob,
    sha256: sha256(blob)
  }];
  materializeGitTree(repo, commit, exactWorkspace);
  assertMaterializedBytes(exactWorkspace, expected);
  const clone = spawnSync(
    'git',
    ['-c', 'core.autocrlf=true', 'clone', '--quiet', repo, checkoutWorkspace],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.strictEqual(clone.status, 0, clone.stderr || clone.stdout);
  const checkoutBytes = fs.readFileSync(
    path.join(checkoutWorkspace, 'src', 'Exact.ps1')
  );
  assert(checkoutBytes.includes(Buffer.from('\r\n')));
  assert(!checkoutBytes.equals(blob));
  assert.throws(
    () => assertMaterializedBytes(checkoutWorkspace, expected),
    /evaluated bytes differ/
  );
} finally {
  fs.rmSync(byteTestRoot, { recursive: true, force: true });
}

console.log('PASS: reconciled retries, models, missingness, provenance, file actors, and exact Git bytes');
