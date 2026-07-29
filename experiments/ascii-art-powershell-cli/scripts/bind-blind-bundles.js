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
  walkFiles,
  writeJson
} = require('./lib');
const { authenticateArtifactBundle, buildBlindContent } = require('./artifact-bundles');

const args = parseArguments(process.argv.slice(2));
if (!args.runs || !args.artifacts || !args.out) {
  console.error('Usage: bind-blind-bundles.js --runs DIR --artifacts DIR --out DIR');
  process.exit(2);
}

function jsonValues(directory) {
  return walkFiles(path.resolve(directory))
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map(readJson);
}

const manifests = jsonValues(args.runs).filter((value) => value.sessions && value.refs && value.exclusion);
const deterministic = jsonValues(args.runs).filter((value) => value.functional && value.art && value.tamperCheck);
const artifacts = jsonValues(args.artifacts).filter((value) => value.bundleSha256 && value.files);
const assignments = readJson(path.join(root, 'design', 'judge-assignments.json'));
const prompts = readJson(path.join(root, 'prompts.json'));
const artifactDirectory = path.resolve(args.artifacts);
const outputDirectory = path.resolve(args.out);

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
    const result = deterministic.filter((item) => item.runId === selected[0].runId);
    const prompt = prompts.find((item) => item.id === selected[0].promptId);
    if (result.length !== 1 || !prompt) {
      throw new Error(`${assignment.blindId} requires one deterministic result and preregistered prompt.`);
    }
    const authenticated = authenticateArtifactBundle(
      artifactDirectory,
      artifact[0],
      selected[0],
      prompt,
      result[0]
    );
    const blindContent = buildBlindContent(assignment.blindId, authenticated.source);
    const blindBytes = canonicalJson(blindContent);
    const blindBundlePath = `${assignment.blindId}.bundle.json`;
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, blindBundlePath), blindBytes, 'utf8');
    writeJson(path.join(outputDirectory, `${assignment.blindId}.binding.json`), {
      protocolId,
      blindId: assignment.blindId,
      judgeBlock: block.block,
      scheduleId: assignment.scheduleId,
      runId: selected[0].runId,
      sourceArtifactBundleSha256: authenticated.actualHash,
      blindBundlePath,
      blindBundleSha256: sha256(Buffer.from(blindBytes, 'utf8'))
    });
  }
}

console.log(`WROTE: 66 bound blind bundle assignments to ${outputDirectory}`);
