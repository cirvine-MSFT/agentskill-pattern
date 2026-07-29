#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  canonicalJson,
  parseArguments,
  readJson,
  root
} = require('./lib');

const args = parseArguments(process.argv.slice(2));
const dimensions = [
  'function',
  'codeQuality',
  'integration',
  'recognizability',
  'composition',
  'cleanliness'
];
const sources = [
  {
    block: 1,
    argument: 'block-1',
    commit: '905c0898997aba295b5254e3ada4a003b91b3d8f',
    judgeSessionId: 'd2663e20-96c5-46bf-b09d-ef521b994d0c'
  },
  {
    block: 2,
    argument: 'block-2',
    commit: '9e0b915a4f84b3bacca443dd911e9ddbf638d24c',
    judgeSessionId: '2a61a1d3-62fe-4ba1-b2ac-83e1db1886cb'
  },
  {
    block: 3,
    argument: 'block-3',
    commit: '516f639fb639712c00bc1c5ea56c245b1e0b759a',
    judgeSessionId: '9648435b-5b13-4dad-a703-f1f6aeccd11b'
  },
  {
    block: 4,
    argument: 'block-4',
    commit: '1ebaba7375af2c9ca7943aee84e48b47c361fc7d',
    judgeSessionId: '312c3232-6246-43a8-bb1e-d27876a67011'
  },
  {
    block: 5,
    argument: 'block-5',
    commit: '3629acae10aee7506e32e4aa88928f7dcfb8646c',
    judgeSessionId: '61f2a399-901b-4496-b426-fada12803468'
  },
  {
    block: 6,
    argument: 'block-6',
    commit: 'af792a087dac6d3d994c442e57e78ccc3cd322ea',
    judgeSessionId: '088841aa-27bd-4eb8-a807-f065867c5c50'
  }
];

if (sources.some((source) => !args[source.argument])) {
  console.error('Usage: import-judgments.js --block-1 DIR --block-2 DIR --block-3 DIR --block-4 DIR --block-5 DIR --block-6 DIR [--check]');
  process.exit(2);
}

function git(repository, ...gitArgs) {
  return execFileSync('git', ['-C', repository, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function normalizedScores(source, blindId) {
  const container = source.scores && typeof source.scores === 'object'
    ? source.scores
    : source;
  const scores = Object.fromEntries(dimensions.map((dimension) => {
    const value = container[dimension];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${blindId} ${dimension} must be an integer from 1 through 5.`);
    }
    return [dimension, value];
  }));
  const overall = Math.round(
    (Object.values(scores).reduce((sum, score) => sum + score, 0) / dimensions.length) * 100
  ) / 100;
  if (source.overall !== overall) {
    throw new Error(`${blindId} overall ${source.overall} does not equal score mean ${overall}.`);
  }
  if (typeof source.rationale !== 'string' || source.rationale.length === 0) {
    throw new Error(`${blindId} rationale must be nonempty.`);
  }
  return { scores, overall };
}

const runtime = readJson(path.join(root, 'design', 'assignments-runtime.json'));
const outputDirectory = path.join(root, 'judgments');
const generated = new Map();

for (const source of sources) {
  const repository = path.resolve(args[source.argument]);
  const resolvedCommit = git(repository, 'rev-parse', `${source.commit}^{commit}`);
  if (resolvedCommit !== source.commit) {
    throw new Error(`Block ${source.block} resolved to ${resolvedCommit}, expected ${source.commit}.`);
  }

  const runtimeBlock = runtime.blocks.find((block) => block.block === source.block);
  if (!runtimeBlock) {
    throw new Error(`Runtime assignment block ${source.block} is missing.`);
  }
  const expectedBlindIds = new Set(runtimeBlock.artifacts.map((artifact) => artifact.blindId));
  const scoreFiles = git(repository, 'ls-tree', '--name-only', `${source.commit}:scores`)
    .split(/\r?\n/)
    .filter(Boolean);
  const actualBlindIds = new Set(scoreFiles
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json')));
  if (!equalSets(expectedBlindIds, actualBlindIds)) {
    throw new Error(`Block ${source.block} committed scores do not match runtime assignments.`);
  }

  for (const assignment of runtimeBlock.artifacts) {
    const blindId = assignment.blindId;
    const score = JSON.parse(git(repository, 'show', `${source.commit}:scores/${blindId}.json`));
    if (score.blindId !== blindId) {
      throw new Error(`${blindId} score payload identifies ${score.blindId}.`);
    }
    const binding = readJson(path.join(root, 'artifacts', 'blind', `${blindId}.binding.json`));
    for (const key of ['blindId', 'scheduleId']) {
      if (binding[key] !== assignment[key]) {
        throw new Error(`${blindId} binding ${key} does not match its runtime assignment.`);
      }
    }
    if (binding.judgeBlock !== source.block) {
      throw new Error(`${blindId} binding judge block does not match source block.`);
    }
    const { scores, overall } = normalizedScores(score, blindId);
    generated.set(blindId, {
      protocolId: runtime.protocolId,
      blindId,
      judgeBlock: source.block,
      judgeSessionId: source.judgeSessionId,
      judgeModel: runtimeBlock.judgeModel,
      runId: binding.runId,
      sourceArtifactBundleSha256: binding.sourceArtifactBundleSha256,
      blindBundleSha256: binding.blindBundleSha256,
      scores,
      overall,
      rationale: score.rationale,
      duplicateOf: assignment.duplicateOfBlindId || null
    });
  }
}

if (generated.size !== 49) {
  throw new Error(`Expected 49 judgments, generated ${generated.size}.`);
}

for (const [blindId, judgment] of [...generated].sort()) {
  const outputPath = path.join(outputDirectory, `${blindId}.judgment.json`);
  const bytes = canonicalJson(judgment);
  if (args.check) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== bytes) {
      throw new Error(`Generated judgment is stale: ${path.relative(root, outputPath)}`);
    }
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(outputPath, bytes, 'utf8');
  }
}

const unexpected = fs.readdirSync(outputDirectory)
  .filter((file) => file.endsWith('.judgment.json'))
  .filter((file) => !generated.has(file.replace(/\.judgment\.json$/, '')));
if (unexpected.length > 0) {
  throw new Error(`Unexpected judgment files: ${unexpected.join(', ')}`);
}

console.log(`${args.check ? 'PASS' : 'WROTE'}: 49 authenticated blinded judgments`);
