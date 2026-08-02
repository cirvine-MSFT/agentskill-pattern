# Semantic corpus protocol-v5 result

**Disposition: the target A5 arm did not meet the preregistered combined positive
signal.** It saved credits and parent context, but lost held-out semantic quality,
reliability, total-token efficiency, and latency.

## Integrity and flow

| Measure | Value |
| --- | ---: |
| Randomized blocks | 12 |
| Total units | 72 |
| AI / deterministic units | 60 / 12 |
| Missing / retries / deviations | 0 / 0 / 0 |
| Started measured failures retained in ITT | 39 |
| Original evidence merge | `58642d097ffab46fe5452380fbe7d8c66a183577` |

The original local evidence was unsigned and supports descriptive point estimates only.
No significance, causal, compliance, or population-generalization claim is made.

## Reliability

| Arm | Strict success | Treatment adherence | Operational success |
| ---: | ---: | ---: | ---: |
| A0 | 12/12 | 12/12 | 12/12 |
| A1 | 10/12 | 10/12 | 12/12 |
| A2 | 11/12 | 11/12 | 12/12 |
| A3 | 0/12 | 0/12 | 6/12 |
| A4 | 0/12 | 1/12 | 10/12 |
| A5 | 0/12 | 1/12 | 10/12 |

Failures remained in the ITT record. A5 had two terminal failures and only one fully
adherent unit; operational artifact production did not imply protocol adherence.

## A5 target contrast

| Outcome | A1 GPT inline | A5 GPT -> Haiku | Change |
| --- | ---: | ---: | ---: |
| Parent / worker AI credits | 43.324 / 0 | 9.251 / 17.256 | split |
| Combined AI credits | 43.324 | 26.507 | -38.8% |
| Parent cumulative input | 76,900 | 32,311 | -58.0% |
| Total model tokens | 85,492 | 160,721 | +88.0% |
| Wall time | 83.54 s | 143.65 s | +72.0% |
| Promotion | 100% | 96.0% | -4.0 pp |
| Path coverage | 97.1% | 75.9% | -21.3 pp |
| Mutant kill | 95.5% | 51.5% | -43.9 pp |

Against the deterministic A0 baseline, A5 met the promotion floor (-4 points) but
missed path (-11.7 points) and mutant-kill (-13.9 points) floors. It met all three
credit/parent-context thresholds against A1, but the required quality conjunction
failed. The secondary wall target also failed.

AI credits/nano-AIU are runtime usage measures, not dollar cost. Combined values include
parent and worker. They do not include deterministic evaluator work.

## Interpretation

The result supports a real but incomplete tradeoff: delegation moved substantial input
out of the expensive parent and reduced measured credits, while increasing complete
system tokens and wall time and producing substantially weaker held-out behavioral
coverage. Structural validity and high promotion did not compensate for low path and
mutation coverage. Therefore the semantic corpus study saved credits but lost quality;
it does not validate the pattern as a quality-adjusted optimization.
