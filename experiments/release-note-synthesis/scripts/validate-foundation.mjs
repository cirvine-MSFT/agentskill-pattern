#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildManifest } from "./freeze-fixtures.mjs";
import {
  assert,
  dossierPaths,
  goldPaths,
  readJson,
  root,
} from "./lib.mjs";

const manifest = readJson(resolve(root, "fixtures", "manifest.json"));
assert(
  JSON.stringify(manifest) === JSON.stringify(buildManifest()),
  "fixture manifest differs from current dossier or gold bytes",
);
const dossiers = dossierPaths().map((path) => [path, readJson(path)]);
const gold = new Map(goldPaths().map((path) => [readJson(path).dossierId, [path, readJson(path)]]));
assert(dossiers.length === 4, "foundation requires one development and three excluded-pilot dossiers");
assert(gold.size === dossiers.length, "every dossier requires one evaluator-only inventory");
assert(
  dossiers.filter(([, dossier]) => dossier.partition === "development").length === 1,
  "exactly one development dossier is required",
);
assert(
  dossiers.filter(([, dossier]) => dossier.partition === "excluded-pilot").length === 3,
  "exactly three excluded-pilot dossiers are required",
);

const ids = new Set();
for (const [path, dossier] of dossiers) {
  assert(dossier.formatVersion === 1, `${basename(path)} has unsupported formatVersion`);
  assert(!ids.has(dossier.dossierId), `duplicate dossierId ${dossier.dossierId}`);
  ids.add(dossier.dossierId);
  assert(
    ["development", "excluded-pilot"].includes(dossier.partition),
    `${dossier.dossierId} has invalid partition`,
  );
  assert(
    ["feature", "bug-fix-set", "mixed-breaking"].includes(dossier.category),
    `${dossier.dossierId} has invalid category`,
  );
  assert(Array.isArray(dossier.sources) && dossier.sources.length > 0, "dossier requires sources");
  const serialized = JSON.stringify(dossier).toLowerCase();
  for (const forbidden of ["evaluator/gold", "supportpatterns", "unsupportedcriticalpatterns"]) {
    assert(!serialized.includes(forbidden), `${dossier.dossierId} leaks evaluator content`);
  }
  for (const source of dossier.sources) {
    assert(source.repository === "cli/cli", `${source.sourceId} has unexpected repository`);
    assert(/^https:\/\/github\.com\/cli\/cli\/(?:pull|issues)\/\d+$/u.test(source.publicUrl), "bad source URL");
    assert(typeof source.author === "string" && source.author.length > 0, "source author is required");
  }
  const [goldPath, inventory] = gold.get(dossier.dossierId) ?? [];
  assert(goldPath, `${dossier.dossierId} lacks gold inventory`);
  assert(inventory.expectedCategory === dossier.category, `${dossier.dossierId} category mismatch`);
  assert(Array.isArray(inventory.facts) && inventory.facts.length > 0, "gold facts are required");
  assert(
    inventory.facts.every((fact) => Array.isArray(fact.claimPatterns) && fact.claimPatterns.length > 0),
    `${dossier.dossierId} facts require closed claimPatterns for precision screening`,
  );
  assert(
    inventory.facts.some((fact) => fact.critical),
    `${dossier.dossierId} requires at least one critical fact`,
  );
}

const skill = readFileSync(resolve(root, "..", "..", ".github", "skills", "release-note-synthesis", "SKILL.md"), "utf8");
const agent = readFileSync(resolve(root, "..", "..", ".github", "agents", "release-note-haiku.agent.md"), "utf8");
assert(skill.includes("release-note-haiku"), "Skill must route to fixed specialist");
assert(agent.includes("model: claude-haiku-4.5"), "specialist model is not fixed");
assert(
  !/shell|powershell|bash|search|web_fetch|task|agent\//u.test(
    agent.split("---")[1].split("tools:")[1].split("mcp-servers:")[0],
  ),
  "specialist tool allowlist contains a forbidden general tool",
);

const reservation = readJson(resolve(root, "design", "main-study-reservation.json"));
assert(reservation.executionAuthorized === false, "main execution must remain forbidden");
assert(reservation.dossiersPresent === false, "main dossiers must not be present");
process.stdout.write("Release-note foundation, provenance, leakage separation, and main lock are valid\n");
