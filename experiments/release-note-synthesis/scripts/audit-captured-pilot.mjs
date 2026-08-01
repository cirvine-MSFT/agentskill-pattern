#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReturnAndLeakage, parseEvents } from "./pilot-evidence.mjs";
import {
  jsonBytes,
  readJson,
  repositoryRoot,
  root,
  sha256,
} from "./lib.mjs";

const evidenceRoot = resolve(root, "results", "excluded-pilot");

export function auditCapturedRun(capture) {
  const runRoot = resolve(evidenceRoot, "runs", capture.runId);
  const rawBytes = readFileSync(resolve(runRoot, "copilot-events.jsonl"));
  const events = parseEvents(rawBytes);
  const dossier = readJson(
    resolve(root, "fixtures", "dossiers", "excluded-pilot", `${capture.dossierId}.json`),
  );
  const forbiddenFactIds = readJson(resolve(root, "fixtures", "manifest.json")).evaluatorGold
    .flatMap((entry) => readJson(resolve(root, entry.path)).facts.map((fact) => fact.id));
  const returnAndLeakage = analyzeReturnAndLeakage({
    events,
    run: capture,
    expectedEnvelope: null,
    allowedUrls: dossier.sources.map((source) => source.publicUrl),
    forbiddenFactIds,
  });
  const projectSkillEvents = events.filter((event) =>
    event.type === "session.skills_loaded"
    && event.data?.skills?.some((skill) =>
      skill.name === "release-note-synthesis"
      && typeof skill.path === "string"
      && resolve(skill.path).startsWith(repositoryRoot)));
  return {
    formatVersion: 1,
    protocolId: "release-note-synthesis-v0-foundation",
    phase: "excluded-pilot",
    runId: capture.runId,
    derivedAfterPilot: true,
    derivation: "deterministic review addendum; original raw events and run-evidence remain unchanged",
    rawEventsSha256: sha256(rawBytes),
    returnBoundary: returnAndLeakage,
    runtimeIsolation: {
      established: false,
      projectSkillLoadedFromRepositoryWorkspace: projectSkillEvents.length > 0,
      evaluatorRootAbsentFromWorkspace: false,
      reason: "captured run used the repository workspace containing evaluator/gold and prior outputs",
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = readJson(resolve(evidenceRoot, "start-index.json"));
  for (const capture of index.captures) {
    writeFileSync(
      resolve(evidenceRoot, "runs", capture.runId, "review-addendum.json"),
      jsonBytes(auditCapturedRun(capture)),
    );
  }
  process.stdout.write(`Audited ${index.captures.length} preserved pilot event streams without rerunning them\n`);
}
