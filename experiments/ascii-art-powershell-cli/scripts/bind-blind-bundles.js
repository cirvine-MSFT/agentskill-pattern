#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  parseArguments,
  protocolId,
  readJson,
  root,
  sha256File,
  walkFiles,
  writeJson
} = require('./lib');

const args = parseArguments(process.argv.slice(2));
if (!args.runs || !args.artifacts || !args['blind-bundles'] || !args.out) {
  console.error('Usage: bind-blind-bundles.js --runs DIR --artifacts DIR --blind-bundles DIR --out DIR');
  process.exit(2);
}

function jsonValues(directory) {
  return walkFiles(path.resolve(directory))
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map(readJson);
}

const manifests = jsonValues(args.runs).filter((value) => value.sessions && value.refs && value.exclusion);
const artifacts = jsonValues(args.artifacts).filter((value) => value.bundleSha256 && value.files);
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const bundleDirectory = path.resolve(args['blind-bundles']);
const outputDirectory = path.resolve(args.out);
const bundleFiles = walkFiles(bundleDirectory).filter((file) => !file.endsWith('.binding.json'));

for (const block of assignments.blocks) {
  for (const assignment of block.artifacts) {
    const selected = manifests.filter((manifest) => (
      manifest.scheduleId === assignment.scheduleId && !manifest.exclusion.excluded
    ));
    if (selected.length !== 1) {
      throw new Error(`${assignment.blindId} requires exactly one selected run for ${assignment.scheduleId}.`);
    }
    const artifact = artifacts.filter((item) => item.runId === selected[0].runId);
    if (artifact.length !== 1 || artifact[0].bundleSha256 !== selected[0].refs.artifactBundleSha256) {
      throw new Error(`${assignment.blindId} source artifact does not match selected run ${selected[0].runId}.`);
    }
    const candidates = bundleFiles.filter((file) => path.basename(file).startsWith(`${assignment.blindId}.`));
    if (candidates.length !== 1) {
      throw new Error(`${assignment.blindId} requires exactly one blind bundle file named ${assignment.blindId}.*.`);
    }
    writeJson(path.join(outputDirectory, `${assignment.blindId}.binding.json`), {
      protocolId,
      blindId: assignment.blindId,
      judgeBlock: block.block,
      scheduleId: assignment.scheduleId,
      runId: selected[0].runId,
      sourceArtifactBundleSha256: artifact[0].bundleSha256,
      blindBundleSha256: sha256File(candidates[0])
    });
  }
}

console.log(`WROTE: 66 bound blind bundle assignments to ${outputDirectory}`);
