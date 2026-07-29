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
  sha256RawFile,
  sha256,
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
  preExecution: schema('pre-execution-failure'),
  telemetry: schema('raw-telemetry'),
  deterministic: schema('deterministic-results'),
  artifact: schema('artifacts')
  ,
  artifactBundle: schema('artifact-bundle')
};
const prompts = readJson(path.join(root, 'prompts.json'));
const index = readJson(path.join(rawRoot, 'execution-index.json'));
const summary = readJson(path.join(resultRoot, 'collection-summary.json'));
const selected = new Set(index.selectedRuns
  .filter((run) => run.status === 'completed')
  .map((run) => `${run.schedule_id}-A${run.attempt}`));
const missing = new Set(index.selectedRuns
  .filter((run) => run.status === 'missing')
  .map((run) => run.schedule_id));
const readMatching = (suffix) => walkFiles(rawRoot)
  .filter((file) => file.endsWith(suffix))
  .map(readJson);
const manifests = readMatching('.manifest.json');
const preExecution = readMatching('.pre-execution.json');
const telemetry = readMatching('.telemetry.json');
const deterministic = readMatching('.deterministic.json');
const artifacts = walkFiles(artifactRoot)
  .filter((file) => file.endsWith('.artifacts.json'))
  .map(readJson);

function validate(records, schemaValue, label) {
  for (const record of records) {
    for (const error of validateSchema(record, schemaValue)) {
      errors.push(`${label} ${record.runId}: ${error}`);
    }
  }
}

validate(manifests, schemas.manifest, 'manifest');
validate(preExecution, schemas.preExecution, 'pre-execution');
validate(telemetry, schemas.telemetry, 'telemetry');
validate(deterministic, schemas.deterministic, 'deterministic');
validate(artifacts, schemas.artifact, 'artifact');

check(index.protocolId === 'ascii-art-powershell-cli-v1', 'execution index protocol ID must match');
check(index.selectedRuns.length === 60, 'execution index must contain 60 schedules');
check(index.attempts.length === 67, 'execution index must contain 67 attempts');
check(selected.size === 58, 'execution index must contain 58 selected completed runs');
check(missing.size === 2, 'execution index must contain two structurally missing schedules');
check(index.deviations.length === 4, 'execution index must preserve four deviations');
check(manifests.length === 63, 'collection must contain 63 started-attempt manifests');
check(preExecution.length === 4, 'collection must contain four pre-execution failures');
check(telemetry.length === manifests.length, 'every started attempt must have telemetry');
check(deterministic.length === manifests.length, 'every started attempt must have deterministic results');
check(artifacts.length === manifests.length, 'every collectable started attempt must have an artifact');
check(new Set([...manifests, ...preExecution].map((record) => record.runId)).size === 67, 'attempt run IDs must be unique');

for (const record of manifests) {
  const telemetryRecord = telemetry.find((item) => item.runId === record.runId);
  const deterministicRecord = deterministic.find((item) => item.runId === record.runId);
  const artifact = artifacts.find((item) => item.runId === record.runId);
  const prompt = prompts.find((item) => item.id === record.promptId);
  check(Boolean(telemetryRecord), `${record.runId} telemetry is missing`);
  check(Boolean(deterministicRecord), `${record.runId} deterministic result is missing`);
  check(Boolean(artifact), `${record.runId} artifact is missing`);
  if (!telemetryRecord || !deterministicRecord || !artifact || !prompt) continue;

  const rawSources = new Map();
  for (const source of telemetryRecord.rawSources) {
    try {
      const sourcePath = resolveContainedPath(rawRoot, source.path, `${record.runId} raw source`);
      check(fs.existsSync(sourcePath), `${record.runId} raw source bytes are missing`);
      if (!fs.existsSync(sourcePath)) continue;
      check(sha256RawFile(sourcePath) === source.sha256, `${record.runId} raw source hash mismatch`);
      const value = readJson(sourcePath);
      check(value.sourceId === source.sourceId, `${record.runId} raw source ID mismatch`);
      rawSources.set(source.sourceId, value.events);
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const [sourceId, events] of rawSources) {
    check(
      canonicalJson(events) === canonicalJson(telemetryRecord.events.filter((event) => event.rawSourceId === sourceId)),
      `${record.runId} normalized events must exactly match authenticated raw source bytes`
    );
  }
  const integrity = validateTelemetryConsistency(record, telemetryRecord, prompt);
  integrity.errors.forEach((error) => errors.push(`${record.runId} ${error}`));
  try {
    const bundlePath = resolveContainedPath(artifactRoot, artifact.bundlePath, `${record.runId} artifact bundle`);
    check(fs.existsSync(bundlePath), `${record.runId} artifact bundle bytes are missing`);
    if (!fs.existsSync(bundlePath)) continue;
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
      return {
        path: file.path,
        sha256: sha256(bytes),
        bytes: bytes.length,
        role: file.role
      };
    });
    check(canonicalJson(expectedFiles) === canonicalJson(artifact.files), `${record.runId} artifact file manifest mismatch`);
  } catch (error) {
    errors.push(error.message);
  }
}

for (const record of preExecution) {
  check(!telemetry.some((item) => item.runId === record.runId), `${record.runId} pre-execution attempt has telemetry`);
  check(!deterministic.some((item) => item.runId === record.runId), `${record.runId} pre-execution attempt has deterministic results`);
  check(!artifacts.some((item) => item.runId === record.runId), `${record.runId} pre-execution attempt has artifacts`);
}
for (const runId of selected) {
  check(manifests.some((item) => item.runId === runId), `${runId} selected manifest is missing`);
  check(telemetry.some((item) => item.runId === runId), `${runId} selected telemetry is missing`);
  check(deterministic.some((item) => item.runId === runId), `${runId} selected deterministic result is missing`);
  check(artifacts.some((item) => item.runId === runId), `${runId} selected artifact is missing`);
}
for (const scheduleId of missing) {
  check(!manifests.some((item) => item.scheduleId === scheduleId && !item.exclusion.excluded), `${scheduleId} must not have a selected run`);
  check(!artifacts.some((item) => item.scheduleId === scheduleId), `${scheduleId} must not have an artifact`);
}

const p06Deviation = summary.noncompliance.find((item) => item.scheduleId === 'P06-R3-treatment');
check(Boolean(p06Deviation), 'P06-R3-treatment must be recorded noncompliant');
check(summary.counts.plannedSchedules === 60, 'summary planned schedule count must reconcile');
check(summary.counts.attempts === 67, 'summary attempt count must reconcile');
check(summary.counts.selectedCompleted === 58, 'summary selected count must reconcile');
check(summary.counts.structurallyMissingSchedules === 2, 'summary missing count must reconcile');
check(summary.telemetrySources.cloudEvents.status === 'unavailable', 'summary must disclose unavailable cloud events');
check(summary.telemetrySources.judgeUsage.status === 'not_applicable', 'summary must disclose absent judge usage');
check(walkFiles(path.join(dataRoot, 'judgments')).filter((file) => file.endsWith('.json')).length === 0, 'collection stage must not contain judgments');

if (errors.length > 0) {
  errors.forEach((error) => console.error(`FAIL: ${error}`));
  process.exit(1);
}
console.log('PASS: collection-stage evidence is complete, schema-valid, exact-byte authenticated, and judgment-free');
