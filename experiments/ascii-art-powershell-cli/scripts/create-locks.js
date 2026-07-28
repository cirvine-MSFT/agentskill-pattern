#!/usr/bin/env node
'use strict';

const path = require('path');
const { compareOrWrite, parseArguments, root, sha256File, walkFiles } = require('./lib');

const args = parseArguments(process.argv.slice(2));

function createLock(directoryName, outputName) {
  const directory = path.join(root, directoryName);
  const output = path.join(directory, outputName);
  const files = walkFiles(directory)
    .filter((file) => file !== output)
    .map((file) => ({
      path: path.relative(directory, file).split(path.sep).join('/'),
      sha256: sha256File(file)
    }));
  const lock = {
    protocolId: 'ascii-art-powershell-cli-v1',
    algorithm: 'sha256-normalized-lf-v1',
    files
  };
  compareOrWrite(output, lock, Boolean(args.check));
}

createLock('fixture', 'fixture-lock.json');
createLock('acceptance', 'acceptance-lock.json');
console.log(args.check ? 'PASS: fixture and acceptance locks are current' : 'WROTE: fixture and acceptance locks');
