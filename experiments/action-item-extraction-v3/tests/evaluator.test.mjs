import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateLedger } from "../evaluator/evaluate.mjs";
import { goldPath, readJson, runs, transcriptPath } from "../scripts/lib.mjs";

const run = runs[0];
const gold = readJson(goldPath(run));
const transcript = readFileSync(transcriptPath(run), "utf8");

function perfectLedger() {
  const ambiguity = gold.expectedOmissions.find((omission) => omission.category === "material-ambiguity");
  return {
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
      sourceCitations: structuredClone(item.sourceCitations),
      criticality: item.criticality,
    })),
    ambiguities: [{
      sourceCitations: structuredClone(ambiguity.sourceCitations),
      note: ambiguity.reason,
    }],
  };
}

test("perfect v3 ledger satisfies tuple and exact citation grounding", () => {
  const score = evaluateLedger({ ledger: perfectLedger(), gold, transcript, run });
  assert.equal(score.tuple.f1, 1);
  assert.equal(score.sourceGrounding.rate, 1);
  assert.equal(score.schema.valid, true);
  assert.equal(score.changeHandling.rescission.rate, 1);
  assert.equal(score.changeHandling.reassignment.rate, 1);
  assert.equal(score.changeHandling.dateChange.rate, 1);
});

test("missing, malformed, and non-supporting citations fail grounding", () => {
  const missing = perfectLedger();
  missing.items[0].sourceCitations = [];
  assert.equal(evaluateLedger({ ledger: missing, gold, transcript, run }).sourceGrounding.rate, 13 / 14);

  const malformed = perfectLedger();
  malformed.items[0].sourceCitations[0] = { ...malformed.items[0].sourceCitations[0], startLineId: "007" };
  const malformedScore = evaluateLedger({ ledger: malformed, gold, transcript, run });
  assert.equal(malformedScore.sourceGrounding.rate, 13 / 14);
  assert.equal(malformedScore.schema.valid, false);

  const unsupported = perfectLedger();
  unsupported.items[0].sourceCitations[0] = gold.expectedItems[1].sourceCitations[0];
  assert.equal(evaluateLedger({ ledger: unsupported, gold, transcript, run }).sourceGrounding.rate, 13 / 14);
});

test("required material ambiguity must be complete and exactly grounded", () => {
  const empty = perfectLedger();
  empty.ambiguities = [];
  const score = evaluateLedger({ ledger: empty, gold, transcript, run });
  assert.equal(score.ambiguity.completeAndExactlyGrounded, false);
  assert.equal(score.sourceGrounding.rate, 13 / 14);
  const invented = perfectLedger();
  invented.ambiguities[0].note = "unrelated explanation with no ownership or deadline meaning";
  assert.equal(evaluateLedger({ ledger: invented, gold, transcript, run }).ambiguity.completeAndExactlyGrounded, false);
});

test("tuple F1 requires all canonical tuple fields", () => {
  const wrongFields = perfectLedger();
  wrongFields.items[0].dueDate = "2099-01-01";
  wrongFields.items[1].status = "blocked";
  wrongFields.items[2].condition = "invented";
  const score = evaluateLedger({ ledger: wrongFields, gold, transcript, run });
  assert.equal(score.tuple.pairedCount, 13);
  assert.equal(score.tuple.matchedCount, 10);
  assert.equal(score.tuple.f1, 10 / 13);
});

test("semantic opposites fail tuple and ambiguity scoring", () => {
  const negated = perfectLedger();
  negated.items[0].action = `do not ${negated.items[0].action}`;
  let score = evaluateLedger({ ledger: negated, gold, transcript, run });
  assert.equal(score.tuple.matchedCount, 12);

  const oppositeCritical = perfectLedger();
  const criticalIndex = oppositeCritical.items.findIndex((item) => item.action.startsWith("complete the launch-blocking"));
  oppositeCritical.items[criticalIndex].action = `do not ${oppositeCritical.items[criticalIndex].action}`;
  score = evaluateLedger({ ledger: oppositeCritical, gold, transcript, run });
  assert.equal(score.unsupportedCriticalActions, 1);

  const inflectedOpposite = perfectLedger();
  const publishCriticalIndex = inflectedOpposite.items.findIndex((item) =>
    item.action === "publish the customer-blocking escalation matrix");
  inflectedOpposite.items[publishCriticalIndex].action = "withholds the customer-blocking escalation matrix";
  score = evaluateLedger({ ledger: inflectedOpposite, gold, transcript, run });
  assert.equal(score.unsupportedCriticalActions, 1);

  const contradictoryAmbiguity = perfectLedger();
  contradictoryAmbiguity.ambiguities[0].note = "speaker claims definite ownership and deadline";
  assert.equal(evaluateLedger({ ledger: contradictoryAmbiguity, gold, transcript, run }).ambiguity.completeAndExactlyGrounded, false);
});

test("fabricated criticality is an unsupported critical action", () => {
  const fabricated = perfectLedger();
  fabricated.items[0].criticality = "critical";
  const score = evaluateLedger({ ledger: fabricated, gold, transcript, run });
  assert.equal(score.unsupportedCriticalActions, 1);
  assert.equal(score.tuple.matchedCount, 12);
});

test("unmatched fabricated normal action fails source grounding", () => {
  const fabricated = perfectLedger();
  fabricated.items.push({
    itemId: "AI-014",
    owner: "Invented Owner",
    action: "invent an unsupported normal action",
    dueDate: null,
    status: "open",
    condition: null,
    sourceCitations: [{ startLineId: "[999]", endLineId: "[999]", quote: "[999] Invented Owner: unsupported" }],
    criticality: "normal",
  });
  const score = evaluateLedger({ ledger: fabricated, gold, transcript, run });
  assert.equal(score.sourceGrounding.rate, 14 / 15);
  assert.ok(Math.abs(score.tuple.f1 - 26 / 27) < Number.EPSILON);
});
