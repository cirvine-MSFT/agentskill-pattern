#!/usr/bin/env node
'use strict';

const path = require('path');
const { compareOrWrite, mulberry32, parseArguments, readJson, root, shuffle } = require('./lib');

const args = parseArguments(process.argv.slice(2));
const prompts = readJson(path.join(root, 'prompts.json'));
const schedule = readJson(path.join(root, 'design', 'randomization.json'));
const seedConfig = readJson(path.join(root, 'design', 'seed.json')).judgeAssignments;
const random = mulberry32(seedConfig.seed);
const observations = schedule.blocks.flatMap((block) => block.observations);
const byPrompt = new Map(prompts.map((prompt) => [
  prompt.id,
  observations.filter((entry) => entry.promptId === prompt.id)
]));
const blocks = Array.from({ length: 6 }, (_, index) => ({
  block: index + 1,
  judgeModel: 'gpt-5.6-sol',
  artifacts: []
}));
let blindCounter = 1;

prompts.forEach((prompt, promptIndex) => {
  const promptObservations = byPrompt.get(prompt.id);
  const byCondition = {
    control: shuffle(promptObservations.filter((item) => item.condition === 'control'), random),
    treatment: shuffle(promptObservations.filter((item) => item.condition === 'treatment'), random)
  };

  blocks.forEach((block, blockIndex) => {
    const condition = (promptIndex + blockIndex) % 2 === 0 ? 'control' : 'treatment';
    const observation = byCondition[condition].pop();
    block.artifacts.push({
      blindId: `B${String(blindCounter).padStart(4, '0')}`,
      scheduleId: observation.scheduleId,
      promptId: prompt.id,
      presentationPosition: 0
    });
    blindCounter += 1;
  });
});

const primarySnapshots = blocks.map((block) => [...block.artifacts]);
primarySnapshots.forEach((artifacts, sourceIndex) => {
  const target = blocks[(sourceIndex + 1) % blocks.length];
  const targetPairKeys = new Set(target.artifacts.map((item) => {
    const observation = observations.find((entry) => entry.scheduleId === item.scheduleId);
    return `${observation.promptId}-R${observation.repetition}`;
  }));
  const candidates = artifacts.filter((item) => {
    const observation = observations.find((entry) => entry.scheduleId === item.scheduleId);
    return !targetPairKeys.has(`${observation.promptId}-R${observation.repetition}`);
  });
  const source = candidates[Math.floor(random() * candidates.length)];
  target.artifacts.push({
    blindId: `B${String(blindCounter).padStart(4, '0')}`,
    scheduleId: source.scheduleId,
    promptId: source.promptId,
    duplicateOfBlindId: source.blindId,
    presentationPosition: 0
  });
  blindCounter += 1;
});

blocks.forEach((block) => {
  block.artifacts = shuffle(block.artifacts, random).map((artifact, index) => ({
    ...artifact,
    presentationPosition: index + 1
  }));
});

const output = {
  protocolId: 'ascii-art-powershell-cli-v1',
  seed: seedConfig.seed,
  algorithm: seedConfig.algorithm,
  judgeUsageExcludedFromEfficiency: true,
  runtimeBindingSchema: 'schemas/blind-bundle.schema.json',
  runtimeBindingKeys: ['blindId', 'judgeBlock', 'scheduleId', 'runId', 'sourceArtifactBundleSha256', 'blindBundlePath', 'blindBundleSha256'],
  blocks
};

compareOrWrite(path.join(root, 'design', 'judge-assignments.json'), output, Boolean(args.check));
console.log(args.check ? 'PASS: judge assignments are reproducible' : 'WROTE: design/judge-assignments.json');
