#!/usr/bin/env node
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {relative, resolve, sep} from "node:path";
import {tmpdir} from "node:os";
import {allFixtureVariants} from "../fixtures/catalog.mjs";
import {materializeFixture} from "./generate-fixture.mjs";
import {
  directoryDigest,
  experimentRoot,
  indexBytes,
  protocolId,
  repoRelative,
  repositoryRoot,
  sha256,
  stableStringify,
  walkFiles
} from "./lib.mjs";
import {createSchedule} from "./schedule.mjs";

const schedulePath = resolve(experimentRoot, "design", "schedule.json");
const manifestPath = resolve(experimentRoot, "design", "source-manifest.json");

function sourcePaths() {
  return [
    resolve(repositoryRoot, ".github", "skills", "feature-documentation-sonnet-v2", "SKILL.md"),
    resolve(repositoryRoot, ".github", "agents", "feature-documentation-sonnet-v2.agent.md"),
    ...walkFiles(experimentRoot).filter((path) => {
      const name = relative(experimentRoot, path).split(sep).join("/");
      return name !== "design/source-manifest.json";
    })
  ].sort();
}

export function createSourceManifest() {
  const sources = {};
  for (const path of [...new Set(sourcePaths())]) {
    const name = repoRelative(path);
    const staged = indexBytes(name);
    sources[name] = {
      indexSha256: sha256(staged),
      bytes: staged.length
    };
  }

  const temporary = resolve(tmpdir(), `documentation-v2-freeze-${process.pid}`);
  rmSync(temporary, {recursive: true, force: true});
  mkdirSync(temporary, {recursive: true});
  const generatedBundles = {};
  try {
    for (const {fixture, variant, phase} of allFixtureVariants()) {
      const key = `${phase}/${fixture.id}/${variant.id}`;
      const candidate = resolve(temporary, key, "candidate");
      const evaluator = resolve(temporary, key, "evaluator");
      materializeFixture({
        fixtureId: fixture.id,
        variantId: variant.id,
        candidateRoot: candidate,
        evaluatorRoot: evaluator,
        observationId: `V2-FREEZE-${sha256(key).slice(0, 12)}`
      });
      generatedBundles[key] = {
        candidateSha256: directoryDigest(candidate),
        evaluatorSha256: directoryDigest(evaluator)
      };
    }
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
  return {
    protocolId,
    hashAlgorithm: "sha256",
    indexByteManifest: true,
    sources,
    sourceRootHash: sha256(stableStringify(sources)),
    generatedBundles
  };
}

export function writeSchedule() {
  mkdirSync(resolve(experimentRoot, "design"), {recursive: true});
  writeFileSync(schedulePath, stableStringify(createSchedule()));
}

export function freezeDesign() {
  writeSchedule();
  writeFileSync(manifestPath, stableStringify(createSourceManifest()));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.includes("--schedule-only")) {
    writeSchedule();
    process.stdout.write("Frozen v2 schedule; stage sources before generating the index-byte manifest\n");
  } else {
    freezeDesign();
    process.stdout.write("Frozen v2 schedule and Git-index source manifest\n");
  }
}
