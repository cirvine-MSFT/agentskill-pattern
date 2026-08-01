import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectToolEvents,
  schemaEvidence,
  warningEvidence,
} from "../scripts/run-excluded-pilot.mjs";
import { parseJsonl } from "../scripts/lib.mjs";

const worker = "worker-agent-v2";
const events = [
  { type: "debug", data: { message: "Tools: task view edit" } },
  { type: "warning", data: { message: 'Unknown tool name in the tool allowlist: "edit"' } },
  { type: "subagent.started", agentId: worker, data: { agentName: "action-ledger-v2-haiku", model: "claude-haiku-4.5" } },
  { type: "debug", agentId: worker, data: { message: "Tools: view(path) builtin edit(path, old_str, new_str)" } },
  { type: "tool.execution_start", agentId: worker, data: { toolName: "view", toolCallId: "v1", arguments: { path: "input.txt" } } },
  { type: "tool.execution_complete", agentId: worker, data: { toolName: "view", toolCallId: "v1", success: true } },
  { type: "tool.execution_start", agentId: worker, data: { toolName: "edit", toolCallId: "e1", arguments: { path: "ledger.json" } } },
  { type: "tool.execution_complete", agentId: worker, data: { toolName: "edit", toolCallId: "e1", success: true } },
];

test("JSON output is parsed as JSONL event objects", () => {
  const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal(parseJsonl(bytes).length, events.length);
});

test("worker agentId and successful tool completions are matched exactly", () => {
  assert.deepEqual(inspectToolEvents(events), {
    workerAgentId: worker,
    workerViews: 1,
    workerEdits: 1,
    successfulWorkerViews: 1,
    successfulWorkerEdits: 1,
    parentFileCalls: 0,
  });

  test("a missing toolCallId never matches an unrelated successful completion", () => {
    const malformed = [
      { type: "subagent.started", agentId: worker },
      { type: "tool.execution_start", agentId: worker, data: { toolName: "view", arguments: { path: "input.txt" } } },
      { type: "tool.execution_complete", agentId: worker, data: { toolName: "task", success: true } },
    ];
    assert.equal(inspectToolEvents(malformed).successfulWorkerViews, 0);
  });
});

test("only exact parent edit warning is accepted with proven worker schema/edit", () => {
  const schemas = schemaEvidence(events, "", worker);
  const warnings = warningEvidence(events, "", 2, worker, schemas, true);
  assert.equal(schemas.parentCaptured, true);
  assert.equal(schemas.workerContainsStructuredView, true);
  assert.equal(schemas.workerContainsBuiltinEdit, true);
  assert.equal(schemas.distinctParentAndWorkerBlocks, true);
  assert.equal(warnings.accepted.length, 1);
  assert.equal(warnings.rejected.length, 0);
  const readWarning = [...events];
  readWarning[1] = { type: "warning", data: { message: 'Unknown tool name in the tool allowlist: "read"' } };
  assert.equal(warningEvidence(readWarning, "", 2, worker, schemas, true).rejected.length, 1);
});

test("stderr warning requires proof it precedes the worker registry", () => {
  const stderr = [
    'Unknown tool name in the tool allowlist: "edit"',
    `${worker} action-ledger-v2-haiku Tools: view(path) builtin edit(path, old_str, new_str)`,
  ].join("\n");
  const schemas = schemaEvidence(events.filter((event) => event.type !== "debug"), stderr, worker);
  const warnings = warningEvidence([], stderr, 0, worker, schemas, true);
  assert.equal(warnings.accepted.length, 1);
  assert.equal(warnings.rejected.length, 0);
});
