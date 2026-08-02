#!/usr/bin/env node
import {readFileSync, rmSync} from "node:fs";
import {resolve} from "node:path";
import {checkLinks} from "./check-links.mjs";
import {createSourceManifest} from "./freeze-design.mjs";
import {experimentRoot, stableStringify} from "./lib.mjs";
import {createSchedule} from "./schedule.mjs";
import {verifyNoRun} from "./verify-no-run.mjs";

function assertBytes(path, expected) {
  const actual = readFileSync(path, "utf8");
  if (actual !== stableStringify(expected)) throw new Error(`Frozen bytes differ: ${path}`);
}

assertBytes(resolve(experimentRoot, "design", "schedule.json"), createSchedule());
assertBytes(resolve(experimentRoot, "design", "source-manifest.json"), createSourceManifest());
verifyNoRun();
checkLinks();

for (const transient of [".docs-eval-0.mjs", ".docs-eval-1.mjs"]) {
  rmSync(resolve(experimentRoot, transient), {force: true});
}

process.stdout.write("Reproduction verified: schedule, hashes, bundles, links, and no-run boundary\n");
