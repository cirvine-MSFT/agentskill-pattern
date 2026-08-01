import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { warningRuleEvidence } from "../scripts/evidence.mjs";
import {
  exactParentWarning,
  goldPath,
  readJson,
  runCandidateRoot,
  runs,
  sentinelText,
} from "../scripts/lib.mjs";

const run = runs[0];
const gold = readJson(goldPath(run));
const worker = "worker-v3";
const ledger = {
  schemaVersion: "action-ledger.v3",
  runId: run.runId,
  transcriptId: run.transcriptId,
  items: gold.expectedItems.map((item, index) => ({
    itemId: `AI-${String(index + 1).padStart(3, "0")}`,
    owner: item.owner,
    action: item.action,
    dueDate: item.dueDate,
    status: item.status,
    condition: item.condition,
    sourceCitations: item.sourceCitations,
    criticality: item.criticality,
  })),
  ambiguities: [],
};
const events = [
  { type: "session.info", data: { infoType: "configuration", message: exactParentWarning } },
  { type: "session.skills_loaded", data: { skills: [{ name: "action-ledger-v3", source: "project" }] } },
  { type: "tool.execution_start", data: { toolName: "task", toolCallId: worker, model: "gpt-5.6-sol" } },
  { type: "subagent.started", agentId: worker, data: { toolCallId: worker, agentName: "action-ledger-v3-haiku", model: "claude-haiku-4.5" } },
  { type: "tool.execution_start", agentId: worker, data: { toolName: "view", toolCallId: "v1", model: "claude-haiku-4.5", parentToolCallId: worker, arguments: { path: resolve(runCandidateRoot(run), "input", "transcript.txt") } } },
  { type: "tool.execution_complete", agentId: worker, data: { toolCallId: "v1", model: "claude-haiku-4.5", parentToolCallId: worker, success: true } },
  { type: "tool.execution_start", agentId: worker, data: { toolName: "edit", toolCallId: "e1", model: "claude-haiku-4.5", parentToolCallId: worker, arguments: { path: resolve(runCandidateRoot(run), "output", "ledger.json"), old_str: sentinelText, new_str: "{}" } } },
  { type: "tool.execution_complete", agentId: worker, data: { toolCallId: "e1", model: "claude-haiku-4.5", parentToolCallId: worker, success: true } },
  { type: "subagent.completed", agentId: worker, data: { toolCallId: worker, model: "claude-haiku-4.5" } },
  { type: "tool.execution_complete", data: { toolCallId: worker, model: "gpt-5.6-sol", success: true } },
];
const usageRows = [
  { model: "gpt-5.6-sol" },
  { model: "claude-haiku-4.5" },
];

test("prospective rule accepts only the exact parent warning with proven calls and artifact", () => {
  const evidence = warningRuleEvidence({
    events,
    stderrText: "",
    ledger,
    sentinelReplaced: true,
    run,
    usageRows,
  });
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.toolsBlocks.informativeOnly, true);
  assert.equal(evidence.toolsBlocks.distinctParentAndWorkerBlocks, false);
});

test("worker warning, missing completion, invalid artifact, and actor mismatch are fatal", () => {
  const workerWarning = [...events, { type: "warning", agentId: worker, data: { message: exactParentWarning } }];
  assert.equal(warningRuleEvidence({ events: workerWarning, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  assert.equal(warningRuleEvidence({ events: events.filter((event) => event.data?.toolCallId !== "e1" || event.type !== "tool.execution_complete"), stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  assert.equal(warningRuleEvidence({ events, stderrText: "", ledger: {}, sentinelReplaced: true, run, usageRows }).fatal, true);
  const actorMismatch = events.map((event) => event.type === "subagent.started"
    ? { ...event, data: { ...event.data, model: "different-model" } }
    : event);
  assert.equal(warningRuleEvidence({ events: actorMismatch, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
});

test("extra delegation, partial view, wrong path, and extra worker are fatal", () => {
  const extraDelegation = [...events, { type: "tool.execution_start", data: { toolName: "task", toolCallId: "t2" } }];
  assert.equal(warningRuleEvidence({ events: extraDelegation, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  const partialView = events.map((event) => event.data?.toolCallId === "v1" && event.type === "tool.execution_start"
    ? { ...event, data: { ...event.data, arguments: { ...event.data.arguments, view_range: [1, 10] } } }
    : event);
  assert.equal(warningRuleEvidence({ events: partialView, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  const wrongPath = events.map((event) => event.data?.toolCallId === "e1" && event.type === "tool.execution_start"
    ? { ...event, data: { ...event.data, arguments: { ...event.data.arguments, path: resolve(runCandidateRoot(run), "output", "other.json") } } }
    : event);
  assert.equal(warningRuleEvidence({ events: wrongPath, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  const extraWorker = [...events, { type: "subagent.started", agentId: "worker-v3-extra", data: { agentName: "action-ledger-v3-haiku", model: "claude-haiku-4.5" } }];
  assert.equal(warningRuleEvidence({ events: extraWorker, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
});

test("out-of-order or misattributed completions and any other warning are fatal", () => {
  const editBeforeViewComplete = [...events];
  const viewCompleteIndex = editBeforeViewComplete.findIndex((event) => event.data?.toolCallId === "v1" && event.type === "tool.execution_complete");
  const [viewComplete] = editBeforeViewComplete.splice(viewCompleteIndex, 1);
  const editStartIndex = editBeforeViewComplete.findIndex((event) => event.data?.toolCallId === "e1" && event.type === "tool.execution_start");
  editBeforeViewComplete.splice(editStartIndex + 1, 0, viewComplete);
  assert.equal(warningRuleEvidence({ events: editBeforeViewComplete, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);

  const wrongActor = events.map((event) => event.data?.toolCallId === "v1" && event.type === "tool.execution_complete"
    ? { ...event, agentId: "different-worker" }
    : event);
  assert.equal(warningRuleEvidence({ events: wrongActor, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);

  const otherWarning = [...events, { type: "warning", data: { message: "Unexpected configuration warning" } }];
  assert.equal(warningRuleEvidence({ events: otherWarning, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  const duplicateAllowedWarning = [...events, { type: "session.info", data: { infoType: "configuration", message: exactParentWarning } }];
  assert.equal(warningRuleEvidence({ events: duplicateAllowedWarning, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
  assert.equal(warningRuleEvidence({ events, stderrText: "WARN network fallback observed", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
});

test("delegation linkage and per-event models are mandatory", () => {
  const unlinked = events.map((event) => event.type === "subagent.started"
    ? { ...event, data: { ...event.data, toolCallId: "different-task" } }
    : event);
  assert.equal(warningRuleEvidence({ events: unlinked, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);

  const wrongParent = events.map((event) => event.data?.toolCallId === "v1" && event.type === "tool.execution_start"
    ? { ...event, data: { ...event.data, parentToolCallId: "different-task" } }
    : event);
  assert.equal(warningRuleEvidence({ events: wrongParent, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);

  const wrongEventModel = events.map((event) => event.data?.toolCallId === "e1" && event.type === "tool.execution_complete"
    ? { ...event, data: { ...event.data, model: "different-model" } }
    : event);
  assert.equal(warningRuleEvidence({ events: wrongEventModel, stderrText: "", ledger, sentinelReplaced: true, run, usageRows }).fatal, true);
});
