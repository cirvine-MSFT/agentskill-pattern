import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import { goldPath, readJson, runs, transcriptPath } from "../scripts/lib.mjs";

const run = runs[0];
const gold = readJson(goldPath(run));
const transcript = readFileSync(transcriptPath(run), "utf8");

function perfectLedger() {
  return {
    schemaVersion: "action-ledger.v2",
    runId: run.runId,
    transcriptId: run.transcriptId,
    items: gold.expectedItems.map((item, index) => ({
      itemId: `AI-${String(index + 1).padStart(3, "0")}`,
      owner: item.owner,
      action: item.action,
      dueDate: item.dueDate,
      status: item.status,
      condition: item.condition,
      sourceSpans: item.sourceSpans,
      criticality: item.criticality,
    })),
    ambiguities: [],
  };
}

test("perfect v2 ledger scores all deterministic metrics", () => {
  const score = evaluateLedger({ ledger: perfectLedger(), gold, transcript, run });
  assert.equal(score.tuple.f1, 1);
  assert.equal(score.schema.valid, true);
  assert.equal(score.sourceGrounding.rate, 1);
  assert.equal(score.changeHandling.rescission.rate, 1);
  assert.equal(score.changeHandling.reassignment.correct, 1);
  assert.equal(score.changeHandling.dateChange.correct, 1);
});

test("unsupported critical action and duplicate are counted", () => {
  const ledger = perfectLedger();
  const unsupported = {
    itemId: `AI-${String(ledger.items.length + 1).padStart(3, "0")}`,
    owner: "Unassigned Person",
    action: "invent a release blocker",
    dueDate: null,
    status: "open",
    condition: null,
    sourceSpans: [{ startLine: 1, endLine: 1, quote: "Thanks for joining" }],
    criticality: "critical",
  };
  ledger.items.push(unsupported, { ...unsupported, itemId: `AI-${String(ledger.items.length + 2).padStart(3, "0")}` });
  const score = evaluateLedger({ ledger, gold, transcript, run });
  assert.equal(score.unsupportedCriticalActions, 2);
  assert.equal(score.duplicates, 1);
});
