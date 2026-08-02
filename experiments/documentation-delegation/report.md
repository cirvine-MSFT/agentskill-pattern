# Feature documentation delegation excluded-pilot result

**Disposition: NO-GO. The frozen main study is not authorized.**

The permanently excluded pilot ran its two blocks and four A1/A2 observations once, in
committed order, from canonical `main` at
`bfb2d0fcc8531842e7ed0bab7c88d7c8dfa6a4ab`. All four parent sessions started exactly
once, completed, settled usage, captured terminal state, evaluated, and reproduced
twice. No observation or worker was retried, replaced, tuned, or removed from ITT.

## Frozen pilot gate

| Conjunct | Result |
| --- | --- |
| Exact four-observation coverage | Pass |
| All sessions started once | Pass |
| All artifacts evaluated | Pass |
| A2 routing | **Fail (0/2)** |
| A2 adherence | **Fail (0/2)** |
| A2 parent no-review | **Fail (0/2)** |
| Parent/worker usage partition | Pass |
| Terminal capture | Pass |
| Two deterministic reproductions | Pass |

Both A2 runs violated the frozen worker boundary: runtime session/model attribution,
handoff bytes, path confinement, successful target edit, and compact terminal status did
not match the contract. Both delegated guides scored zero for correctness, coverage, and
executability. These failures alone require NO-GO.

## Per-observation results

| Block | Arm | Combined credits (parent + worker) | nano-AIU (parent + worker) | Tokens | Active / worker / wait / wall | Feature | Docs correct / coverage / executable | Mechanism |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B01 | A2 | 26.313625 (25.110825 + 1.202800) | 26.314B (25.111B + 1.203B) | 131,535 | 50.892 / 10.180 / 10.812 / 61.465 s | 0/2 | 0 / 0 / 0 | Non-adherent; complete |
| B01 | A1 | 41.181675 (41.181675 + 0) | 41.182B (41.182B + 0) | 107,624 | 93.517 / 0 / 0 / 94.658 s | 0/2 | 1 / 1 / 1 | Non-adherent input mutation; complete |
| B02 | A2 | 26.048225 (24.422825 + 1.625400) | 26.048B (24.423B + 1.625B) | 132,763 | 48.673 / 13.590 / 14.129 / 60.180 s | 1/1 | 0 / 0 / 0 | Non-adherent; complete |
| B02 | A1 | 22.233125 (22.233125 + 0) | 22.233B (22.233B + 0) | 60,444 | 52.634 / 0 / 0 / 51.655 s | 1/1 | 1 / 1 / 0.667 | Adherent; complete |

B01 feature checks in both arms received zero because the external evaluator attempted to
create temporary module probes on a read-only evaluator mount. This post-start launcher
packaging failure is retained in ITT and was not repaired or rerun. The within-block B01
feature difference remains zero, but the affected feature levels are not semantic evidence.

## Descriptive arm economics and quality

| Mean outcome | A1 inline | A2 delegated | A2/A1 or difference |
| --- | ---: | ---: | ---: |
| Combined AI credits | 31.707400 | 26.180925 | 0.826 (-17.4%) |
| Parent AI credits | 31.707400 | 24.766825 | 0.781 (-21.9%) |
| Worker AI credits | 0 | 1.414100 | +1.414100 |
| Combined nano-AIU | 31.707B | 26.181B | 0.826 (-17.4%) |
| Total model tokens | 84,034 | 132,149 | 1.573 (+57.3%) |
| Parent cumulative input | 77,519.5 | 117,857 | 1.520 (+52.0%) |
| Parent peak input | 14,398 | 14,256 | 0.990 (-1.0%) |
| Parent output | 6,514.5 | 3,555 | 0.546 (-45.4%) |
| Worker input / output | 0 / 0 | 9,886 / 851 | - |
| Parent active time | 73.076 s | 49.783 s | 0.681 (-31.9%) |
| Worker / wait time | 0 / 0 | 11.885 / 12.471 s | - |
| Wall time | 73.157 s | 60.823 s | 0.831 (-16.9%) |
| Feature score | 0.5 | 0.5 | 0 |
| Docs correctness / coverage | 1 / 1 | 0 / 0 | -1 / -1 |
| Docs executability | 0.833 | 0 | -0.833 |

The two pair-specific combined-credit ratios were `0.639` and `1.172`; parent-input
ratios were `1.203` and `2.080`. Pilot semantic scores are permanently excluded from main
estimates, and two blocks are insufficient for the frozen main bootstrap rule.

## Integrity and scope

The exact sanitized machine record is [`pilot-summary.json`](pilot-summary.json);
[`pilot-hashes.json`](pilot-hashes.json) binds the runner, authorization, launcher,
canonical summary, and retained external provenance. Raw events, usage rows, candidate
trees, evaluator material, and process output remain outside the repository.

The launcher used practical container path separation, runner-owned negative controls,
normal container networking for the Copilot control plane, and `--network none` for the
evaluator. This is not a hostile-sandbox, kernel-isolation, or compliance claim.

The only permitted next boundary would have been a separate explicit main authorization
after pilot GO. Because the frozen result is NO-GO, no main execution is authorized.
