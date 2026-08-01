import assert from "node:assert/strict";
import test from "node:test";
import { deriveEvidence } from "../v2/lib.mjs";

test("v2 evidence fails closed when mechanism, surface, isolation, usage, or output is absent", () => {
  const evidence = deriveEvidence({
    run: {
      phase: "development-smoke",
      runId: "DEV-V2-A4-TEST",
      dossierId: "dev-v2-test",
      sessionId: "00000000-0000-5000-8000-000000000000",
    },
    events: [],
    rawBytes: Buffer.alloc(0),
    usageRows: [],
    audit: [],
    attestation: null,
    draftBytes: null,
    processResult: { status: 1, signal: null },
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:01.000Z",
    expectedDossierSha256: "0".repeat(64),
  });
  assert.equal(evidence.operationalSuccess, false);
  assert.equal(evidence.treatmentAdherent, false);
  assert.equal(evidence.disposition, "measured-failure");
  assert.ok(evidence.failureReasons.length >= 10);
});
