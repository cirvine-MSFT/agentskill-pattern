import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimentRoot } from "../scripts/lib.mjs";
import { validateFoundation } from "../scripts/validate-foundation.mjs";

test("frozen v2 foundation validates without live execution", () => {
  assert.deepEqual(validateFoundation(), { transcripts: 4, goldItems: 48, candidateFiles: 2 });
});

test("candidate worker frontmatter remains exactly read/edit", () => {
  const agent = readFileSync(resolve(experimentRoot, "candidate", ".github", "agents", "action-ledger-v2-haiku.agent.md"), "utf8");
  assert.match(agent, /^tools: \["read", "edit"\]$/mu);
  assert.doesNotMatch(agent, /^tools:.*(?:task|view|shell|search|mcp)/imu);
});

test("tests never invoke live execution and runner requires explicit execute", () => {
  const packageJson = JSON.parse(readFileSync(resolve(experimentRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.pilot, "node scripts/run-excluded-pilot.mjs");
  const runner = readFileSync(resolve(experimentRoot, "scripts", "run-excluded-pilot.mjs"), "utf8");
  assert.match(runner, /process\.argv\.includes\("--execute"\)/u);
  assert.doesNotMatch(packageJson.scripts.test, /pilot|copilot|--execute/u);
});
