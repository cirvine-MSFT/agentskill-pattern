# ASCII-art PowerShell CLI benchmark report

**Status: experiment completed with a structurally incomplete dataset; inference
withheld.** Of 60 preregistered schedules, 46 produced selected runs and 14
exhausted retries. The analysis below is descriptive. It does not report bootstrap
confidence intervals, p-values, overall significance, or a complete-cluster causal
estimate.

Machine-readable sources:

- [raw run evidence](raw/) and [authenticated artifacts](artifacts/)
- [49 blinded judgment records](judgments/)
- [collection flow and deviations](results/collection-summary.json)
- [runtime blinding realization](results/blinding-summary.json)
- [descriptive paired summary](results/summary.json)
- [separate judge usage export](results/judge-usage.json)
- [validator result and expected completeness gates](results/validation-summary.json)

## Methods and frozen references

The preregistered design paired control and treatment by `promptId + repetition`
across 10 prompts and three repetitions. Each selected artifact was scored blind on
six 1-5 dimensions. Available reliability duplicates were used only for agreement
and were excluded from outcome means.

The intent-to-treat (ITT) label in the generated summary means all selected,
non-infrastructure-excluded runs, including selected condition-noncompliant runs.
The per-protocol sensitivity removes those condition-noncompliant selected runs.
Infrastructure-excluded attempts remain in flow accounting but not outcome means.
Every treatment-minus-control estimate uses only prompt-repetition pairs with both
conditions available for that outcome; no unpaired observation was substituted.

| Frozen item | Reference |
| --- | --- |
| Protocol | `ascii-art-powershell-cli-v1`, starting commit `71635d9f6ba1e54e81e9f1f3eb081e51187e66bd` |
| Control | tag `experiment-control-v1`, commit `6e2812c0e181502cb1aafbc5fa3e31761b4b54ed` |
| Treatment | tag `experiment-treatment-v1`, commit `ac0895c23c4c811cf10e5af5b42efcde12c14849` |
| Prompts | SHA-256 `b9f218b8d744803c30aad7f52dee06eaa10d2fce2191668b54b0be02faff02e3` |
| Fixture lock | SHA-256 `929f1b04f0c646241d975c719ff3e59671319b578028016508e87110123b3613` |
| Acceptance lock | SHA-256 `58162a48495f5cd1f29fccb5fb545959f42dee2db584b0d0eea9dc19f1fc4629` |
| Randomization | SHA-256 `17b872a454c9141fef73b6be939b6226c3b54ec7efac72c56e7fd4a1d4447ba0` |
| Judge assignments | SHA-256 `14f31cedff85e984e83bf947975f18aba58cf9cf872d330bafbfa1936badf9fc` |
| Parent / specialist / judge | `gpt-5.6-sol` / `claude-haiku-4.5` / `gpt-5.6-sol` |

The six score sources were exact commits `905c0898997aba295b5254e3ada4a003b91b3d8f`,
`9e0b915a4f84b3bacca443dd911e9ddbf638d24c`,
`516f639fb639712c00bc1c5ea56c245b1e0b759a`,
`1ebaba7375af2c9ca7943aee84e48b47c361fc7d`,
`3629acae10aee7506e32e4aa88928f7dcfb8646c`, and
`af792a087dac6d3d994c442e57e78ccc3cd322ea`. Their six judge session IDs are
recorded in each judgment and in the separate usage export. All judge sessions used
`gpt-5.6-sol` and were disjoint from trial sessions.

## Flow and validation

| Stage | Count |
| --- | ---: |
| Preregistered schedules | 60 |
| Started run attempts | 82 |
| Excluded attempts | 36 |
| Selected runs | 46 |
| Missing schedules after exhausted retries | 14 |
| Selected deterministic pass / fail / unavailable | 36 / 10 / 0 |
| Available primary blind judgments | 45 |
| Available reliability duplicates | 4 |
| Total judgment records | 49 |

Selected runs comprised 26 controls and 20 treatments, yielding 20 complete ITT
pairs. Four controls and 10 treatments were missing. Exclusions were 27
`wrong_model`, five `hash_mismatch`, and four
`telemetry_collection_failure` attempts. This condition-imbalanced missingness,
driven primarily by model dispatch, is a central limitation rather than a neutral
loss of sample size.

The standard full-dataset validator passes the reconciled runtime set. Strict
`--require-complete` validation exits 1 with exactly the 14 expected missing-schedule
gates and no other failures. `B0022` is separately and correctly represented as
unjudgeable: its selected `P04-R1-control-A1` artifact contained the prohibited
provenance phrase `control output`. It is not silently scored or replaced.

## ITT descriptive results

Values are generated from 20 complete pairs and rounded for display. Nano-AIU values
are shown in billions of nano-AIU. Percent change is
`(treatment mean - control mean) / control mean`.

| Outcome | Control mean (median) | Treatment mean (median) | Mean paired difference | Median paired difference | Change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Total AI credits | 16.40 (16.00) | 27.83 (27.48) | +11.43 | +9.48 | +69.7% |
| Total nano-AIU, billions | 123.522 (115.079) | 192.138 (185.976) | +68.615 | +65.297 | +55.5% |
| Parent AI credits | 16.40 (16.00) | 25.40 (25.00) | +9.00 | +7.00 | +54.9% |
| Parent nano-AIU, billions | 123.522 (115.079) | 186.509 (180.505) | +62.986 | +57.534 | +51.0% |
| Parent cumulative input tokens | 906,820.8 (921,017) | 1,395,939.4 (1,343,274.5) | +489,118.6 | +370,434.5 | +53.9% |
| Parent peak input tokens | 62,522.9 (61,619) | 64,637.5 (63,497) | +2,114.6 | +1,764.5 | +3.4% |
| Parent output tokens | 8,615.5 (8,259) | 10,478.8 (9,594) | +1,863.3 | +1,292.5 | +21.6% |
| Exposed tool count | 8.10 (8) | 13.25 (13) | +5.15 | +5 | +63.6% |
| Tool call/result count | 26.90 (25.5) | 40.50 (38.5) | +13.60 | +11 | +50.6% |
| Compaction events | 0 (0) | 0 (0) | 0 | 0 | n/a |
| Compact-return bytes | 0 (0) | 0 (0) | 0 | 0 | n/a |
| Wall latency, seconds | 802.43 (799.71) | 361.54 (326.91) | -440.89 | -489.51 | -54.9% |
| Parent active latency, seconds | 149.02 (149.71) | 230.48 (218.81) | +81.46 | +68.30 | +54.7% |

The requested practical markers of **20% lower total credits** and **25% lower
parent cumulative input** were not reached. Their observed directions were reversed:
total credits were 69.7% higher and parent cumulative input was 53.9% higher in
treatment among complete ITT pairs. These are point estimates only.

Specialist metrics have no control counterpart and therefore no paired effect.
Across 20 selected treatments, the specialist means were 2.4255 AI credits, 5.629
billion nano-AIU, 46,175.9 cumulative input tokens, 9,653.2 peak input tokens,
5,309.9 output tokens, and 29.12 seconds of specialist/parent-wait latency. All 20
selected treatment delegation records were available. Control specialist and wait
metrics are explicitly unavailable because no specialist or delegation wait exists
in control.

## Deterministic and blinded quality

Among the 20 complete ITT pairs, deterministic pass was 95 percentage points for
control and 70 for treatment, a mean paired difference of -25 points. Discordance
was five control-pass/treatment-fail pairs, no control-fail/treatment-pass pairs, 14
concordant passes, and one concordant failure. Across all 46 selected runs, the
deterministic outcome was 36 pass and 10 fail.

| Blinded outcome (1-5) | Control mean (median) | Treatment mean (median) | Mean paired difference | Median paired difference |
| --- | ---: | ---: | ---: | ---: |
| Overall quality | 4.682 (4.83) | 3.799 (3.83) | -0.883 | -0.835 |
| Function | 4.80 (5) | 4.45 (5) | -0.35 | 0 |
| Code quality | 4.15 (4) | 3.95 (4) | -0.20 | 0 |
| Integration | 4.85 (5) | 4.45 (5) | -0.40 | 0 |
| Recognizability | 4.75 (5) | 2.80 (3) | -1.95 | -2 |
| Composition | 4.65 (5) | 2.55 (2) | -2.10 | -2 |
| Cleanliness | 4.90 (5) | 4.60 (5) | -0.30 | 0 |

Only 45 primary artifacts were judged because `B0022` was unjudgeable. The 20
quality pairs above remain complete because the paired treatment for that
unjudgeable control was itself missing. Four available duplicate pairs contributed
24 dimension comparisons: exact agreement was 17/24 (70.8%) and within-one
agreement was 24/24 (100%). Duplicate scores were excluded from all means.

## Per-protocol sensitivity

Two selected treatment runs were noncompliant:
`P02-R1-treatment-A2` targeted/changed files beyond the preregistered banner, and
`P01-R3-treatment-A1` additionally had over-broad delegation call/result evidence.
Removing them leaves 44 observations and 18 complete pairs.

| Outcome | Control mean | Treatment mean | Mean paired difference | Change |
| --- | ---: | ---: | ---: | ---: |
| Total AI credits | 16.50 | 28.14 | +11.64 | +70.6% |
| Total nano-AIU, billions | 126.188 | 193.813 | +67.625 | +53.6% |
| Parent AI credits | 16.50 | 25.72 | +9.22 | +55.9% |
| Parent cumulative input tokens | 913,519.8 | 1,415,825.5 | +502,305.7 | +55.0% |
| Wall latency, seconds | 805.33 | 370.02 | -435.31 | -54.1% |
| Deterministic pass | 94.4 pp | 66.7 pp | -27.8 pp | n/a |
| Overall quality | 4.684 | 3.814 | -0.870 | -18.6% |

The sensitivity direction is unchanged: greater treatment consumption and lower
paired deterministic/blinded quality, alongside lower wall latency.

## Judge usage

Judge usage is exported separately and excluded from treatment/control efficiency.
The six authenticated local sessions contain 86 `gpt-5.6-sol` completions totaling
8,990,217 input tokens, 37,343 output tokens, 8,989,959 cached read-plus-write
tokens, 1,295,010,375,000 nano-AIU, and 650,662 ms duration. Per-completion values,
availability, exact query text, and a WAL-inclusive SQLite snapshot hash are in
[`results/judge-usage.json`](results/judge-usage.json). No judge usage is included in
the tables above.

## Deviations and limitations

- **High, asymmetric missingness and model dispatch:** 14/60 schedules are missing,
  including 10 treatments. Twenty-seven attempts were excluded for wrong observed
  model. This is the dominant root cause and prevents complete prompt clusters.
- **Block 3 overlap:** block 3 was released before coordinators confirmed terminal
  nested-banner completion for four earlier A2 retries. No outcome-based release
  decision was made, but strict block closure ordering was violated.
- **P06 copy noncompliance:** `P06-R3-treatment-A1` had the specialist write in its
  own worktree and the parent copy the banner. The attempt was retained in evidence,
  marked noncompliant, and excluded from selected outcomes for its separately
  authenticated wrong-model violation; it is not hidden by the selected-run tables.
- **Cloud events unavailable:** cloud event transport was unavailable with reason
  `session_store_cloud_transport_connection_refused_during_collection`. Local
  authenticated event and usage evidence was retained; unavailable cloud fields were
  not inferred.
- **Unjudgeable selected artifact:** `B0022` was rejected by the frozen provenance
  scanner. No post-outcome replacement or rebalancing occurred.
- **Limited domain:** one Windows PowerShell fixture, 10 tasks, one parent model, one
  specialist model, and a visibly separable ASCII-art task do not establish
  generality.

Because 14 schedules and complete prompt clusters are missing, every generated
outcome marks bootstrap output unavailable. The evidence cannot support inferential
significance, quality non-inferiority, or a general causal claim.

## Conclusion

This incomplete run does not provide descriptive support for the proposed
efficiency benefit. Among available complete pairs, treatment used more total and
parent resources and had lower deterministic pass and blinded quality, especially
recognizability and composition, while finishing with substantially lower wall
latency. The per-protocol sensitivity did not change those directions. These
patterns are useful diagnostics, but asymmetric dispatch-driven missingness and the
withheld inferential analysis prevent a significance or general-effect claim.

## Reproduction

From `experiments/ascii-art-powershell-cli`:

```powershell
node scripts\reproduce-results.js
node scripts\reproduce-results.js --check
```

The first command runs the official validator, verifies that strict completeness
fails only the 14 registered gates, and regenerates `results/summary.json` with
`--allow-incomplete` plus `results/validation-summary.json`. The second checks both
generated files byte-for-byte.

Judge usage can be re-exported on the machine holding the six local judge sessions:

```powershell
python scripts\export-judge-usage.py --out results\judge-usage.json
```

The judgment importer is also reproducible from the six exact committed score
worktrees via `scripts\import-judgments.js --block-1 <dir> ... --block-6 <dir>`;
`--check` verifies all 49 committed judgment files without rewriting them.
