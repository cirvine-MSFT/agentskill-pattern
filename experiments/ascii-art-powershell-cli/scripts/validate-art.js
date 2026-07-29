#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArguments, readJson, root, walkFiles } = require('./lib');

const args = parseArguments(process.argv.slice(2));
if (!args.prompt || !args.workspace) {
  console.error('Usage: validate-art.js --prompt P01 --workspace PATH');
  process.exit(2);
}

const prompt = readJson(path.join(root, 'prompts.json')).find((item) => item.id === args.prompt);
if (!prompt) {
  throw new Error(`Unknown prompt: ${args.prompt}`);
}

const workspace = path.resolve(args.workspace);
const asset = path.join(workspace, ...prompt.banner.path.split('/'));
const failures = [];
if (!fs.existsSync(asset)) {
  failures.push(`missing asset ${prompt.banner.path}`);
} else {
  const bytes = fs.readFileSync(asset);
  if ([...bytes].some((byte) => byte > 0x7f)) {
    failures.push('asset contains non-ASCII bytes');
  }
  const content = bytes.toString('ascii');
  if (content.includes('\r')) {
    failures.push('asset must use LF line endings');
  }
  if (!content.endsWith('\n') || content.endsWith('\n\n')) {
    failures.push('asset must end with exactly one newline');
  }
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  if (lines.length !== prompt.banner.lines) {
    failures.push(`expected ${prompt.banner.lines} lines, found ${lines.length}`);
  }
  const allowed = new RegExp(prompt.banner.allowedPattern);
  lines.forEach((line, index) => {
    if (line.length < prompt.banner.minWidth || line.length > prompt.banner.maxWidth) {
      failures.push(`line ${index + 1} width ${line.length} is outside ${prompt.banner.minWidth}-${prompt.banner.maxWidth}`);
    }
    if (!allowed.test(line)) {
      failures.push(`line ${index + 1} contains a forbidden character`);
    }
    if (/[ \t]$/.test(line)) {
      failures.push(`line ${index + 1} has trailing whitespace`);
    }
  });
  if (!content.includes(prompt.banner.requiredToken)) {
    failures.push(`asset does not contain ${prompt.banner.requiredToken}`);
  }
}

const textAssets = walkFiles(workspace)
  .filter((file) => path.extname(file).toLowerCase() === '.txt')
  .map((file) => path.relative(workspace, file).split(path.sep).join('/'));
if (textAssets.some((file) => file !== prompt.banner.path)) {
  failures.push(`unexpected text assets: ${textAssets.filter((file) => file !== prompt.banner.path).join(', ')}`);
}

const result = {
  protocolId: 'ascii-art-powershell-cli-v1',
  promptId: prompt.id,
  status: failures.length === 0 ? 'pass' : 'fail',
  assertions: failures.length === 0
    ? [{ id: 'art-constraints', status: 'pass', message: 'All deterministic art constraints passed.' }]
    : failures.map((message, index) => ({ id: `art-${index + 1}`, status: 'fail', message }))
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
