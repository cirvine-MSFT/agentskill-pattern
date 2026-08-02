# Unit-test delegation excluded-pilot result

**Disposition: NO-GO. The experiment version stops permanently; main remains
forbidden.**

The exact corrected preflight passed from repository head
`603ac78997e1e8cd496f5d6f065f1940a99d4f92` with preregistration root
`def40cf7d53e098c58afffdd76859955910b0eea16fa9a263a3395de720e5538` and
current-source root
`001c6d95cec2e3ef22e76f643afad7b54f65f7d6c0dd35f25f3587c2ed8d0f69`.
The lifecycle then started two observations in frozen order and stopped on the
required integrity boundary after `pilot-P01-r01-A2` was classified as tool
misuse. Both P02 observations remain unstarted and were not retried.

## Started observations

| Measure | P01 A1 control | P01 A2 treatment |
| --- | ---: | ---: |
| Status | Complete | Tool misuse |
| Parent / worker / combined credits | 61.031550 / 0 / 61.031550 | 32.385575 / 4.252740 / 36.638315 |
| Parent / worker / total model tokens | 219,945 / 0 / 219,945 | 162,189 / 26,547 / 188,736 |
| Parent cumulative / peak input | 207,750 / 24,423 | 157,401 / 17,632 |
| Parent / worker active time | 160.806 s / 0 | 55.720 s / 42.302 s |
| Parent wait / wall time | 0 / 186.740 s | 44.150 s / 110.290 s |
| Hidden feature cases | 4/4 | 4/4 |
| Candidate / gold test pass | Pass / fail | Fail / fail |
| Mutants killed | 4/4 | 4/4 |
| Branch / statement coverage | 100% / 100% | 100% / 100% |
| Assertions / isolation | 19 / pass | 50 / fail |
| Test-quality composite | 0.875 | 0.625 |
| Operational reliability / adherence | 1 / 1 | 0 / 0 |

For the one started pair, A2 used 40.0% fewer combined credits, 46.9% fewer
parent credits, 14.2% fewer total model tokens, 24.2% less parent cumulative
input, 27.8% less parent peak input, and 40.9% less wall time. These descriptive
differences do not establish a positive result: A2 lost 0.25 test-quality
points and failed both reliability and adherence.

## Mechanism and gate

A1 made 20 parent calls (9 view, 11 PowerShell) and no worker calls. A2 made 17
parent calls (8 view, 7 PowerShell, 1 Skill, 1 task) and 9 worker calls (8 view,
1 edit). The fixed-Haiku path was reached once, and no parent target-test access
was detected. The audit nevertheless found an unsuccessful or missing worker
tool completion and a worker read-set/count mismatch. External evaluation found
that the resulting A2 tests did not pass against either candidate or gold.

Only 1/4 scheduled observations completed operationally. Both started units
exceeded the 80,000-token envelope; A1 also exceeded the 40-credit envelope.
Both stayed below the 300-second wall limit. The frozen gate therefore returned
NO-GO for completion, feature, A2 adherence, A2 candidate/gold test pass, mean
A2 mutant kill, false-positive, telemetry, and resource-envelope requirements.

Raw events, usage rows, candidate repositories, and diagnostics remain outside
the repository. The 59-file private evidence package is bound by root
`de4d618f91f3a5a819652939241cfef8d9e65d83901ad7e9352f61bb825c9ff6`.
Two independent reproductions matched this root, the gate, paired summary, and
all observation hashes.
