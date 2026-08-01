import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimentRoot } from "../scripts/lib.mjs";
import { validateFoundation } from "../scripts/validate-foundation.mjs";

test("frozen v3 design validates without AI execution", () => {
  assert.deepEqual(validateFoundation(), {
    transcripts: 3,
    goldItems: 39,
    candidateFiles: 2,
    aiUnitsStarted: 0,
  });
});

test("worker frontmatter and global runtime surfaces remain exact", () => {
  const agent = readFileSync(resolve(experimentRoot, "candidate", ".github", "agents", "action-ledger-v3-haiku.agent.md"), "utf8");
  const plan = JSON.parse(readFileSync(resolve(experimentRoot, "design", "execution-plan.json"), "utf8"));
  assert.match(agent, /^tools: \["read", "edit"\]$/mu);
  assert.deepEqual(plan.cli.exactGlobalToolFilter, ["task", "view", "edit"]);
  assert.equal(plan.worker.model, "claude-haiku-4.5");
  assert.deepEqual(plan.worker.runtimeToolNamesInOrder, ["view", "edit"]);
});

test("test and reproduce commands cannot invoke the pilot", () => {
  const packageJson = JSON.parse(readFileSync(resolve(experimentRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.pilot, "node scripts/run-excluded-pilot.mjs");
  assert.doesNotMatch(`${packageJson.scripts.test} ${packageJson.scripts.check} ${packageJson.scripts.reproduce}`, /pilot|copilot|--execute/u);
  const runner = readFileSync(resolve(experimentRoot, "scripts", "run-excluded-pilot.mjs"), "utf8");
  assert.match(runner, /process\.argv\.includes\("--execute"\)/u);
});
