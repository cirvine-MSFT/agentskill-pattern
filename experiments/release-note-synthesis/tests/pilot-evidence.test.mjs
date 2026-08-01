import assert from "node:assert/strict";
import test from "node:test";
import { deriveRunEvidence } from "../scripts/pilot-evidence.mjs";

test("run evidence fails closed when Skill, delegation, audit, draft, or usage is missing", () => {
  const evidence = deriveRunEvidence({
    run: {
      runId: "PILOT-A4-01",
      dossierId: "pilot-feature-repo-delete",
      sessionId: "00000000-0000-5000-8000-000000000000",
      taskEnvelopeSha256: "1".repeat(64),
    },
    events: [],
    rawBytes: Buffer.alloc(0),
    usageRows: [],
    auditPath: "missing-audit",
    draftPath: "missing-draft",
    processResult: { status: 1, signal: null },
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:01.000Z",
    configuredToolSchemas: [],
  });
  assert.equal(evidence.disposition, "measured-failure");
  assert.equal(evidence.operationalSuccess, false);
  assert.equal(evidence.treatmentAdherent, false);
  assert.equal(evidence.failureReasons.length > 5, true);
});
