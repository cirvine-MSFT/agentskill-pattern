'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256 } = require('./lib');

function git(repo, args, encoding = null) {
  const result = spawnSync('git', [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    '-c',
    'filter.lfs.smudge=cat',
    '-c',
    'filter.lfs.clean=cat',
    '-C',
    repo,
    ...args
  ], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${String(detail).trim()}`);
  }
  return result.stdout;
}

function repositoryFiles(repo, commit) {
  return git(repo, ['ls-tree', '-r', '--name-only', commit], 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
}

function fileAtCommit(repo, commit, file) {
  const objectId = git(repo, ['rev-parse', `${commit}:${file}`], 'utf8').trim();
  return git(repo, ['cat-file', 'blob', objectId]);
}

function materializeGitTree(repo, commit, workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const files = repositoryFiles(repo, commit);
  for (const file of files) {
    const destination = path.join(workspace, ...file.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fileAtCommit(repo, commit, file));
  }
  return files;
}

function assertMaterializedBytes(workspace, expectedFiles) {
  for (const expected of expectedFiles) {
    const actual = fs.readFileSync(path.join(workspace, ...expected.path.split('/')));
    if (!actual.equals(expected.bytes)) {
      throw new Error(`${expected.path} evaluated bytes differ from terminal Git blob bytes`);
    }
    if (sha256(actual) !== expected.sha256) {
      throw new Error(`${expected.path} evaluated byte hash differs from authenticated hash`);
    }
  }
}

module.exports = {
  assertMaterializedBytes,
  fileAtCommit,
  materializeGitTree,
  repositoryFiles
};
