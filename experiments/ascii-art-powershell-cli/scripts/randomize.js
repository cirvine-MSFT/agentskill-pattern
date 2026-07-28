#!/usr/bin/env node
'use strict';

const path = require('path');
const { compareOrWrite, mulberry32, parseArguments, readJson, root, shuffle } = require('./lib');

const args = parseArguments(process.argv.slice(2));
const prompts = readJson(path.join(root, 'prompts.json'));
const seedConfig = readJson(path.join(root, 'design', 'seed.json')).randomization;
const random = mulberry32(seedConfig.seed);
const blocks = [];

for (let repetition = 1; repetition <= 3; repetition += 1) {
  const allocation = shuffle(prompts.map((prompt) => prompt.id), random);
  const firstCondition = new Map(allocation.map((id, index) => [
    id,
    index < 5 ? 'control' : 'treatment'
  ]));

  for (let half = 0; half < 2; half += 1) {
    const blockNumber = ((repetition - 1) * 2) + half + 1;
    const entries = prompts.map((prompt) => {
      const allocated = firstCondition.get(prompt.id);
      const condition = half === 0
        ? allocated
        : (allocated === 'control' ? 'treatment' : 'control');
      return {
        scheduleId: `${prompt.id}-R${repetition}-${condition}`,
        promptId: prompt.id,
        repetition,
        condition
      };
    });
    blocks.push({
      block: blockNumber,
      observations: shuffle(entries, random).map((entry, index) => ({
        ...entry,
        position: index + 1
      }))
    });
  }
}

const output = {
  protocolId: 'ascii-art-powershell-cli-v1',
  seed: seedConfig.seed,
  algorithm: seedConfig.algorithm,
  blockDesign: 'six blocks; each prompt once and each condition five times per block; adjacent block pairs are complementary repetitions',
  blocks
};

compareOrWrite(path.join(root, 'design', 'randomization.json'), output, Boolean(args.check));
console.log(args.check ? 'PASS: randomization is reproducible' : 'WROTE: design/randomization.json');
