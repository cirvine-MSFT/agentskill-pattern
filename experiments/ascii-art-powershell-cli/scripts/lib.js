'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const protocolId = 'ascii-art-powershell-cli-v1';
const parentModel = 'gpt-5.6-sol';
const specialistModel = 'claude-haiku-4.5';
const judgeModel = 'gpt-5.6-sol';
const conditionInstructions = Object.freeze({
  control: 'Complete the task yourself. Do not create or use nested sessions. Inspect and edit the fixture, create the required banner asset, and run repository-owned tests.',
  treatment: 'Complete the implementation and testing yourself. Delegate only creation of the required banner asset to one fresh nested session using model `claude-haiku-4.5`; instruct it to write that one asset directly into the workspace. Do not delegate code, tests, inspection, integration, or any other work. Wait for the nested session and then inspect/integrate its asset.'
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(file) {
  const data = fs.readFileSync(file);
  const textExtensions = new Set(['.json', '.js', '.md', '.ps1', '.psm1', '.txt', '.gitattributes']);
  if (!textExtensions.has(path.extname(file).toLowerCase()) && path.basename(file) !== '.gitattributes') {
    return sha256(data);
  }
  return sha256(Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  return entries.flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function parseArguments(argv) {
  const parsed = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      parsed.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
      parsed[name] = argv[index + 1];
      index += 1;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}

function compareOrWrite(file, value, check) {
  const generated = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== generated) {
      throw new Error(`Generated file is stale: ${path.relative(root, file)}`);
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, 'utf8');
  }
}

module.exports = {
  compareOrWrite,
  conditionInstructions,
  judgeModel,
  mulberry32,
  parentModel,
  parseArguments,
  protocolId,
  readJson,
  root,
  sha256,
  sha256File,
  shuffle,
  specialistModel,
  walkFiles,
  writeJson
};
