# ASCII-art benchmark result

**Disposition: completed with a structurally incomplete dataset; inference withheld.**
The available pairs do not support the proposed efficiency benefit.

## Flow

| Measure | Count |
| --- | ---: |
| Planned schedules | 60 |
| Started attempts | 82 |
| Selected runs | 46 |
| Missing schedules after retries | 14 |
| Complete ITT pairs | 20 |
| Selected deterministic pass/fail | 36 / 10 |

Selected runs were 26 control and 20 treatment. Missingness was asymmetric: 10
treatments and four controls were absent, primarily because 27 attempts observed the
wrong model. This is a central limitation, not neutral attrition.

## Canonical paired results

| Outcome | Control | Treatment | Difference |
| --- | ---: | ---: | ---: |
| Combined AI credits | 16.40 | 27.83 | +69.7% |
| Parent / worker credits | 16.40 / 0 | 25.40 / 2.43 | treatment split |
| Total nano-AIU | 123.522B | 192.138B | +55.5% |
| Parent cumulative input | 906,821 | 1,395,939 | +53.9% |
| Parent output | 8,616 | 10,479 | +21.6% |
| Complete-system model tokens | 915,436 | 1,457,904 | +59.3% |
| Wall time | 802.43 s | 361.54 s | -54.9% |
| Deterministic pass | 95% | 70% | -25 pp |
| Blinded overall quality | 4.682 | 3.799 | -0.883 |

Treatment missed both preregistered efficiency markers. Its largest blinded losses
were recognizability (-1.95/5) and composition (-2.10/5). Removing two
condition-noncompliant selected treatments left the same directions: more consumption,
lower deterministic/blinded quality, and lower wall time.

AI credits are the runtime usage measure, not dollar cost. Worker and parent values are
combined for system cost. Six external judge sessions were accounted separately and
never charged to either condition.

## Limitations and interpretation

- Fourteen schedules and complete prompt clusters were missing; no confidence interval,
  p-value, significance, noninferiority, causal, or population claim is supported.
- Dispatch-driven missingness was condition-imbalanced.
- One selected control artifact was unjudgeable under the frozen provenance scanner.
- The domain was one Windows PowerShell fixture, 10 tasks, one parent, and one worker.

Repository-owned deterministic acceptance checks and blinded judging assessed quality;
the parent did not grade itself. The supported descriptive conclusion is narrow:
delegating this small banner was faster but costlier and lower quality among the
available complete pairs.
