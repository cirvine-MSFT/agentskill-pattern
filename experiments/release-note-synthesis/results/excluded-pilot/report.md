# Excluded feasibility pilot

**Frozen disposition: NO-GO.** The frozen feasibility gate failed. Do not tune, retry, relabel, or begin main execution.

These outcomes are permanently excluded from any later confirmation.

| Run | Dossier | Outcome | Total model tokens | Gate failures |
|---|---|---|---:|---|
| PILOT-A4-01 | pilot-feature-repo-delete | measured-failure | 30862 | operational failure; treatment nonadherence; compact return or model-visible leakage boundary violated; runtime evaluator-filesystem isolation not established; read count differs from gate; write count differs from gate; MCP call count differs from gate; total model-token cap violated; unsupported-critical-claim outcome unavailable because no draft was written |
| PILOT-A4-02 | pilot-bugfix-rest-errors | measured-failure | 31109 | operational failure; treatment nonadherence; compact return or model-visible leakage boundary violated; runtime evaluator-filesystem isolation not established; read count differs from gate; write count differs from gate; MCP call count differs from gate; total model-token cap violated; unsupported-critical-claim outcome unavailable because no draft was written |
| PILOT-A4-03 | pilot-mixed-repo-create | measured-failure | 31153 | operational failure; treatment nonadherence; compact return or model-visible leakage boundary violated; runtime evaluator-filesystem isolation not established; read count differs from gate; write count differs from gate; MCP call count differs from gate; total model-token cap violated; unsupported-critical-claim outcome unavailable because no draft was written |

## Gate totals

- Operational success: 0/3
- Treatment adherence: 0/3
- Unsupported critical claims: unavailable because no draft artifact was written
- Protocol/infrastructure ambiguities: 3

## Feasibility diagnosis

The Skill and fixed-Haiku delegation lifecycles were observed in all three runs,
but the worker emitted XML-like pseudo tool calls as assistant text. The runtime
recorded zero release-note MCP calls, each server audit stopped at
`service.started`, and no draft artifact was written. All three runs also exceeded
the frozen 20,000 total-model-token cap. Review also confirmed that worker narration
and fabricated drafts crossed the compact-return boundary, and that the pilot used
the repository workspace rather than an evaluator-inaccessible isolated workspace.
These are observed mechanism/infrastructure failures, not quality misses that may be
tuned away inside the pilot.

## Frozen gate failures

- PILOT-A4-01: operational failure
- PILOT-A4-01: treatment nonadherence
- PILOT-A4-01: compact return or model-visible leakage boundary violated
- PILOT-A4-01: runtime evaluator-filesystem isolation not established
- PILOT-A4-01: read count differs from gate
- PILOT-A4-01: write count differs from gate
- PILOT-A4-01: MCP call count differs from gate
- PILOT-A4-01: total model-token cap violated
- PILOT-A4-01: unsupported-critical-claim outcome unavailable because no draft was written
- PILOT-A4-02: operational failure
- PILOT-A4-02: treatment nonadherence
- PILOT-A4-02: compact return or model-visible leakage boundary violated
- PILOT-A4-02: runtime evaluator-filesystem isolation not established
- PILOT-A4-02: read count differs from gate
- PILOT-A4-02: write count differs from gate
- PILOT-A4-02: MCP call count differs from gate
- PILOT-A4-02: total model-token cap violated
- PILOT-A4-02: unsupported-critical-claim outcome unavailable because no draft was written
- PILOT-A4-03: operational failure
- PILOT-A4-03: treatment nonadherence
- PILOT-A4-03: compact return or model-visible leakage boundary violated
- PILOT-A4-03: runtime evaluator-filesystem isolation not established
- PILOT-A4-03: read count differs from gate
- PILOT-A4-03: write count differs from gate
- PILOT-A4-03: MCP call count differs from gate
- PILOT-A4-03: total model-token cap violated
- PILOT-A4-03: unsupported-critical-claim outcome unavailable because no draft was written
- protocol/infrastructure ambiguities: 3
- operational success 0/3
- adherence success 0/3
- unsupported-critical-claim outcome unavailable for one or more runs

Main runs remain forbidden until a separate merged preregistration freezes the full
confirmatory design named in `design/main-study-reservation.json`.
