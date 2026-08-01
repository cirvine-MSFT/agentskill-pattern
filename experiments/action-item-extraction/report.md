# Grounded action-item extraction excluded pilot report

## Disposition

**NO-GO.** `DEV-ACTION-V1-A4-01` was started once on Copilot CLI 1.0.77 and
failed the frozen pre-start gate. The abandonment rule fired. No excluded-pilot,
confirmatory, or main unit started.

The runtime emitted three unknown-tool warnings: `read`, `edit`, and `read`
again in the worker context. The fixed Claude Haiku 4.5 worker was discovered
and delegated, but it could not call `read`. It attempted one `edit` with an
empty ledger, but the edit did not complete successfully and no ledger artifact
was created. The `edit` warning and subsequent `edit` start are contradictory
runtime observations: `--allow-all-tools` grants permission while
`--available-tools` is intended to constrain availability, but this trace does
not establish which registration path left `edit` callable. The effective
minimized file-tool surface was therefore not demonstrated. This is an
operational identifier/runtime-surface failure, not evidence about semantic
quality or the Agent Skill Pattern itself.

## Frozen smoke evidence

| Measure | Observed | Gate |
| --- | ---: | ---: |
| Skill starts | 1 | 1 |
| Delegation starts/completes | 1 / 1 | 1 / 1 |
| Worker model | Claude Haiku 4.5 | Claude Haiku 4.5 |
| Worker transcript reads | 0 | 1 successful |
| Worker ledger edit starts | 1 | 1 successful |
| Parent transcript reads / ledger edits | 0 / 0 | 0 / 0 |
| Unknown-tool warnings | 3 | 0 |
| Schema-valid artifact | No artifact | Required |
| Compact return | Failed | Required |
| Unexpected model actors | 0 | 0 |
| Total model tokens | 32,517 | <=40,000 |
| Wall time | 32,990 ms | <=180,000 ms |
| Tuple F1 | 0.000 (no artifact) | Smoke had no quality floor |

The parent used GPT-5.6 Sol and the worker used Claude Haiku 4.5. The Skill,
task delegation, and custom-agent lifecycle were observed. The parent made no
file calls. The only observed worker file-tool start was `edit`; the transcript
was never read. No forbidden evaluator or prior-output root access was
observed. These are tool-surface and context-minimization observations, not a
security or compliance claim.

## Deterministic floor

The preregistered A0 extractor produced a mean tuple F1 of 0.7665 across the
four excluded transcripts (development 0.7368; Meridian 0.8148; Harbor 0.8000;
Lumen 0.7143). This floor remains descriptive because A4 semantic output was
never produced. All four transcripts and gold-derived scores are now exposed;
none may be reused as hidden confirmatory input.

## Authorization boundary

There is no next experimental authorization. The consumed smoke ID must not be
retried or tuned, and the three reserved pilot IDs must not run. Any future
candidate requires a new protocol and new permanently excluded development ID;
it cannot reinterpret or replace this NO-GO evidence. A successor must verify
the runtime's built-in file-tool identifiers before freezing its gate and must
use new, unexposed inputs.
