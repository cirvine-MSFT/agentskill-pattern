#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  conditionInstructions,
  parentModel,
  parseArguments,
  readJson,
  root,
  sha256File,
  specialistModel,
  walkFiles
} = require('./lib');
const { validateSchema } = require('./validate-schema');

const args = parseArguments(process.argv.slice(2));
const dataRoot = args['data-root'] ? path.resolve(args['data-root']) : root;
const errors = [];
const prompts = readJson(path.join(root, 'prompts.json'));
const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
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
for (const schemaName of ['run-manifest', 'raw-telemetry', 'artifacts', 'blind-bundle', 'deterministic-results', 'judgment']) {
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

const rawJson = walkFiles(path.join(dataRoot, 'raw')).filter((file) => file.endsWith('.json'));
const rawObjects = rawJson.map(readJson);
const manifests = rawObjects.filter((item) => item.protocolId && item.condition && item.sessions);
const telemetry = rawObjects.filter((item) => item.protocolId && item.metrics && item.routing);
const deterministic = rawObjects.filter((item) => item.protocolId && item.functional && item.art && item.tamperCheck);
if (rawJson.length > 0) {
  validateRecords(manifests, 'run-manifest');
  validateRecords(telemetry, 'raw-telemetry');
  validateRecords(deterministic, 'deterministic-results');
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
      check(manifest.conditionInstruction === conditionInstructions[scheduledItem.condition], `${manifest.runId} must use the exact preregistered ${scheduledItem.condition} instruction`);
    }
    const parentModelMismatch = manifest.sessions.parent.requestedModel !== parentModel ||
      manifest.sessions.parent.observedModel !== parentModel;
    const specialistModelMismatch = manifest.condition === 'treatment' && (
      manifest.sessions.specialist.status === 'not_applicable' ||
      manifest.sessions.specialist.requestedModel !== specialistModel ||
      manifest.sessions.specialist.observedModel !== specialistModel
    );
    const modelMismatch = parentModelMismatch || specialistModelMismatch;
    check(
      !modelMismatch || (manifest.exclusion.excluded && manifest.exclusion.reason === 'wrong_model'),
      `${manifest.runId} wrong requested/observed model must be explicitly excluded with reason wrong_model`
    );
    check(
      modelMismatch || manifest.exclusion.reason !== 'wrong_model',
      `${manifest.runId} must not claim wrong_model exclusion when all requested/observed models are preregistered`
    );
    if (telemetryRecord) {
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
        check(Boolean(manifest.sessions.specialist.sessionId), `${manifest.runId} treatment manifest must identify a specialist session`);
        check(telemetryRecord.routing.specialist.sessionId === manifest.sessions.specialist.sessionId, `${manifest.runId} specialist routing session must match manifest`);
        check(telemetryRecord.routing.specialist.requestedModel === manifest.sessions.specialist.requestedModel && telemetryRecord.routing.specialist.observedModel === manifest.sessions.specialist.observedModel, `${manifest.runId} specialist routing model must match manifest`);
        check(specialistSplits.length === 1, `${manifest.runId} treatment telemetry must contain exactly one specialist model split`);
        if (specialistSplits.length === 1) {
          const specialistSplit = specialistSplits[0];
          check(
            specialistSplit.sessionId === manifest.sessions.specialist.sessionId &&
            specialistSplit.requestedModel === manifest.sessions.specialist.requestedModel &&
            specialistSplit.observedModel === manifest.sessions.specialist.observedModel,
            `${manifest.runId} specialist model split must match manifest provenance`
          );
        }
        check(telemetryRecord.routing.delegationEvidence.status === 'available', `${manifest.runId} treatment delegation evidence must be available`);
      } else {
        check(manifest.sessions.specialist.status === 'not_applicable', `${manifest.runId} control manifest specialist must be not_applicable`);
        check(telemetryRecord.routing.specialist.status === 'not_applicable', `${manifest.runId} control routing specialist must be not_applicable`);
        check(specialistSplits.length === 0, `${manifest.runId} control telemetry must not contain a specialist model split`);
        check(telemetryRecord.routing.delegationEvidence.status === 'not_applicable', `${manifest.runId} control delegation evidence must be not_applicable`);
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
    const attempts = manifests.filter((item) => item.scheduleId === scheduledItem.scheduleId);
    check(attempts.length >= 1 && attempts.length <= 2, `${scheduledItem.scheduleId} must have one or two attempts`);
    check(attempts.filter((item) => !item.exclusion.excluded).length === 1, `${scheduledItem.scheduleId} must have exactly one included attempt`);
    if (attempts.length === 2) {
      const first = attempts.find((item) => item.execution.attempt === 1);
      const retry = attempts.find((item) => item.execution.attempt === 2);
      check(Boolean(first && first.exclusion.excluded), `${scheduledItem.scheduleId} retry requires an excluded first attempt`);
      check(Boolean(retry), `${scheduledItem.scheduleId} retry requires attempt 2`);
      if (first && retry) {
        check(
          first.exclusion.retryOf === null &&
          first.exclusion.retryId === retry.runId &&
          retry.exclusion.retryOf === first.runId &&
          retry.exclusion.retryId === null,
          `${scheduledItem.scheduleId} retry attempts must have reciprocal retryId/retryOf linkage`
        );
      }
    } else {
      check(
        attempts[0].exclusion.retryOf === null && attempts[0].exclusion.retryId === null,
        `${scheduledItem.scheduleId} single attempt must not record retry linkage`
      );
    }
  });
}

const artifactJson = walkFiles(path.join(dataRoot, 'artifacts')).filter((file) => file.endsWith('.json'));
const artifactManifests = artifactJson.map(readJson).filter((item) => item.protocolId && item.bundleSha256 && item.files);
const blindBundles = artifactJson.map(readJson).filter((item) => item.protocolId && item.blindId && item.blindBundleSha256);
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

const selectedBySchedule = new Map(observations.map((scheduledItem) => [
  scheduledItem.scheduleId,
  manifests.find((manifest) => manifest.scheduleId === scheduledItem.scheduleId && !manifest.exclusion.excluded)
]));
if (blindBundles.length > 0) {
  validateRecords(blindBundles, 'blind-bundle');
  check(blindBundles.length === 66, `bound blind bundle dataset must contain 66 records, found ${blindBundles.length}`);
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
  });
}

const judgmentJson = walkFiles(path.join(dataRoot, 'judgments')).filter((file) => file.endsWith('.json'));
const judgmentRecords = judgmentJson.map(readJson).filter((item) => item.protocolId && item.blindId && item.scores);
if (judgmentJson.length > 0) {
  validateRecords(judgmentRecords, 'judgment');
  check(judgmentRecords.length === 66, `non-empty judgment dataset must contain 66 records including duplicates, found ${judgmentRecords.length}`);
  check(blindBundles.length === 66, `judgments require 66 run- and hash-bound blind bundles, found ${blindBundles.length}`);
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
    const sessionIds = new Set(blockJudgments.map((item) => item.judgeSessionId));
    check(blockJudgments.length === block.artifacts.length, `judge block ${block.block} must contain exactly ${block.artifacts.length} judgments`);
    check(sessionIds.size === 1, `judge block ${block.block} must use exactly one judge session`);
    return sessionIds.size === 1 ? [...sessionIds][0] : null;
  });
  check(new Set(sessionsByBlock.filter(Boolean)).size === 6, 'judgments must use exactly six distinct judge session IDs, one per assigned block');
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`FAIL: ${error}`));
  process.exit(1);
}
console.log('PASS: preregistered dataset design is complete and internally consistent');
