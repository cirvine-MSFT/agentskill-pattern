# Release-note synthesis feasibility result

**Disposition: NO-GO; abandoned on the tested runtime. Semantic quality was never
tested.**

## v0 excluded pilot

| Measure | Result |
| --- | ---: |
| A4 starts | 3 |
| Operational / adherence success | 0/3 / 0/3 |
| Structured dossier reads / draft writes | 0 / 0 |
| Mean parent / worker AI credits | 8.703 / 0.517 |
| Mean combined AI credits | 9.220 |
| Mean total model tokens | 31,041 |
| Mean wall time | 49.4 s |

The Skill and fixed-Haiku worker lifecycles appeared, but the worker emitted XML-like
pseudo tool calls as assistant text. The MCP audit stopped at service startup, no
structured release-note MCP call occurred, no draft was written, and narration/fabricated
draft content crossed the compact-return boundary. Every run exceeded the 20,000-token
cap. The repository root also remained visible, so evaluator-filesystem isolation was
not established.

## v2 repair

The sole permitted v2 development smoke also failed:

| Measure | Result |
| --- | ---: |
| Run | `DEV-V2-A4-01` |
| Structured MCP calls | 0/2 |
| Model tokens | 26,000 |
| Wall time | 44.95 s |

CLI 1.0.77 rejected the canonical MCP tool names, the Windows MCP sandbox could not
start because the process lacked required DACL permission, an unrelated built-in Skill
remained exposed, and the worker produced a pseudo tool call. No v2 pilot gate was
frozen and no pilot or confirmatory unit ran.

## Interpretation

These are mechanism and infrastructure failures, not negative release-note quality
scores. There was no draft for an external evaluator to assess and no valid inline
control, so comparative context, cost, latency, and quality effects are not estimable.
The exact disposition remains NO-GO: do not reinterpret the probe as a semantic test,
and do not claim that the pattern succeeded or failed at release-note writing.
