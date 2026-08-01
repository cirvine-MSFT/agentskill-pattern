import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateFinalReport } from "../../scripts/generate-v5-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("protocol-v5 final report is deterministic and derived from the canonical package", () => {
  const first = generateFinalReport();
  const second = generateFinalReport();
  assert.ok(first.summaryBytes.equals(second.summaryBytes));
  assert.ok(first.csvBytes.equals(second.csvBytes));
  assert.ok(first.reportBytes.equals(second.reportBytes));
  assert.ok(first.summaryBytes.equals(readFileSync(resolve(
    root,
    "results",
    "v5-final-summary.json"
  ))));
  assert.ok(first.csvBytes.equals(readFileSync(resolve(
    root,
    "results",
    "v5-final-arm-summary.csv"
  ))));
  assert.ok(first.reportBytes.equals(readFileSync(resolve(root, "report.md"))));

  const summary = first.summary;
  assert.equal(summary.generatedFrom.closureSha256,
    "d0d86f7f43b20ef3bd95cdc76929cd74973d77e5c0867acf2e8ca0ebd114433c");
  assert.equal(summary.generatedFrom.packageSha256,
    "613dcf903e59273b9dae27f7d7684609c9c0e6af46af83c75d25e76c188350e3");
  assert.deepEqual(summary.execution, {
    randomizedCompleteBlocks: 12,
    scheduledUnits: 72,
    aiUnits: 60,
    deterministicUnits: 12,
    missingSlots: 0,
    retries: 0,
    protocolDeviations: 0,
    measuredFailures: 39,
    allStartedUnitsIncludedInItt: true
  });
  assert.deepEqual(summary.arms.map((arm) => [
    arm.flow.successfulDisposition,
    arm.flow.treatmentAdherent,
    arm.flow.operationallySuccessful
  ]), [
    [12, 12, 12],
    [10, 10, 12],
    [11, 11, 12],
    [0, 0, 6],
    [0, 1, 10],
    [0, 1, 10]
  ]);
  assert.deepEqual(summary.targetArmDecisionRule.qualityPasses, {
    promotionRate: true,
    pathCoverage: false,
    mutantKillRate: false
  });
  assert.equal(summary.targetArmDecisionRule.positiveEfficiencySignal, false);
  assert.equal(summary.targetArmDecisionRule.secondaryWallTarget.met, false);
  assert.equal(summary.arms[1].endpointStatistics.toolSchemaCount.n, 0);
  assert.deepEqual(
    summary.arms[1].telemetryAvailability.fields.toolSchemas.reasons,
    { "local events do not expose the complete tool schema payload": 12 }
  );

  const totals = summary.allAttemptOperationalUsage.totals;
  assert.equal(totals.aiCredits.value, 1876.5233049999997);
  assert.equal(totals.nanoAiu.value, 1876523305000);
  assert.equal(totals.inputTokens.value, 7057963);
  assert.equal(totals.outputTokens.value, 809569);
  assert.equal(totals.reasoningTokens.value, 39230);
  assert.equal(totals.completionCount.value, 464);
  assert.equal(totals.summedWallMs.value, 7321549);
  const report = first.reportBytes.toString("utf8");
  assert.match(report, /No p-values/u);
  assert.match(report, /causal inference/u);
});
