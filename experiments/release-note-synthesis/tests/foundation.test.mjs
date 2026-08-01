import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateDraft } from "../evaluator/evaluate.mjs";
import { buildManifest } from "../scripts/freeze-fixtures.mjs";
import { baselineDraft } from "../scripts/run-baseline.mjs";
import { dossierPaths, readJson, root } from "../scripts/lib.mjs";

test("manifest binds all development and excluded-pilot bytes", () => {
  const manifest = buildManifest();
  assert.equal(manifest.dossiers.length, 4);
  assert.equal(manifest.dossiers.filter((entry) => entry.partition === "excluded-pilot").length, 3);
  assert.equal(new Set(manifest.dossiers.map((entry) => entry.sha256)).size, 4);
  assert.equal(manifest.evaluatorGold.length, 4);
});

test("deterministic baseline emits one bounded customer-facing draft per dossier", () => {
  for (const dossierPath of dossierPaths()) {
    const dossier = readJson(dossierPath);
    const draft = baselineDraft(dossier);
    assert.match(draft, /^# /u);
    assert.match(draft, /^## References$/mu);
    assert.equal(draft.split(/\s+/u).length <= dossier.target.maxWords, true);
    for (const source of dossier.sources) assert.match(draft, new RegExp(source.publicUrl));
  }
});

test("evaluator measures facts, unsupported claims, categories, and references deterministically", () => {
  const dossier = readJson(resolve(root, "fixtures", "dossiers", "excluded-pilot", "pilot-feature-repo-delete.json"));
  const inventory = readJson(resolve(root, "evaluator", "gold", `${dossier.dossierId}.json`));
  const draft = Buffer.from([
    "# Delete repositories from GitHub CLI",
    "",
    "## New",
    "",
    "- Use `gh repo delete` to delete a repository.",
    "- It automatically deletes without confirmation.",
    "",
    "## References",
    "",
    "- https://github.com/cli/cli/pull/4451",
  ].join("\n"));
  const result = evaluateDraft({ dossier, inventory, draftBytes: draft }).deterministicScreen;
  assert.equal(result.criticalFactRecall, 1);
  assert.equal(result.categoryCorrect, true);
  assert.equal(result.unsupportedCriticalClaims.length >= 1, true);
  assert.equal(result.references.missing.length, 1);
});

test("a true phrase cannot launder an unsupported compound assertion", () => {
  const dossier = readJson(resolve(root, "fixtures", "dossiers", "excluded-pilot", "pilot-feature-repo-delete.json"));
  const inventory = readJson(resolve(root, "evaluator", "gold", `${dossier.dossierId}.json`));
  const draft = Buffer.from([
    "# Delete repositories from GitHub CLI",
    "",
    "## New",
    "",
    "- gh repo delete grants every caller organization-admin access.",
    "",
    "## References",
    "",
    "- https://github.com/cli/cli/pull/4451",
    "- https://github.com/cli/cli/issues/3625",
  ].join("\n"));
  const result = evaluateDraft({ dossier, inventory, draftBytes: draft }).deterministicScreen;
  assert.equal(result.supportedClaimCount, 0);
  assert.equal(result.unsupportedClaimCount, 1);
  assert.equal(result.factualPrecision, 0);
});

test("worker-readable dossiers contain no evaluator-only labels", () => {
  for (const path of dossierPaths()) {
    const text = readFileSync(path, "utf8").toLowerCase();
    assert.equal(text.includes("supportpatterns"), false);
    assert.equal(text.includes("criticalfact"), false);
    assert.equal(text.includes("evaluator/gold"), false);
  }
});
