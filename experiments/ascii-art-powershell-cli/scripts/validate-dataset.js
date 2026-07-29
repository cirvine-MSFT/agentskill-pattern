#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, root, sha256File, walkFiles } = require('./lib');
const { validateSchema } = require('./validate-schema');
const {
  conditionErrors,
  deterministicConsistencyErrors,
  judgeBindingErrors,
  telemetryMetricErrors
} = require('./integrity');

const errors = [];
const prompts = readJson(path.join(root, 'prompts.json'));
const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const constants = readJson(path.join(root, 'design', 'conditions.json'));
const protocol = fs.readFileSync(path.join(root, 'protocol.md'), 'utf8');

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
  'design/conditions.json',
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
for (const schemaName of [
  'run-manifest',
  'raw-telemetry',
  'artifacts',
  'deterministic-results',
  'judge-assignment',
  'judge-bundle',
  'judgment'
]) {
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

function validateRecords(records, schemaName) {
  records.forEach((record) => {
    const schemaErrors = validateSchema(record, schemas[schemaName]);
    schemaErrors.forEach((error) => errors.push(`${schemaName} ${record.runId || record.blindId || '<unknown>'}: ${error}`));
  });
}

const rawJson = walkFiles(path.join(root, 'raw')).filter((file) => file.endsWith('.json'));
const rawObjects = rawJson.map(readJson);
const manifests = rawObjects.filter((item) => item.protocolId && item.condition && item.sessions);
const telemetry = rawObjects.filter((item) => item.protocolId && item.metrics && item.routing);
const deterministic = rawObjects.filter((item) => item.protocolId && item.functional && item.art && item.tamperCheck);
if (rawJson.length > 0) {
  validateRecords(manifests, 'run-manifest');
  validateRecords(telemetry, 'raw-telemetry');
  validateRecords(deterministic, 'deterministic-results');
  telemetry.forEach((record) => telemetryMetricErrors(record).forEach((error) => errors.push(`raw-telemetry ${record.runId}: ${error}`)));
  deterministic.forEach((record) => deterministicConsistencyErrors(record).forEach((error) => errors.push(`deterministic-results ${record.runId}: ${error}`)));
  check(manifests.length >= 60 && manifests.length <= 120, `complete raw dataset must contain 60-120 run attempts, found ${manifests.length}`);
  check(telemetry.length === manifests.length, `raw dataset must contain one telemetry record per run attempt, found ${telemetry.length} for ${manifests.length} attempts`);
  check(deterministic.length === manifests.length, `raw dataset must contain one deterministic result per run attempt, found ${deterministic.length} for ${manifests.length} attempts`);
  check(new Set(manifests.map((item) => item.runId)).size === manifests.length, 'run manifest run IDs must be unique');
  check(new Set(telemetry.map((item) => item.runId)).size === telemetry.length, 'telemetry run IDs must be unique');
  check(new Set(deterministic.map((item) => item.runId)).size === deterministic.length, 'deterministic result run IDs must be unique');
  check(manifests.every((item) => item.runId === `${item.scheduleId}-A${item.execution.attempt}`), 'run IDs must encode schedule ID and attempt');
  check(manifests.every((item) => telemetry.some((record) => record.runId === item.runId) && deterministic.some((record) => record.runId === item.runId)), 'every run attempt must have matching telemetry and deterministic records');
  check(new Set(manifests.map((item) => item.sessions.parent.sessionId)).size === manifests.length, 'parent session IDs must be unique across attempts');
  const specialistIds = manifests.filter((item) => item.condition === 'treatment' && item.sessions.specialist.sessionId).map((item) => item.sessions.specialist.sessionId);
  check(new Set(specialistIds).size === specialistIds.length, 'specialist session IDs must be unique across treatment attempts');
  check(new Set(manifests.map((item) => item.refs.benchmarkCommitSha)).size === 1, 'all attempts must use one benchmark commit SHA');
  check(manifests.every((item) => item.refs.promptsSha256 === sha256File(path.join(root, 'prompts.json'))), 'all attempts must use the registered prompt hash');
  check(manifests.every((item) => item.refs.fixtureLockSha256 === sha256File(path.join(root, 'fixture', 'fixture-lock.json'))), 'all attempts must use the registered fixture lock hash');
  manifests.forEach((manifest) => {
    const scheduledItem = observations.find((item) => item.scheduleId === manifest.scheduleId);
    const telemetryRecord = telemetry.find((item) => item.runId === manifest.runId);
    const deterministicRecord = deterministic.find((item) => item.runId === manifest.runId);
    check(Boolean(scheduledItem), `${manifest.runId} must reference a scheduled observation`);
    if (scheduledItem) {
      check(manifest.promptId === scheduledItem.promptId && manifest.repetition === scheduledItem.repetition && manifest.condition === scheduledItem.condition, `${manifest.runId} must match its scheduled prompt, repetition, and condition`);
      check(manifest.execution.block === scheduledItem.block && manifest.execution.position === scheduledItem.position, `${manifest.runId} must match its scheduled block and position`);
    }
    if (telemetryRecord) {
      check(telemetryRecord.scheduleId === manifest.scheduleId, `${manifest.runId} telemetry schedule ID must match`);
      check(telemetryRecord.routing.parent.sessionId === manifest.sessions.parent.sessionId, `${manifest.runId} parent routing session must match manifest`);
      check(telemetryRecord.routing.parent.observedModel === manifest.sessions.parent.observedModel, `${manifest.runId} parent routing model must match manifest`);
      conditionErrors(manifest, telemetryRecord, constants).forEach((error) => errors.push(error));
    }
    if (deterministicRecord) {
      check(deterministicRecord.scheduleId === manifest.scheduleId && deterministicRecord.promptId === manifest.promptId, `${manifest.runId} deterministic provenance must match manifest`);
    }
  });
  observations.forEach((scheduledItem) => {
    const attempts = manifests.filter((item) => item.scheduleId === scheduledItem.scheduleId);
    check(attempts.length >= 1 && attempts.length <= 2, `${scheduledItem.scheduleId} must have one or two attempts`);
    check(attempts.filter((item) => !item.exclusion.excluded).length === 1, `${scheduledItem.scheduleId} must have exactly one included attempt`);
    if (attempts.length === 2) {
      check(attempts.some((item) => item.execution.attempt === 1 && item.exclusion.excluded), `${scheduledItem.scheduleId} retry requires an excluded first attempt`);
      check(attempts.some((item) => item.execution.attempt === 2), `${scheduledItem.scheduleId} retry requires attempt 2`);
    }
  });
}

const artifactJson = walkFiles(path.join(root, 'artifacts')).filter((file) => file.endsWith('.json'));
const artifactManifests = artifactJson.map(readJson).filter((item) => item.protocolId && item.bundleSha256 && item.files);
const blindBundles = artifactJson.map(readJson).filter((item) => item.protocolId && item.blindBundleSha256 && item.blindId && item.files);
if (artifactJson.length > 0) {
  validateRecords(artifactManifests, 'artifacts');
  check(artifactManifests.length >= 60 && artifactManifests.length <= 120, `non-empty artifact dataset must contain 60-120 manifests, found ${artifactManifests.length}`);
  check(new Set(artifactManifests.map((item) => item.runId)).size === artifactManifests.length, 'artifact run IDs must be unique');
  check(artifactManifests.length === manifests.length, 'artifact dataset must contain one manifest per run attempt');
  artifactManifests.forEach((artifact) => {
    const manifest = manifests.find((item) => item.runId === artifact.runId);
    check(Boolean(manifest), `${artifact.runId} artifact must have a matching run manifest`);
    if (manifest) {
      check(artifact.scheduleId === manifest.scheduleId, `${artifact.runId} artifact schedule ID must match manifest`);
      check(artifact.sessionId === manifest.sessions.parent.sessionId, `${artifact.runId} artifact parent session must match manifest`);
      check(artifact.terminalCommitSha === manifest.refs.terminalCommitSha, `${artifact.runId} artifact commit must match manifest`);
      check(artifact.bundleSha256 === manifest.refs.artifactBundleSha256, `${artifact.runId} artifact bundle hash must match manifest`);
    }
  });
}
if (blindBundles.length > 0) {
  validateRecords(blindBundles, 'judge-bundle');
  check(blindBundles.length === 66, `non-empty blinded bundle dataset must contain 66 manifests, found ${blindBundles.length}`);
  check(new Set(blindBundles.map((item) => item.blindId)).size === blindBundles.length, 'blinded bundle IDs must be unique');
}

const judgmentJson = walkFiles(path.join(root, 'judgments')).filter((file) => file.endsWith('.json'));
const judgmentRecords = judgmentJson.map(readJson).filter((item) => item.protocolId && item.blindId && item.scores);
const materializedManifests = judgmentJson.map(readJson).filter((item) => item.protocolId && Array.isArray(item.assignments));
if (judgmentJson.length > 0) {
  check(materializedManifests.length === 1, `judgment dataset must contain exactly one materialized assignment manifest, found ${materializedManifests.length}`);
  materializedManifests.forEach((item) => validateRecords([item], 'judge-assignment'));
  materializedManifests.forEach((item) => check(
    item.designSha256 === sha256File(path.join(root, 'design', 'judge-assignments.json')),
    'materialized judge assignments must bind the registered judge design hash'
  ));
  validateRecords(judgmentRecords, 'judgment');
  check(judgmentRecords.length === 66, `non-empty judgment dataset must contain 66 records including duplicates, found ${judgmentRecords.length}`);
  check(new Set(judgmentRecords.map((item) => item.blindId)).size === judgmentRecords.length, 'judgment blind IDs must be unique');
  judgmentRecords.forEach((judgment) => {
    const assignment = judged.find((item) => item.blindId === judgment.blindId);
    check(Boolean(assignment), `${judgment.blindId} must have a judge assignment`);
    if (assignment) {
      check(judgment.duplicateOf === (assignment.duplicateOfBlindId || null), `${judgment.blindId} duplicate provenance must match assignment`);
    }
    const scoreValues = Object.values(judgment.scores);
    const expectedOverall = Math.round((scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length) * 100) / 100;
    check(Math.abs(judgment.overall - expectedOverall) < 1e-9, `${judgment.blindId} overall must equal the rounded arithmetic mean of dimension scores`);
  });
  if (materializedManifests.length === 1) {
    const selectedRuns = new Map();
    observations.forEach((scheduledItem) => {
      const selected = manifests
        .filter((item) => item.scheduleId === scheduledItem.scheduleId && !item.exclusion.excluded)
        .sort((left, right) => right.execution.attempt - left.execution.attempt)[0];
      if (selected) selectedRuns.set(scheduledItem.scheduleId, selected);
    });
    const staticAssignments = assignments.blocks.flatMap((block) => block.artifacts.map((item) => ({ ...item, block: block.block })));
    judgeBindingErrors(
      materializedManifests[0].assignments,
      staticAssignments,
      selectedRuns,
      artifactManifests,
      blindBundles,
      judgmentRecords,
      constants
    ).forEach((error) => errors.push(error));
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`FAIL: ${error}`));
  process.exit(1);
}
console.log('PASS: preregistered dataset design is complete and internally consistent');
