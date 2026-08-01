import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkEvidence } from "../scripts/check-evidence.mjs";
import { reportText } from "../scripts/generate-report.mjs";
import { assertNoRun } from "../scripts/assert-no-run.mjs";
import { summarizeEvidence, summarizeUsage } from "../scripts/evidence.mjs";
import { evidenceRoot, experimentRoot, readJson } from "../scripts/lib.mjs";
import { parseCliVersion } from "../scripts/run-excluded-pilot.mjs";

test("lifecycle evidence matches the current phase", () => {
  if (existsSync(evidenceRoot)) {
    assert.deepEqual(checkEvidence(), { mode: "post-run", disposition: "NO-GO", starts: 3 });
    assert.match(reportText(readJson(resolve(evidenceRoot, "summary.json"))), /Disposition: NO-GO/iu);
  } else {
    assert.deepEqual(assertNoRun(), {
      evidenceRootExists: false,
      runtimeRootExists: false,
      v3AiUnitsStarted: 0,
    });
    assert.match(reportText(), /design frozen; no v3 AI unit started/iu);
  }
});

test("usage must settle before gate evaluation", () => {
  const settled = summarizeUsage([
    { model: "gpt-5.6-sol", input_tokens: 10, output_tokens: 2, reasoning_tokens: 1, duration_ms: 20, finish_reason: "stop" },
    { model: "claude-haiku-4.5", input_tokens: 20, output_tokens: 3, reasoning_tokens: 0, duration_ms: 30, finish_reason: "stop" },
  ]);
  assert.equal(settled.settled, true);
  assert.equal(settled.totalModelTokens, 35);
  assert.equal(summarizeUsage([{ model: "gpt-5.6-sol", input_tokens: 1, output_tokens: 1, duration_ms: 1, finish_reason: null }]).settled, false);
});

test("runner freezes durable start index before any unit map", () => {
  const runner = readFileSync(resolve(experimentRoot, "scripts", "run-excluded-pilot.mjs"), "utf8");
  const startIndexWrite = runner.indexOf('writeOnce(resolve(evidenceRoot, "start-index.json")');
  const runMap = runner.indexOf("runs.map((run) => executeRun");
  assert.ok(startIndexWrite > 0 && runMap > startIndexWrite);
  assert.match(runner, /intentToTreat: true/u);
  assert.match(runner, /retries are forbidden/u);
});

test("incomplete evidence can never recompute to GO", () => {
  const summary = summarizeEvidence([]);
  assert.equal(summary.disposition, "NO-GO");
  assert.equal(summary.starts, 0);
  assert.equal(summary.sourceGrounding100Percent, false);
});

test("CLI 1.0.77 banner is parsed exactly", () => {
  assert.equal(parseCliVersion("GitHub Copilot CLI 1.0.77.\nRun 'copilot update' to check for updates."), "1.0.77");
  assert.equal(parseCliVersion("1.0.77"), "1.0.77");
  assert.equal(parseCliVersion("GitHub Copilot CLI 1.0.78."), "1.0.78");
});
