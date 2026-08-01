import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLedger } from "../evaluator/evaluate.mjs";

const run = {
  runId: "TEST-A4-01",
  transcriptId: "test-transcript",
  phase: "test",
};
const transcript = [
  "[001] Alex: I will publish the runbook by 2026-01-05.",
  "[002] Alex: The dashboard would be nice.",
].join("\n");
const gold = {
  expectedItems: [{
    owner: "Alex Doe",
    action: "publish the runbook",
    dueDate: "2026-01-05",
    status: "open",
    condition: null,
    sourceSpans: [{ startLine: 1, endLine: 1, quote: "I will publish the runbook by 2026-01-05." }],
    criticality: "normal",
    resolutionTags: ["direct"],
  }],
};

function ledger(items) {
  return {
    schemaVersion: "action-ledger.v1",
    runId: run.runId,
    transcriptId: run.transcriptId,
    items,
    ambiguities: [],
  };
}

test("perfect grounded tuple scores one", () => {
  const score = evaluateLedger({
    run,
    transcript,
    gold,
    ledger: ledger([{
      itemId: "AI-001",
      owner: "Alex Doe",
      action: "publish runbook",
      dueDate: "2026-01-05",
      status: "open",
      condition: null,
      sourceSpans: [{ startLine: 1, endLine: 1, quote: "I will publish the runbook by 2026-01-05." }],
      criticality: "normal",
    }]),
  });
  assert.equal(score.tuple.f1, 1);
  assert.equal(score.schema.valid, true);
  assert.equal(score.sourceGrounding.rate, 1);
});

test("unsupported critical tuple is counted", () => {
  const score = evaluateLedger({
    run,
    transcript,
    gold,
    ledger: ledger([{
      itemId: "AI-001",
      owner: "Nobody",
      action: "ship an unsupported feature",
      dueDate: null,
      status: "open",
      condition: null,
      sourceSpans: [{ startLine: 2, endLine: 2, quote: "The dashboard would be nice." }],
      criticality: "critical",
    }]),
  });
  assert.equal(score.tuple.f1, 0);
  assert.equal(score.unsupportedCriticalActions, 1);
});
