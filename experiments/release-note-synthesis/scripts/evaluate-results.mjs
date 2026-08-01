#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateFiles } from "../evaluator/evaluate.mjs";
import { dossierPaths, jsonBytes, readJson, root } from "./lib.mjs";

const outputs = [];
for (const dossierPath of dossierPaths()) {
  const dossier = readJson(dossierPath);
  const goldPath = resolve(root, "evaluator", "gold", `${dossier.dossierId}.json`);
  const candidates = [
    ["A0", resolve(root, "results", "baseline", `${dossier.dossierId}.md`)],
    ["A4-pilot", resolve(root, "results", "excluded-pilot", "drafts", `${dossier.dossierId}.md`)],
  ];
  for (const [arm, draftPath] of candidates) {
    if (!existsSync(draftPath)) continue;
    outputs.push({ arm, ...evaluateFiles(dossierPath, goldPath, draftPath) });
  }
}
outputs.sort((left, right) => `${left.dossierId}:${left.arm}`.localeCompare(`${right.dossierId}:${right.arm}`));
const outputRoot = resolve(root, "results", "evaluation");
mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, "deterministic.json"), jsonBytes({
  formatVersion: 1,
  evaluator: "deterministic-screen-v1",
  records: outputs,
}));
process.stdout.write(`Evaluated ${outputs.length} checked drafts\n`);
