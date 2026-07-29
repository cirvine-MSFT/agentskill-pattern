#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  canonicalJson,
  parseArguments,
  readJson,
  root
} = require('./lib');

const args = parseArguments(process.argv.slice(2));
const collection = readJson(path.join(root, 'results', 'collection-summary.json'));
const judgeUsage = readJson(path.join(root, 'results', 'judge-usage.json'));
const summaryPath = path.join(root, 'results', 'summary.json');
const validationPath = path.join(root, 'results', 'validation-summary.json');
const temporaryDirectory = args.check
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-benchmark-results-'))
  : null;
const generatedSummaryPath = args.check
  ? path.join(temporaryDirectory, 'summary.json')
  : summaryPath;

function run(script, extraArgs = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...extraArgs], {
    cwd: root,
    encoding: 'utf8'
  });
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const standard = run('validate-dataset.js');
if (standard.status !== 0) {
  throw new Error(`Standard dataset validation failed:\n${standard.stderr}`);
}

const strict = run('validate-dataset.js', ['--require-complete']);
const expectedStrictFailures = collection.missingSchedules.map((scheduleId) => (
  `FAIL: ${scheduleId} completeness gate requires one selected included run`
));
const actualStrictFailures = lines(strict.stderr);
if (strict.status !== 1 ||
    canonicalJson(actualStrictFailures) !== canonicalJson(expectedStrictFailures)) {
  throw new Error(`Strict validation produced unexpected failures:\n${strict.stderr}`);
}

const summary = run('summarize.js', [
  '--runs', path.join(root, 'raw'),
  '--artifacts', path.join(root, 'artifacts'),
  '--judgments', path.join(root, 'judgments'),
  '--out', generatedSummaryPath,
  '--allow-incomplete',
  '--generated-at', judgeUsage.generatedAt
]);
if (summary.status !== 0) {
  throw new Error(`Summary generation failed:\n${summary.stderr}`);
}

const generatedSummary = readJson(generatedSummaryPath);
const expectedCounts = {
  scheduled: collection.counts.plannedSchedules,
  runAttempts: collection.counts.attempts,
  excludedAttempts: collection.counts.excludedAttempts,
  selectedRuns: collection.counts.finalSelectedCount,
  judgments: 45,
  missingSchedules: collection.counts.missingSchedules
};
const actualCounts = {
  scheduled: generatedSummary.dataset.scheduled,
  runAttempts: generatedSummary.dataset.runAttempts,
  excludedAttempts: generatedSummary.dataset.excludedAttempts,
  selectedRuns: generatedSummary.dataset.selectedRuns,
  judgments: generatedSummary.dataset.judgments,
  missingSchedules: generatedSummary.dataset.completeness.missingScheduleIds.length
};
if (canonicalJson(actualCounts) !== canonicalJson(expectedCounts)) {
  throw new Error(`Generated summary counts are inconsistent: ${JSON.stringify(actualCounts)}`);
}
if (generatedSummary.judgeReliability.availablePairs !== 4) {
  throw new Error('Generated summary must include four available reliability pairs.');
}
for (const scope of ['intentToTreat', 'perProtocol']) {
  for (const outcome of generatedSummary[scope].outcomes) {
    if (outcome.completeness.inferentialOutput !== 'withheld' ||
        outcome.promptClusteredBootstrap95.status !== 'unavailable') {
      throw new Error(`${scope} ${outcome.outcome} must withhold inferential output.`);
    }
  }
}

const validationSummary = {
  protocolId: collection.protocolId,
  standardValidation: {
    exitCode: standard.status,
    status: 'pass',
    message: lines(standard.stdout)[0]
  },
  strictCompletenessValidation: {
    exitCode: strict.status,
    status: 'expected_incomplete',
    unexpectedFailures: 0,
    expectedGateFailures: expectedStrictFailures
  },
  generatedSummary: {
    path: 'results/summary.json',
    allowIncomplete: true,
    counts: actualCounts,
    inferentialOutput: 'withheld'
  }
};

function compareOrWrite(file, value) {
  const bytes = canonicalJson(value);
  if (args.check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== bytes) {
      throw new Error(`Generated file is stale: ${path.relative(root, file)}`);
    }
  } else {
    fs.writeFileSync(file, bytes, 'utf8');
  }
}

if (args.check) {
  if (!fs.existsSync(summaryPath) ||
      fs.readFileSync(summaryPath, 'utf8') !== fs.readFileSync(generatedSummaryPath, 'utf8')) {
    throw new Error('Generated file is stale: results/summary.json');
  }
}
compareOrWrite(validationPath, validationSummary);

if (temporaryDirectory) {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.log(`${args.check ? 'PASS' : 'WROTE'}: validated incomplete descriptive results`);
