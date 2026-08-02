# Grounded action-item extraction feasibility

This line tested whether a GPT-5.6 Sol parent could route a long synthetic meeting
transcript to a fixed Claude Haiku 4.5 worker that read once, wrote one line-grounded
action ledger, and returned compact status without exposing transcript or ledger
content to the parent.

- [`protocol.md`](protocol.md) consolidates the v1-v3 feasibility methodology.
- [`report.md`](report.md) is the canonical result and preserves every NO-GO.
- [`candidate/`](candidate/) retains the latest v3 routing Skill and worker agent.

V1 failed its runtime file-tool surface. V2 executed the intended mechanism and scored
12/12 tuples, but failed its frozen instrumentation gate and grounded only 1/12 items.
V3 then ran three fresh excluded pilots: parent isolation and one-view/one-edit mechanics
mostly worked, but mean tuple F1 was 0.462, 100% grounding failed, and two runs emitted
unsupported critical actions. No valid control or main study exists.

The superseded fixtures, gold, one-shot runners, copied candidate roots, telemetry, and
evidence packages were removed. Original PRs #26-#30 retain their immutable history.
