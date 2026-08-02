#!/usr/bin/env node
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, relative, resolve, sep} from "node:path";
import {tmpdir} from "node:os";
import {allFixtureVariants} from "../fixtures/catalog.mjs";
import {materializeFixture} from "./generate-fixture.mjs";
import {
  directoryDigest,
  experimentRoot,
  repositoryRoot,
  sha256,
  stableStringify,
  walkFiles
} from "./lib.mjs";
import {createSchedule} from "./schedule.mjs";

const schedulePath = resolve(experimentRoot, "design", "schedule.json");
const manifestPath = resolve(experimentRoot, "design", "source-manifest.json");

const trackedSources = [
  resolve(repositoryRoot, ".github", "skills", "feature-documentation", "SKILL.md"),
  resolve(repositoryRoot, ".github", "agents", "feature-documentation-haiku.agent.md"),
  ...walkFiles(experimentRoot).filter((path) => {
    const name = relative(experimentRoot, path).split(sep).join("/");
    return ![
      "design/source-manifest.json",
      "design/schedule.json"
    ].includes(name);
  })
];

export function createSourceManifest() {
  const temporary = resolve(tmpdir(), `documentation-freeze-${process.pid}`);
  rmSync(temporary, {recursive: true, force: true});
  mkdirSync(temporary, {recursive: true});
  try {
    const bundles = {};
    for (const {fixture, variant, phase} of allFixtureVariants()) {
      const key = `${phase}/${fixture.id}/${variant.id}`;
      const candidate = resolve(temporary, key, "candidate");
      const evaluator = resolve(temporary, key, "evaluator");
      materializeFixture({
        fixtureId: fixture.id,
        variantId: variant.id,
        candidateRoot: candidate,
        evaluatorRoot: evaluator,
        observationId: `FREEZE-${fixture.id}-${variant.id}`
      });
      bundles[key] = {
        candidateSha256: directoryDigest(candidate),
        evaluatorSha256: directoryDigest(evaluator)
      };
    }
    const sources = {};
    for (const path of [...new Set(trackedSources)].sort()) {
      const relativePath = relative(repositoryRoot, path).split(sep).join("/");
      sources[relativePath] = sha256(readFileSync(path));
    }
    sources["experiments/documentation-delegation/design/schedule.json"] = sha256(
      readFileSync(schedulePath)
    );
    return {
      protocolId: "feature-documentation-delegation-v1",
      hashAlgorithm: "sha256",
      sources,
      generatedBundles: bundles
    };
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}

export function freezeDesign() {
  mkdirSync(join(experimentRoot, "design"), {recursive: true});
  writeFileSync(schedulePath, stableStringify(createSchedule()));
  writeFileSync(manifestPath, stableStringify(createSourceManifest()));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  freezeDesign();
  process.stdout.write("Frozen schedule and source manifest\n");
}
