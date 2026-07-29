#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, root, writeJson } = require('./lib');

const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const judgeDesign = readJson(path.join(root, 'design', 'judge-assignments.json'));
const observations = schedule.blocks.flatMap((block) => block.observations);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-analysis-test-'));
const runs = path.join(temporaryRoot, 'runs');
const judgments = path.join(temporaryRoot, 'judgments');
const summaryPath = path.join(temporaryRoot, 'summary.json');
const artifactHash = 'a'.repeat(64);
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(judgments, { recursive: true });

function writeRuns(unavailableScheduleId = null) {
  for (const observation of observations) {
    const runId = `${observation.scheduleId}-A1`;
    writeJson(path.join(runs, `${runId}-manifest.json`), {
      runId,
      scheduleId: observation.scheduleId,
      condition: observation.condition,
      execution: { attempt: 1 },
      sessions: {},
      refs: { artifactBundleSha256: artifactHash },
      exclusion: { excluded: false },
      conditionCompliance: { compliant: true }
    });
    writeJson(path.join(runs, `${runId}-telemetry.json`), {
      runId,
      scheduleId: observation.scheduleId,
      metrics: {},
      models: [],
      tools: [],
      compaction: [],
      routing: {
        parent: { sourceEventIds: [] },
        specialist: { status: 'not_applicable' },
        delegationEvidence: { status: 'not_applicable' }
      }
    });
    const unavailable = observation.scheduleId === unavailableScheduleId;
    const status = unavailable
      ? 'unavailable'
      : (observation.condition === 'treatment' ? 'pass' : 'fail');
    const groupStatus = unavailable ? 'unavailable' : status;
    writeJson(path.join(runs, `${runId}-deterministic.json`), {
      runId,
      scheduleId: observation.scheduleId,
      functional: { status: groupStatus },
      art: { status: groupStatus },
      tamperCheck: { status: groupStatus },
      status
    });
  }
}

function writeJudgments() {
  const materialized = [];
  for (const block of judgeDesign.blocks) {
    for (const design of block.artifacts) {
      const runId = `${design.scheduleId}-A1`;
      const assignment = {
        ...design,
        block: block.block,
        selectedRunId: runId,
        artifactBundleSha256: artifactHash,
        blindBundleSha256: artifactHash,
        judgeSessionId: `judge-${block.block}`
      };
      materialized.push(assignment);
      writeJson(path.join(judgments, `${design.blindId}.json`), {
        blindId: design.blindId,
        block: block.block,
        scheduleId: design.scheduleId,
        selectedRunId: runId,
        artifactBundleSha256: artifactHash,
        blindBundleSha256: artifactHash,
        judgeSessionId: `judge-${block.block}`,
        scores: {
          function: 3,
          codeQuality: 3,
          integration: 3,
          recognizability: 3,
          composition: 3,
          cleanliness: 3
        },
        overall: 3
      });
    }
  }
  writeJson(path.join(judgments, 'assignments.json'), { assignments: materialized });
}

function summarize() {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'summarize.js'),
    '--runs', runs,
    '--judgments', judgments,
    '--out', summaryPath
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return readJson(summaryPath);
}

function summarizeFailure() {
  return spawnSync(process.execPath, [
    path.join(root, 'scripts', 'summarize.js'),
    '--runs', runs,
    '--judgments', judgments,
    '--out', summaryPath
  ], { encoding: 'utf8' });
}

try {
  writeRuns();
  writeJudgments();
  const complete = summarize();
  const completePass = complete.intentToTreat.outcomes.find((outcome) => outcome.outcome === 'deterministicPass');
  assert.strictEqual(completePass.unit, 'percentage_points');
  assert.strictEqual(completePass.meanPairedDifference, 100);
  assert.strictEqual(completePass.promptClusteredBootstrap95.status, 'available');
  assert.strictEqual(completePass.promptClusteredBootstrap95.lower, 100);
  assert.strictEqual(completePass.promptClusteredBootstrap95.upper, 100);
  const outcomeNames = new Set(complete.intentToTreat.outcomes.map((outcome) => outcome.outcome));
  for (const required of [
    'model.parent.aiCredits',
    'model.parent.cachedTokens',
    'model.specialist.outputTokens',
    'tools.resultBytesTotal',
    'tools.durationMsTotal',
    'compaction.eventCount',
    'compaction.returnBytesTotal',
    'routing.parentSourceEventCount',
    'routing.delegationEvidenceAvailable',
    'telemetry.unavailableFieldCount'
  ]) {
    assert(outcomeNames.has(required), `missing secondary outcome ${required}`);
  }

  writeRuns('P01-R1-treatment');
  const missing = summarize();
  const missingPass = missing.intentToTreat.outcomes.find((outcome) => outcome.outcome === 'deterministicPass');
  assert.strictEqual(missingPass.completePairs, 29);
  assert.strictEqual(missingPass.missingPairs, 1);
  assert.strictEqual(missingPass.promptClusteredBootstrap95.status, 'unavailable');
  assert.match(missingPass.promptClusteredBootstrap95.reason, /all 10 prompt clusters/);
  assert.strictEqual(missingPass.missingnessByCondition.treatment.missingOrUnavailable, 1);

  const firstJudgment = fs.readdirSync(judgments).find((file) => /^B[0-9]{4}\.json$/.test(file));
  const firstJudgmentPath = path.join(judgments, firstJudgment);
  const tampered = readJson(firstJudgmentPath);
  tampered.blindBundleSha256 = 'b'.repeat(64);
  writeJson(firstJudgmentPath, tampered);
  const tamperedResult = summarizeFailure();
  assert.notStrictEqual(tamperedResult.status, 0, 'stale blind-bundle judgment must be rejected');

  console.log('PASS: paired analysis, secondary telemetry, and missing-data regressions');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
