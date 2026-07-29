#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  canonicalJson,
  parseArguments,
  readJson,
  resolveContainedPath,
  root,
  sha256,
  walkFiles
} = require('./lib');

const args = parseArguments(process.argv.slice(2));
const dataRoot = args['data-root'] ? path.resolve(args['data-root']) : root;
const expectedSourceManifestSha256 = '56637bdbc1df505d4f4e0d14591af9c6713aa704a9209c8cfb80ba27593839ae';
const manifestCanonicalization = 'UTF-8 JSON.stringify(value, null, 2) with fixed insertion order and one trailing LF';
const sourceCanonicalization = 'none; exact Git blob bytes preserved';
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
    tree: 'dbe117b51605c77515ef413d03f9b1a71dafd58a',
    scoresTree: '30c608273d2651b1b751416768eea99af2cc17d0',
    judgeSessionId: 'd2663e20-96c5-46bf-b09d-ef521b994d0c',
    expectedCount: 9
  },
  {
    block: 2,
    argument: 'block-2',
    commit: '9e0b915a4f84b3bacca443dd911e9ddbf638d24c',
    tree: 'c98a2f9f85bf40d8c573377b71ad6d7da06ce387',
    scoresTree: 'c5170b99ee5f020efdbc096a167be1ef4ad7515e',
    judgeSessionId: '2a61a1d3-62fe-4ba1-b2ac-83e1db1886cb',
    expectedCount: 9
  },
  {
    block: 3,
    argument: 'block-3',
    commit: '516f639fb639712c00bc1c5ea56c245b1e0b759a',
    tree: 'a1fa5de9e9cf26b23114c277e03bf166a4971dec',
    scoresTree: 'bebeb517c2b822617e266b2255297909f470222b',
    judgeSessionId: '9648435b-5b13-4dad-a703-f1f6aeccd11b',
    expectedCount: 7
  },
  {
    block: 4,
    argument: 'block-4',
    commit: '1ebaba7375af2c9ca7943aee84e48b47c361fc7d',
    tree: 'beac6bfcf968e94caa6f80847fd3c70f4bca1cff',
    scoresTree: '9ef64c7ed0d104a3a6581aa97062a9bae77aa381',
    judgeSessionId: '312c3232-6246-43a8-bb1e-d27876a67011',
    expectedCount: 7
  },
  {
    block: 5,
    argument: 'block-5',
    commit: '3629acae10aee7506e32e4aa88928f7dcfb8646c',
    tree: '5bdcce79d41e121a7ee18aff092f4dacd497fd47',
    scoresTree: '27e05d2001caaac131ef7ad08c2bbbb0cfb1fc84',
    judgeSessionId: '61f2a399-901b-4496-b426-fada12803468',
    expectedCount: 8
  },
  {
    block: 6,
    argument: 'block-6',
    commit: 'af792a087dac6d3d994c442e57e78ccc3cd322ea',
    tree: 'f02009149c68e48f9f53a48f223eb082f9d10eea',
    scoresTree: '1cff39bd37f5be742de1c78222bf0dcb7d92b3ac',
    judgeSessionId: '088841aa-27bd-4eb8-a807-f065867c5c50',
    expectedCount: 9
  }
];

function gitBuffer(repository, ...gitArgs) {
  return execFileSync('git', ['-C', repository, ...gitArgs], {
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function gitText(repository, ...gitArgs) {
  return gitBuffer(repository, ...gitArgs).toString('utf8').trim();
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !equalSets(new Set(Object.keys(value)), new Set(expected))) {
    throw new Error(`${label} keys do not match the frozen shape.`);
  }
}

function assertHash(value, length, label) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`${label} must be a lowercase ${length}-character hexadecimal hash.`);
  }
}

function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}

function normalizedScores(source, blindId) {
  const nested = source.scores && typeof source.scores === 'object';
  assertExactKeys(
    source,
    nested
      ? ['blindId', 'scores', 'overall', 'rationale']
      : ['blindId', ...dimensions, 'overall', 'rationale'],
    `${blindId} source score`
  );
  const container = nested ? source.scores : source;
  if (nested) {
    assertExactKeys(container, dimensions, `${blindId} source dimensions`);
  }
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

const runtime = readJson(path.join(dataRoot, 'design', 'assignments-runtime.json'));
const judgeUsage = readJson(path.join(dataRoot, 'results', 'judge-usage.json'));
const outputDirectory = path.join(dataRoot, 'judgments');
const sourceDirectory = path.join(outputDirectory, 'source');
const sourceManifestPath = path.join(sourceDirectory, 'manifest.json');

function authenticatedJudgeUsage(source) {
  const matches = judgeUsage.sessions.filter((session) => (
    session.judgeBlock === source.block &&
    session.judgeSessionId === source.judgeSessionId
  ));
  const usage = matches[0];
  if (matches.length !== 1 ||
      usage.models.length !== 1 ||
      usage.models[0] !== 'gpt-5.6-sol') {
    throw new Error(`Block ${source.block} judge model is not authenticated as gpt-5.6-sol.`);
  }
  return usage;
}

function vendorSources() {
  if (sources.some((source) => !args[source.argument])) {
    console.error('Vendoring requires --block-1 DIR through --block-6 DIR.');
    process.exit(2);
  }

  const blocks = sources.map((source) => {
    const repository = path.resolve(args[source.argument]);
    const resolvedCommit = gitText(repository, 'rev-parse', `${source.commit}^{commit}`);
    if (resolvedCommit !== source.commit) {
      throw new Error(`Block ${source.block} resolved to ${resolvedCommit}, expected ${source.commit}.`);
    }
    const commitTree = gitText(repository, 'rev-parse', `${source.commit}^{tree}`);
    const scoresTree = gitText(repository, 'rev-parse', `${source.commit}:scores`);
    if (commitTree !== source.tree || scoresTree !== source.scoresTree) {
      throw new Error(`Block ${source.block} source tree does not match frozen provenance.`);
    }
    const runtimeBlock = runtime.blocks.find((block) => block.block === source.block);
    if (!runtimeBlock) {
      throw new Error(`Runtime assignment block ${source.block} is missing.`);
    }
    authenticatedJudgeUsage(source);

    const expectedBlindIds = new Set(runtimeBlock.artifacts.map((artifact) => artifact.blindId));
    const scoreFiles = gitText(repository, 'ls-tree', '--name-only', `${source.commit}:scores`)
      .split(/\r?\n/)
      .filter(Boolean);
    const actualBlindIds = new Set(scoreFiles
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.basename(file, '.json')));
    if (!equalSets(expectedBlindIds, actualBlindIds)) {
      throw new Error(`Block ${source.block} committed scores do not match runtime assignments.`);
    }
    if (scoreFiles.length !== source.expectedCount ||
        expectedBlindIds.size !== source.expectedCount) {
      throw new Error(`Block ${source.block} score count does not match frozen provenance.`);
    }

    const blockDirectory = path.join(sourceDirectory, `block-${source.block}`);
    fs.rmSync(blockDirectory, { recursive: true, force: true });
    fs.mkdirSync(blockDirectory, { recursive: true });
    const files = [...expectedBlindIds].sort().map((blindId) => {
      const repositoryPath = `scores/${blindId}.json`;
      const bytes = gitBuffer(repository, 'show', `${source.commit}:${repositoryPath}`);
      const blobSha1 = gitText(repository, 'rev-parse', `${source.commit}:${repositoryPath}`);
      if (gitBlobSha1(bytes) !== blobSha1) {
        throw new Error(`${blindId} Git blob bytes do not match the committed object ID.`);
      }
      const relativePath = `block-${source.block}/${blindId}.json`;
      fs.writeFileSync(path.join(sourceDirectory, relativePath), bytes);
      return {
        blindId,
        path: relativePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
        gitBlobSha1: blobSha1
      };
    });
    return {
      judgeBlock: source.block,
      internalJudgeSessionId: source.judgeSessionId,
      authenticatedJudgeModel: 'gpt-5.6-sol',
      judgeModelEvidence: {
        path: '../../results/judge-usage.json',
        judgeBlock: source.block,
        judgeSessionId: source.judgeSessionId
      },
      sourceCommitSha: source.commit,
      sourceCommitTreeSha: commitTree,
      sourceScoresTreeSha: scoresTree,
      sourceRepresentation: 'exact_git_blob_bytes',
      expectedCount: files.length,
      files
    };
  });

  const manifest = {
    protocolId: runtime.protocolId,
    manifestVersion: 2,
    description: 'Exact score blobs from the six frozen local judge commits.',
    canonicalization: {
      manifest: manifestCanonicalization,
      sourceScores: sourceCanonicalization
    },
    totalScoreCount: blocks.reduce((sum, block) => sum + block.expectedCount, 0),
    blocks
  };
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(sourceManifestPath, canonicalJson(manifest), 'utf8');
  console.log(`VENDORED: 49 source scores; manifest sha256 ${sha256(canonicalJson(manifest))}`);
}

if (args['vendor-sources']) {
  vendorSources();
}

if (!fs.existsSync(sourceManifestPath)) {
  throw new Error('Vendored source manifest is missing.');
}
const sourceManifestBytes = fs.readFileSync(sourceManifestPath);
if (sha256(sourceManifestBytes) !== expectedSourceManifestSha256) {
  throw new Error('Vendored source manifest hash does not match the importer pin.');
}
const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
if (canonicalJson(sourceManifest) !== sourceManifestBytes.toString('utf8')) {
  throw new Error('Vendored source manifest must use canonical JSON formatting.');
}
assertExactKeys(
  sourceManifest,
  ['protocolId', 'manifestVersion', 'description', 'canonicalization', 'totalScoreCount', 'blocks'],
  'Vendored source manifest'
);
if (sourceManifest.protocolId !== runtime.protocolId ||
    sourceManifest.manifestVersion !== 2 ||
    sourceManifest.description !== 'Exact score blobs from the six frozen local judge commits.' ||
    sourceManifest.canonicalization?.manifest !== manifestCanonicalization ||
    sourceManifest.canonicalization?.sourceScores !== sourceCanonicalization ||
    sourceManifest.totalScoreCount !== 49 ||
    !Array.isArray(sourceManifest.blocks) ||
    sourceManifest.blocks.length !== sources.length ||
    new Set(sourceManifest.blocks.map((block) => block.judgeBlock)).size !== sources.length) {
  throw new Error('Vendored source manifest header does not match frozen provenance.');
}
const expectedSourcePaths = new Set(sourceManifest.blocks.flatMap((block) => (
  block.files.map((file) => file.path)
)));
const actualSourcePaths = new Set(walkFiles(sourceDirectory)
  .filter((file) => file !== sourceManifestPath)
  .map((file) => path.relative(sourceDirectory, file).split(path.sep).join('/')));
if (!equalSets(expectedSourcePaths, actualSourcePaths)) {
  throw new Error('Vendored source directory does not exactly match the pinned manifest.');
}

const generated = new Map();
for (const source of sources) {
  const runtimeBlock = runtime.blocks.find((block) => block.block === source.block);
  const manifestBlock = sourceManifest.blocks.find((block) => block.judgeBlock === source.block);
  authenticatedJudgeUsage(source);
  if (!runtimeBlock || !manifestBlock ||
      manifestBlock.internalJudgeSessionId !== source.judgeSessionId ||
      manifestBlock.authenticatedJudgeModel !== runtimeBlock.judgeModel ||
      manifestBlock.judgeModelEvidence.path !== '../../results/judge-usage.json' ||
      manifestBlock.judgeModelEvidence.judgeBlock !== source.block ||
      manifestBlock.judgeModelEvidence.judgeSessionId !== source.judgeSessionId ||
      manifestBlock.sourceCommitSha !== source.commit ||
      manifestBlock.sourceCommitTreeSha !== source.tree ||
      manifestBlock.sourceScoresTreeSha !== source.scoresTree ||
      manifestBlock.sourceRepresentation !== 'exact_git_blob_bytes') {
    throw new Error(`Block ${source.block} source provenance does not match frozen expectations.`);
  }

  const expectedBlindIds = new Set(runtimeBlock.artifacts.map((artifact) => artifact.blindId));
  const manifestBlindIds = new Set(manifestBlock.files.map((file) => file.blindId));
  if (manifestBlock.expectedCount !== source.expectedCount ||
      manifestBlock.expectedCount !== runtimeBlock.artifacts.length ||
      manifestBlock.files.length !== runtimeBlock.artifacts.length ||
      !equalSets(expectedBlindIds, manifestBlindIds)) {
    throw new Error(`Block ${source.block} vendored scores do not match runtime assignments.`);
  }

  for (const assignment of runtimeBlock.artifacts) {
    const blindId = assignment.blindId;
    const file = manifestBlock.files.find((candidate) => candidate.blindId === blindId);
    const expectedRelativePath = `block-${source.block}/${blindId}.json`;
    if (file.path !== expectedRelativePath) {
      throw new Error(`${blindId} vendored source path does not match its frozen block and ID.`);
    }
    assertHash(file.sha256, 64, `${blindId} source SHA-256`);
    assertHash(file.gitBlobSha1, 40, `${blindId} Git blob SHA-1`);
    const sourcePath = resolveContainedPath(sourceDirectory, file.path, `${blindId} vendored source path`);
    const bytes = fs.readFileSync(sourcePath);
    if (bytes.length !== file.bytes ||
        sha256(bytes) !== file.sha256 ||
        gitBlobSha1(bytes) !== file.gitBlobSha1) {
      throw new Error(`${blindId} vendored source bytes do not match the pinned manifest.`);
    }
    const score = JSON.parse(bytes.toString('utf8'));
    if (score.blindId !== blindId) {
      throw new Error(`${blindId} score payload identifies ${score.blindId}.`);
    }
    const binding = readJson(path.join(dataRoot, 'artifacts', 'blind', `${blindId}.binding.json`));
    assertExactKeys(binding, ['protocolId', ...runtime.runtimeBindingKeys], `${blindId} binding`);
    for (const key of ['blindId', 'scheduleId']) {
      if (binding[key] !== assignment[key]) {
        throw new Error(`${blindId} binding ${key} does not match its runtime assignment.`);
      }
    }
    if (binding.protocolId !== runtime.protocolId ||
        binding.judgeBlock !== source.block ||
        binding.blindBundlePath !== `blind/${blindId}.bundle.json`) {
      throw new Error(`${blindId} binding identity does not match source block and protocol.`);
    }
    assertHash(binding.sourceArtifactBundleSha256, 64, `${blindId} source artifact SHA-256`);
    assertHash(binding.blindBundleSha256, 64, `${blindId} blind bundle SHA-256`);
    const sourceArtifactPath = path.join(dataRoot, 'artifacts', `${binding.runId}.bundle.json`);
    const blindBundlePath = resolveContainedPath(
      path.join(dataRoot, 'artifacts'),
      binding.blindBundlePath,
      `${blindId} blind bundle path`
    );
    if (!fs.existsSync(sourceArtifactPath) ||
        sha256(fs.readFileSync(sourceArtifactPath)) !== binding.sourceArtifactBundleSha256 ||
        !fs.existsSync(blindBundlePath) ||
        sha256(fs.readFileSync(blindBundlePath)) !== binding.blindBundleSha256) {
      throw new Error(`${blindId} binding hashes do not authenticate source and blind bundle bytes.`);
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
      throw new Error(`Generated judgment is stale: ${path.relative(dataRoot, outputPath)}`);
    }
  } else {
    fs.writeFileSync(outputPath, bytes, 'utf8');
  }
}

const unexpected = fs.readdirSync(outputDirectory)
  .filter((file) => file.endsWith('.judgment.json'))
  .filter((file) => !generated.has(file.replace(/\.judgment\.json$/, '')));
if (unexpected.length > 0) {
  throw new Error(`Unexpected judgment files: ${unexpected.join(', ')}`);
}

console.log(
  `${args.check ? 'PASS' : 'WROTE'}: 49 judgments derived from pinned vendored sources ` +
  `(manifest ${expectedSourceManifestSha256})`
);
