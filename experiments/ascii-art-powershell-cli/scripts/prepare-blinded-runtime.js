#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  parseArguments,
  protocolId,
  readJson,
  root,
  sha256,
  sha256RawFile,
  walkFiles,
  writeJson
} = require('./lib');
const {
  authenticateArtifactBundle,
  buildBlindContent,
  validateBlindContent
} = require('./artifact-bundles');
const { validateSchema } = require('./validate-schema');

const args = parseArguments(process.argv.slice(2));
if (!args.runs || !args.artifacts || !args.out ||
    !args.assignments || !args.summary) {
  console.error(
    'Usage: prepare-blinded-runtime.js --runs DIR --artifacts DIR --out DIR ' +
    '--assignments FILE --summary FILE'
  );
  process.exit(2);
}

const infrastructureReasons = new Set([
  'session_creation_failure',
  'hash_mismatch',
  'wrong_model',
  'non_fresh_session',
  'telemetry_collection_failure',
  'external_interruption',
  'required_tool_unavailable'
]);
const expectedUnjudgeable = Object.freeze({
  blindId: 'B0022',
  scheduleId: 'P04-R1-control',
  runId: 'P04-R1-control-A1',
  candidatePhrase: 'control output',
  reason: 'P04-R1-control-A1 source artifact candidate content contains a prohibited high-confidence condition-revealing provenance marker at $[property:1].value[0][property:0].value.'
});

function jsonValues(directory) {
  return walkFiles(path.resolve(directory))
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map(readJson);
}

function selectedManifest(manifests, scheduleId) {
  const selected = manifests.filter((manifest) => (
    manifest.scheduleId === scheduleId && !manifest.exclusion.excluded
  ));
  if (selected.length === 1) return selected[0];
  if (selected.length > 1) {
    throw new Error(`${scheduleId} has more than one selected run.`);
  }

  const attempts = manifests
    .filter((manifest) => manifest.scheduleId === scheduleId)
    .sort((left, right) => left.execution.attempt - right.execution.attempt);
  const exhausted = attempts.length === 2 &&
    attempts.every((manifest) => manifest.exclusion.excluded &&
      infrastructureReasons.has(manifest.exclusion.reason)) &&
    attempts[0].execution.attempt === 1 &&
    attempts[1].execution.attempt === 2 &&
    attempts[0].exclusion.retryId === attempts[1].runId &&
    attempts[1].exclusion.retryOf === attempts[0].runId;
  if (!exhausted) {
    throw new Error(`${scheduleId} has no selected run and is not an exhausted infrastructure schedule.`);
  }
  return null;
}

function containsCandidatePhrase(artifactDirectory, artifact, phrase) {
  const bundlePath = path.resolve(artifactDirectory, artifact.bundlePath);
  return fs.readFileSync(bundlePath, 'utf8').toLowerCase().includes(phrase.toLowerCase());
}

const manifests = jsonValues(args.runs).filter((value) => (
  value.exclusion && value.execution &&
  ((value.sessions && value.refs) || value.recordType === 'pre_execution_failure')
));
const deterministic = jsonValues(args.runs).filter((value) => (
  value.functional && value.art && value.tamperCheck
));
const artifacts = jsonValues(args.artifacts).filter((value) => value.bundleSha256 && value.files);
const assignmentsPath = path.join(root, 'design', 'judge-assignments.json');
const assignments = readJson(assignmentsPath);
const prompts = readJson(path.join(root, 'prompts.json'));
const bindingSchema = readJson(path.join(root, 'schemas', 'blind-bundle.schema.json'));
const artifactDirectory = path.resolve(args.artifacts);
const outputDirectory = path.resolve(args.out);
const assignmentsOutput = path.resolve(args.assignments);
const summaryOutput = path.resolve(args.summary);
const assignmentRows = assignments.blocks.flatMap((block) => (
  block.artifacts.map((assignment) => ({ block: block.block, assignment }))
));
const primaryRows = assignmentRows.filter(({ assignment }) => !assignment.duplicateOfBlindId);
const selectedBySchedule = new Map();
const missingScheduleIds = [];

for (const { assignment } of primaryRows) {
  const selected = selectedManifest(manifests, assignment.scheduleId);
  selectedBySchedule.set(assignment.scheduleId, selected);
  if (!selected) missingScheduleIds.push(assignment.scheduleId);
}

const authenticationByRun = new Map();
const unjudgeable = [];
for (const selected of [...selectedBySchedule.values()].filter(Boolean)) {
  if (authenticationByRun.has(selected.runId)) continue;
  const artifactMatches = artifacts.filter((item) => item.runId === selected.runId);
  if (artifactMatches.length !== 1 ||
      artifactMatches[0].bundleSha256 !== selected.refs.artifactBundleSha256) {
    throw new Error(`Source artifact does not match selected run ${selected.runId}.`);
  }
  const resultMatches = deterministic.filter((item) => item.runId === selected.runId);
  const prompt = prompts.find((item) => item.id === selected.promptId);
  if (resultMatches.length !== 1 || !prompt) {
    throw new Error(`${selected.runId} requires one deterministic result and preregistered prompt.`);
  }

  try {
    authenticationByRun.set(selected.runId, authenticateArtifactBundle(
      artifactDirectory,
      artifactMatches[0],
      selected,
      prompt,
      resultMatches[0]
    ));
  } catch (error) {
    const isExpected = selected.scheduleId === expectedUnjudgeable.scheduleId &&
      selected.runId === expectedUnjudgeable.runId &&
      error.message === expectedUnjudgeable.reason &&
      containsCandidatePhrase(
        artifactDirectory,
        artifactMatches[0],
        expectedUnjudgeable.candidatePhrase
      );
    if (!isExpected) throw error;
    unjudgeable.push({ ...expectedUnjudgeable });
  }
}

if (unjudgeable.length !== 1) {
  throw new Error(`Expected exactly one frozen scanner rejection, found ${unjudgeable.length}.`);
}

const successfulPrimaryIds = new Set(primaryRows
  .filter(({ assignment }) => {
    const selected = selectedBySchedule.get(assignment.scheduleId);
    return selected && authenticationByRun.has(selected.runId);
  })
  .map(({ assignment }) => assignment.blindId));
const includedRows = assignmentRows.filter(({ assignment }) => {
  const selected = selectedBySchedule.get(assignment.scheduleId);
  if (!selected || !authenticationByRun.has(selected.runId)) return false;
  return !assignment.duplicateOfBlindId ||
    successfulPrimaryIds.has(assignment.duplicateOfBlindId);
});

const generated = includedRows.map(({ block, assignment }) => {
  const selected = selectedBySchedule.get(assignment.scheduleId);
  const authenticated = authenticationByRun.get(selected.runId);
  const blindContent = buildBlindContent(assignment.blindId, authenticated.source);
  const blindBytes = canonicalJson(blindContent);
  const blindFilename = `${assignment.blindId}.bundle.json`;
  const blindBundlePath = path.relative(
    artifactDirectory,
    path.join(outputDirectory, blindFilename)
  ).split(path.sep).join('/');
  const binding = {
    protocolId,
    blindId: assignment.blindId,
    judgeBlock: block,
    scheduleId: assignment.scheduleId,
    runId: selected.runId,
    sourceArtifactBundleSha256: authenticated.actualHash,
    blindBundlePath,
    blindBundleSha256: sha256(Buffer.from(blindBytes, 'utf8'))
  };
  const schemaErrors = validateSchema(binding, bindingSchema);
  if (schemaErrors.length > 0) {
    throw new Error(`${assignment.blindId} binding violates its schema: ${schemaErrors.join('; ')}`);
  }
  return { assignment, authenticated, binding, blindBytes, blindFilename };
});

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });
for (const item of generated) {
  const blindPath = path.join(outputDirectory, item.blindFilename);
  fs.writeFileSync(blindPath, item.blindBytes, 'utf8');
  writeJson(
    path.join(outputDirectory, `${item.assignment.blindId}.binding.json`),
    item.binding
  );
  const actualBlindHash = validateBlindContent(
    item.assignment.blindId,
    item.authenticated.source,
    blindPath
  );
  if (actualBlindHash !== item.binding.blindBundleSha256) {
    throw new Error(`${item.assignment.blindId} blind bundle exact-byte hash mismatch.`);
  }
}

const includedIds = new Set(includedRows.map(({ assignment }) => assignment.blindId));
const runtimeAssignments = {
  ...assignments,
  blocks: assignments.blocks.map((block) => ({
    ...block,
    artifacts: block.artifacts.filter((assignment) => includedIds.has(assignment.blindId))
  }))
};
writeJson(assignmentsOutput, runtimeAssignments);

const blockCounts = assignments.blocks.map((block) => {
  const plannedPrimary = block.artifacts.filter((item) => !item.duplicateOfBlindId);
  const plannedDuplicates = block.artifacts.filter((item) => item.duplicateOfBlindId);
  const available = runtimeAssignments.blocks.find((item) => item.block === block.block).artifacts;
  return {
    block: block.block,
    planned: {
      primary: plannedPrimary.length,
      reliabilityDuplicates: plannedDuplicates.length,
      total: block.artifacts.length
    },
    available: {
      primary: available.filter((item) => !item.duplicateOfBlindId).length,
      reliabilityDuplicates: available.filter((item) => item.duplicateOfBlindId).length,
      total: available.length
    },
    missingScheduleIds: plannedPrimary
      .filter((item) => !selectedBySchedule.get(item.scheduleId))
      .map((item) => item.scheduleId),
    unjudgeableBlindIds: plannedPrimary
      .filter((item) => {
        const selected = selectedBySchedule.get(item.scheduleId);
        return selected && !authenticationByRun.has(selected.runId);
      })
      .map((item) => item.blindId)
  };
});
const availablePrimary = includedRows.filter(({ assignment }) => !assignment.duplicateOfBlindId).length;
const availableDuplicates = includedRows.length - availablePrimary;
const summary = {
  protocolId,
  sourceAssignments: {
    path: 'design/judge-assignments.json',
    sha256: sha256RawFile(assignmentsPath)
  },
  runtimeAssignmentsPath: path.relative(root, assignmentsOutput).split(path.sep).join('/'),
  blindDirectory: path.relative(root, outputDirectory).split(path.sep).join('/'),
  counts: {
    plannedPrimary: primaryRows.length,
    availablePrimary,
    plannedReliabilityDuplicates: assignmentRows.length - primaryRows.length,
    availableReliabilityDuplicates: availableDuplicates,
    plannedTotal: assignmentRows.length,
    availableTotal: includedRows.length
  },
  blocks: blockCounts,
  missingScheduleIds,
  unjudgeable,
  designRealization: {
    preregisteredBalancedTenPrimaryDesignRealized: false,
    noReplacementOrRebalancingAfterOutcomes: true,
    reason: `${missingScheduleIds.length} planned schedules have no selected artifact after exhausted infrastructure attempts, and ${unjudgeable.length} selected artifact is unjudgeable because the frozen provenance scanner rejected its candidate content. Runtime assignments retain only successfully bound blind IDs in original block and within-block order.`
  }
};
writeJson(summaryOutput, summary);

const writtenFiles = walkFiles(outputDirectory);
if (writtenFiles.length !== includedRows.length * 2) {
  throw new Error(
    `Blind directory contains ${writtenFiles.length} files; expected ${includedRows.length * 2}.`
  );
}
if (runtimeAssignments.blocks.some((block, index) => (
  block.artifacts.some((item, itemIndex) => (
    item !== assignments.blocks[index].artifacts.filter(
      (candidate) => includedIds.has(candidate.blindId)
    )[itemIndex]
  ))
))) {
  throw new Error('Runtime assignments do not preserve original block and within-block order.');
}
if (runtimeAssignments.blocks.flatMap((block) => block.artifacts).some((item) => (
  item.duplicateOfBlindId && !includedIds.has(item.duplicateOfBlindId)
))) {
  throw new Error('Runtime assignments retain a reliability duplicate without its source primary.');
}

console.log(
  `WROTE: ${includedRows.length} bound blind assignments; ` +
  `${missingScheduleIds.length} missing schedules; ${unjudgeable.length} unjudgeable artifact.`
);
