# Grounded action-item extraction feasibility result

**Disposition: NO-GO. No confirmatory or main execution is authorized.**

## Iteration history

| Version | Starts | Result |
| --- | ---: | --- |
| v1 | 1 development | Unknown `read`/`edit` runtime tools; no ledger; NO-GO |
| v2 | 1 development | One worker view/edit, valid compact isolated ledger, 12/12 tuple matches, but missing frozen tool-schema evidence and only 1/12 source grounding; NO-GO; zero pilots |
| v3 | 3 excluded pilots | Mechanics mostly worked, but held-out tuple quality, ambiguity handling, grounding, and one budget/mechanism check failed; NO-GO |

V1's failure is an identifier/runtime-surface finding, not semantic evidence. V2's
perfect tuple score does not override its prospective instrumentation rule or weak
grounding. V3 used new inputs and a prospectively corrected rule; it did not relabel or
retry v2.

## Canonical v3 results

| Run | Exact mechanism | Tuple F1 | Grounding | Model tokens | AI credits | Wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `PILOT-ACTION-V3-A4-2F6C` | Yes | 0.385 | 21.43% | 39,274 | 12.035535 | 48.491 s |
| `PILOT-ACTION-V3-A4-71D9` | Yes | 0.231 | 7.14% | 38,375 | 11.266770 | 55.999 s |
| `PILOT-ACTION-V3-A4-C845` | No | 0.769 | 7.14% | 40,815 | 12.212910 | 67.044 s |
| **Mean** | - | **0.462** | failed 100% gate | **39,488** | **11.838405** | **57.178 s** |

Mean credits split into 8.456 parent and 3.383 worker. All three runs used one
successful worker view and edit with zero parent transcript/ledger file calls; schema,
compact return, and candidate isolation passed 3/3. However, two runs produced an
unsupported critical action, source grounding was far below 100%, and one run exceeded
the 40,000-token ceiling and failed the prospective warning rule.

## Interpretation

The mechanics provide evidence that the parent context was isolated from transcript and
ledger file work. They do not establish a comparative context saving because no inline
control ran. External deterministic evaluation found the held-out output quality
insufficient. The supported conclusion is therefore: context mechanics were isolated,
but quality and grounding failed the frozen feasibility gate. No main study followed.
