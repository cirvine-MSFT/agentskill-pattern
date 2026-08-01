# Case study: `ascii-art` as an overhead-dominated small-task hypothesis (counterexample candidate)

**Status: hypothesis candidate drawn from the completed, structurally incomplete
`ascii-art-powershell-cli` benchmark — not a causally isolated finding.** This case study
does not add new evidence; it re-reads the
[final benchmark report](../../experiments/ascii-art-powershell-cli/report.md) through one
lens — *is the delegated task small enough that fixed per-delegation overhead could
plausibly dominate it?* — and finds the data **consistent with, but not proof of,** that
hypothesis. It touches only this file and, where a link/status note is essential, the
[reference implementation notes](../reference-implementations/ascii-art.md). It does not
modify the README, the report, `raw/`, `results/`, `judgments/`, `docs/research/`, any
Skill/agent definition, or `experiments/`.

**Why this is a hypothesis, not a proof.** The benchmark's single treatment-vs-control
contrast changes two things at once: it both delegates the work (Skill → subagent) *and*
switches the model doing the generation, from the parent's `gpt-5.6-sol` to the specialist
`claude-haiku-4.5`. A single confounded contrast like this cannot separate "cost of
delegation/orchestration overhead" from "cost/quality of a different, smaller model" — nor
does it vary task size at all, so it cannot directly test whether a *larger* delegated
asset would behave differently. It also carries asymmetric, non-random missingness (see
[below](#missingness-and-inference-caveat)), which is itself a further confound on top of
the design's inherent one. Every causal-sounding sentence below should be read with that
ceiling in mind; where isolation would require a different design, this document says so
and links the design that could provide it.

## Hypothesis: fixed overhead may have dominated a tiny asset

The delegated task — writing one small, fixed-format ASCII-art banner file — is close to
the smallest unit of "bounded work" this pattern targets. Every delegation still pays a
largely *fixed* cost regardless of asset size: a Skill-routing decision, a subagent
invocation, an isolated context with its own tool schemas, a round trip of tool
calls/results, a specialist completion, and a compact return the parent must parse and act
on. The data below are consistent with that fixed cost not being amortized by a
correspondingly larger unit of avoided parent work for an asset this small — but because
delegation and model tier changed together in the same contrast, the same data are equally
consistent with the regression being driven partly or wholly by the model-tier change
itself, independent of task size. This is presented as a **task-too-small hypothesis /
counterexample candidate**, not a demonstrated causal failure of the pattern, and
certainly not a claim that the pattern is broadly ineffective.

## What the merged report measured (20 complete ITT pairs)

All figures below are copied from the [final report](../../experiments/ascii-art-powershell-cli/report.md#itt-descriptive-results)
and are descriptive only — no confidence intervals, p-values, or significance claims are
attached to them, consistent with the report's own withholding of inference.

| Outcome | Control | Treatment | Change |
| --- | ---: | ---: | ---: |
| Total AI credits | 16.40 | 27.83 | +69.7% |
| Total nano-AIU | 123.522B | 192.138B | +55.5% |
| Parent AI credits | 16.40 | 25.40 | +54.9% |
| Parent cumulative input tokens | 906,820.8 | 1,395,939.4 | +53.9% |
| Parent peak input tokens | 62,522.9 | 64,637.5 | +3.4% |
| Exposed tool count | 8.10 | 13.25 | +63.6% |
| Tool call/result count | 26.90 | 40.50 | +50.6% |
| Wall latency (s) | 802.43 | 361.54 | -54.9% |
| Parent active latency (s) | 149.02 | 230.48 | +54.7% |
| Deterministic pass | 95 pp | 70 pp | -25 pp |
| Overall blinded quality (1-5) | 4.682 | 3.799 | -0.883 |

Neither preregistered efficiency marker (≥10% lower total nano-AIU, ≥15% lower parent
cumulative input) was reached; both moved in the opposite direction.

### Directly measured: parent completions rose by a mean of 9.00

The report's "Parent AI credits" outcome is not an abstract billing abstraction here — in
this benchmark's own raw telemetry, `aiCredits` is recorded as unit `premium_requests` from
source `local_assistant_usage_events_exact_completion_rows`. Checked directly against all
20 selected treatment runs' per-event telemetry, every individual parent (`gpt-5.6-sol`)
completion event carries `aiCredits: 1`, while every specialist (`claude-haiku-4.5`)
completion event carries `aiCredits: 0.33` (excluded runs, including at least one confirmed
`wrong_model` attempt, show other split weights and are correctly excluded from the
selected set). At a fixed 1-credit-per-completion weight for the parent's model across all
20 selected treatments, **"Parent AI credits" is a direct completion count for the parent
role**, not an inferred proxy. So the report's paired means — **16.40 parent completions in
control vs. 25.40 in treatment, a measured +9.00 completions** — is published
completion-level telemetry, not an estimate.

What is *not* isolated by this design is **why** those 9 additional parent completions
occurred — additional routing turns, delegation/tool-result plumbing turns, post-return
integration-verification turns, retries, or some mix are all consistent candidate
mechanisms, and this single confounded run cannot distinguish them. Parent **cumulative**
input tokens also rose 53.9% while parent **peak** (single-turn) input tokens rose only
3.4%; a single much larger prompt would be expected to move both figures together, so this
divergence is corroborating context for "more completions, each replaying accumulated
context" rather than "one bigger request" — consistent with, not independent proof of, the
completion-count finding above. Isolating the specific mechanism (and separating it from
the simultaneous model-tier change) would need the kind of factorial design described in
[Related material](#related-material) below, not a re-read of this report.

### The extra cost was concentrated in the parent, not the specialist

- Exposed tool count rose 63.6% and tool call/result count rose 50.6% — the Skill,
  delegation plumbing, and specialist tool schema all add to what the runtime tracks,
  even though the specialist's own allowlist is narrow (`read`/`edit` only).
- Of the **+11.43** mean paired total-AI-credit increase, **+9.00 credits (= +9.00
  completions, per above) landed on the parent** and the specialist's own mean cost across
  20 selected treatments was only **2.4255 AI credits** (5.629B nano-AIU, 46,175.9
  cumulative input tokens, 29.12s of specialist/parent-wait latency). The parent, not the
  cheaper specialist, is where most of the extra spend went. Whether this reflects
  delegation overhead, the model-tier change, or both cannot be separated in this design —
  see the confound noted at the top of this document.

### Wall latency improved; parent active latency did not

Wall latency fell 54.9% (802.43s → 361.54s control-to-treatment), which is the only
efficiency-shaped number that moved favorably. But **parent active latency rose 54.7%**
(149.02s → 230.48s) — the parent itself spent more, not less, active time per run, even as
overall wall-clock time dropped (plausibly because specialist generation partially
overlaps or is faster than an equivalent inline generation path, not because the parent did
less work). Wall-latency improvement and parent-latency/cost regression are both real,
simultaneous, and worth reporting separately rather than netting into one "faster" claim.

### Quality loss was concentrated, not uniform

Mean paired blinded-quality differences (1-5 scale) were not evenly distributed across
dimensions:

| Dimension | Difference |
| --- | ---: |
| Recognizability | -1.95 |
| Composition | -2.10 |
| Function | -0.35 |
| Code quality | -0.20 |
| Integration | -0.40 |
| Cleanliness | -0.30 |

Recognizability and composition — the two dimensions most tied to *what the banner
actually looks like* — dropped roughly 4-6x further than the other four dimensions, and
the same direction holds under the per-protocol sensitivity (18 pairs, noncompliant runs
removed), so it is not solely an artifact of the two excluded noncompliant runs. **Why**
the drop concentrates there is a hypothesis, not an isolated finding: candidate
explanations include the specialist model's own generative capability on visual/aesthetic
judgment, something about the delegation/isolation mechanism itself (for example, less
shared context to keep the banner cohesive with its surroundings), or the asymmetric
missingness biasing which treatment runs were even selected. This single confounded,
missingness-affected design cannot distinguish among those explanations; attributing the
quality drop specifically to "the smaller model" would overstate what this run can show.

## Missingness and inference caveat

Of 60 preregistered schedules, only **46 produced selected runs**; **14 are missing** after
exhausted retries (4 controls, 10 treatments), leaving **20 complete ITT pairs**. The
report explicitly withholds bootstrap confidence intervals, p-values, overall
significance, and any complete-cluster causal estimate because of this asymmetric,
condition-imbalanced missingness. Every number in this case study is a **descriptive point
estimate over available complete pairs**, not an inferential or significance claim, and it
should not be read as one.

## Root cause: model dispatch, not the pattern's mechanics

The dominant driver of missingness was **model dispatch failure**: 27 of 36 excluded
attempts were `wrong_model` (the run executed on an unintended model), versus 5
`hash_mismatch` and 4 `telemetry_collection_failure`. This asymmetrically stripped
treatment schedules (10 missing) more than control schedules (4 missing), which is why
inference was withheld rather than merely under-powered. This is an infrastructure/harness
reliability problem in this experiment's execution, not evidence about the pattern's
design — but it does mean the descriptive numbers above rest on a smaller, non-randomly
reduced sample than preregistered.

## Direct-write and delegation-boundary deviations

Two categories of deviation from the pattern's intended contract appear in the retained
evidence:

- **A direct-write deviation:** in `P06-R3-treatment-A1`, the specialist wrote the banner
  in its own worktree and the **parent copied it** into place, rather than the specialist
  writing directly to the shared target as the pattern specifies. This run was already
  excluded from selected outcomes for a separately authenticated wrong-model violation, and
  is retained in evidence as noncompliant rather than hidden.
- **Delegation-boundary deviations removed by the per-protocol sensitivity:** two selected
  treatment runs were noncompliant — `P02-R1-treatment-A2` (targeted/changed files beyond
  the preregistered banner) and `P01-R3-treatment-A1` (over-broad delegation call/result
  evidence). Removing them (18 complete pairs) did not change the direction of any
  headline outcome; see the report's
  [per-protocol sensitivity](../../experiments/ascii-art-powershell-cli/report.md#per-protocol-sensitivity).

## Scope: implementation- and task-specific, not a general verdict

This hypothesis is bounded to one Windows PowerShell fixture, one parent model
(`gpt-5.6-sol`), one specialist model (`claude-haiku-4.5`), one harness (GitHub Copilot
CLI), and one visibly separable but very small generative task (an ASCII-art banner). It
does **not** establish that the Agent Skill Pattern fails in general, that cost-tiered
delegation never pays off, or that this result generalizes to larger or differently-shaped
bounded tasks. Two further limits sharpen that boundary: the benchmark's single contrast
changes delegation and model tier **simultaneously**, so it cannot attribute the regression
to task size, fixed overhead, or model tier individually or in isolation; and the
asymmetric, non-random missingness (above) means even the descriptive point estimates rest
on a smaller, differently-composed sample than preregistered. What this run is consistent
with is that *for a task this small*, fixed per-delegation overhead plausibly contributed
to the observed regression — worth checking for before delegating a similarly small task —
not a demonstrated, isolated, generalizable cause.

## Practical task-size screening checklist

Use this checklist *before* wiring a new Skill/subagent pair, to reduce the odds of
repeating this counterexample. None of these are individually sufficient; treat them as a
joint screen.

1. **Substantial bounded output (screening hypothesis, not a demonstrated threshold).**
   This run's banner sat near a plausible floor where a cheaper model's generation cost,
   plus fixed delegation overhead, could exceed the parent-inline cost — but this case
   study did not vary task size, so it cannot say where that floor actually is or confirm
   size alone (as opposed to model tier, which changed simultaneously) drove the
   regression. Treat "is this artifact substantial enough to delegate" as a question worth
   asking, not a rule this benchmark validated.
2. **Low parent coupling (screening hypothesis, not a demonstrated causal link).** Prefer
   tasks that need little parent-side reasoning about their content beyond invocation and a
   terse status check. In this run, higher cumulative-input growth co-occurred with
   parent re-verification of the specialist's output, but task/coupling level was not
   varied and model tier and delegation were confounded, so this is an observation
   motivating a check, not a proven cause of the regression.
3. **Isolated staging plus a deterministic validator gating promotion.** The specialist
   should write to an isolated staging location (or a staging path within the shared
   target's directory) rather than the live shared target directly, and a deterministic
   validator — a script or fixed rule-check, not the parent's model judgment and not blind
   trust in the specialist's status message — must pass before the artifact is promoted
   into the shared target. Never treat a compact "success" status alone as sufficient to
   accept a write to a shared target; see the `P06` copy deviation above for what an
   ungated, ad hoc version of this step looks like when it isn't specified up front.
4. **Deterministic validation available.** Prefer tasks whose output can be checked by a
   cheap, deterministic validator (length/character/format rules) rather than requiring
   the parent or a judge to assess subjective quality, since subjective dimensions
   (recognizability, composition) were where this case study's quality loss concentrated.
   This is the same validator that gates promotion in item 3, not a separate check.
5. **Compact return.** The specialist's return to the parent should be a small, fixed-shape
   status, not artifact content, error dumps, or exploratory reasoning.
6. **Parent does not reread the artifact into its own context, but the validator still
   runs.** After a successful terse status, the parent should not spend model-context
   tokens re-reading and reasoning over the full artifact — that would reintroduce the
   token cost delegation was meant to avoid — but this is not the same as skipping
   verification: the deterministic validator from items 3-4 (a script, not a model) still
   runs and gates promotion. "The parent doesn't reread it" and "nothing checks it" are
   different claims; only the first is recommended here.
7. **Overhead estimate or preflight before committing.** Before wiring the Skill, estimate
   (or run a small preflight on) the fixed per-delegation cost — routing turn(s), tool
   schema exposure, specialist completion, return parsing — and compare it against the
   expected inline-generation cost for a *representative* asset size. If the fixed cost is
   a large fraction of the expected inline cost, the task is a poor candidate regardless of
   how well-bounded it otherwise looks.

## Related material

- [Final benchmark report](../../experiments/ascii-art-powershell-cli/report.md) — the
  source of every number in this case study.
- [Reference implementation notes](../reference-implementations/ascii-art.md) — the Skill
  and subagent definitions this benchmark measures.
- [`docs/agent-skill-pattern.md` — When not to use this pattern](../agent-skill-pattern.md#when-not-to-use-this-pattern)
  and [Observability and measurement](../agent-skill-pattern.md#observability-and-measurement) —
  the pattern-level guidance this case study's checklist extends.
- [Semantic acceptance-test corpus generation research — §8 evaluation design](../research/semantic-corpus-generation.md#8-evaluation-design-recommendation) —
  a separate, newer candidate reference that specifies a **full 2×2 factorial design**
  crossing delegation (inline vs. subagent-delegated) with model tier (parent vs.
  cheap/small model), plus a deterministic-baseline control arm. That design — not this
  single confounded contrast — is the kind of instrument needed to separate "cost of
  delegation/orchestration" from "cost of a different model tier," including reporting
  the delegation effect *conditional on* model tier and testing for an interaction between
  them. It does not itself vary task size, so isolating the task-size hypothesis specifically
  would need a further extension of that template (an added task-size factor), not a re-read
  of the ascii-art report.
- [Completed semantic test-corpus protocol-v5 report](../../experiments/semantic-test-corpus/report.md) —
  the separately analyzed 12-block, six-arm case study. Its different
  credit/context/latency pattern is not pooled with this ASCII task; together the two
  studies support task scale/structure only as a hypothesis, not a general effect.
