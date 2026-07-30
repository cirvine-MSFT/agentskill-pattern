# Case study: `ascii-art` as a "task too small" counterexample

**Status: descriptive counterexample drawn from the completed, structurally incomplete
`ascii-art-powershell-cli` benchmark.** This case study does not add new evidence; it
re-reads the [final benchmark report](../../experiments/ascii-art-powershell-cli/report.md)
through one lens — *is the delegated task large enough for the Agent Skill Pattern's fixed
per-delegation overhead to pay for itself?* — and answers no, for this specific asset,
model pair, and harness. It touches only this file and, where a link/status note is
essential, the [reference implementation notes](../reference-implementations/ascii-art.md).
It does not modify the README, the report, `raw/`, `results/`, `judgments/`, `docs/research/`,
any Skill/agent definition, or `experiments/`.

## The core finding: fixed overhead dominated a tiny asset

The delegated task — writing one small, fixed-format ASCII-art banner file — is close to
the smallest unit of "bounded work" this pattern targets. Every delegation still pays a
largely *fixed* cost regardless of asset size: a Skill-routing decision, a subagent
invocation, an isolated context with its own tool schemas, a round trip of tool
calls/results, a specialist completion, and a compact return the parent must parse and act
on. For a banner-sized artifact, that fixed cost is not amortized by a correspondingly
larger unit of avoided parent work — so total consumption went up, not down. This is a
**task-too-small** failure of the pattern's premise, distinct from a claim that the pattern
is broadly ineffective.

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

### Parent cumulative input rose far more than parent peak input

Parent **cumulative** input tokens rose 53.9% while parent **peak** (single-turn) input
tokens rose only 3.4%. A single much larger prompt would be expected to move both figures
together; instead, almost all of the cumulative increase sits outside the peak. That
pattern is consistent with — though not a direct turn-count measurement in the report,
which does not export a per-turn token trace — **more parent turns and more replayed
context** (routing, delegation, tool-result plumbing, and post-return integration
verification each adding their own turn) rather than one larger single request. Read this
as the most defensible interpretation available from the published aggregates, not as a
separately verified causal mechanism.

### The extra cost was concentrated in the parent, not the specialist

- Exposed tool count rose 63.6% and tool call/result count rose 50.6% — the Skill,
  delegation plumbing, and specialist tool schema all add to what the runtime tracks,
  even though the specialist's own allowlist is narrow (`read`/`edit` only).
- Of the **+11.43** mean paired total-AI-credit increase, **+9.00 credits landed on the
  parent** and the specialist's own mean cost across 20 selected treatments was only
  **2.4255 AI credits** (5.629B nano-AIU, 46,175.9 cumulative input tokens, 29.12s of
  specialist/parent-wait latency). The parent, not the cheaper specialist, is where most
  of the extra spend went — the opposite of what a cost-tiering benefit would predict for
  a task this small.

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
actually looks like* — dropped roughly 4-6x further than the other four dimensions. This
suggests the quality cost of delegating this particular generative task to the smaller
specialist model was concentrated in visual/aesthetic judgment rather than mechanical
correctness, though the report's per-protocol sensitivity (18 pairs, noncompliant runs
removed) shows the same direction, so it is not an artifact of the two excluded
noncompliant runs alone.

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

This finding is bounded to one Windows PowerShell fixture, one parent model
(`gpt-5.6-sol`), one specialist model (`claude-haiku-4.5`), one harness (GitHub Copilot
CLI), and one visibly separable but very small generative task (an ASCII-art banner). It
does **not** establish that the Agent Skill Pattern fails in general, that cost-tiered
delegation never pays off, or that this result generalizes to larger or differently-shaped
bounded tasks. It shows that *for a task this small*, fixed per-delegation overhead
plausibly exceeded the savings the pattern is meant to produce, and that this deserves
checking before delegating, not after.

## Practical task-size screening checklist

Use this checklist *before* wiring a new Skill/subagent pair, to reduce the odds of
repeating this counterexample. None of these are individually sufficient; treat them as a
joint screen.

1. **Substantial bounded output.** The artifact being generated should be large or complex
   enough that a cheaper model's generation cost, plus the fixed delegation overhead, is
   still less than the parent-inline cost. A single small fixed-format file (this case
   study's banner) is close to the floor where this stops being true.
2. **Low parent coupling.** The task should need little-to-no parent-side reasoning about
   its content beyond invocation and a terse status check — if the parent must re-verify,
   re-read, or reason extensively about the result, that reasoning shows up as the
   cumulative-input growth this case study measured.
3. **Direct staging write.** The specialist must write directly to the real shared target
   (or an agreed staging path the parent trusts without inspection), not to a private
   location the parent then has to copy from — see the `P06` deviation above.
4. **Deterministic validation available.** Prefer tasks whose output can be checked by a
   cheap, deterministic validator (length/character/format rules) rather than requiring
   the parent or a judge to assess subjective quality, since subjective dimensions
   (recognizability, composition) were where this case study's quality loss concentrated.
5. **Compact return.** The specialist's return to the parent should be a small, fixed-shape
   status, not artifact content, error dumps, or exploratory reasoning.
6. **Parent does not reread the artifact.** After a successful terse status, the parent
   should trust the result rather than opening and re-reading the full artifact — rereading
   reintroduces the token cost the delegation was meant to avoid.
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
- [Semantic acceptance-test corpus generation research](../research/semantic-corpus-generation.md) —
  a separate, newer candidate reference evaluating where a bounded AI subagent task fits
  (or doesn't) inside a deterministic pipeline; relevant background for judging task size
  and boundedness before wiring a new Skill/subagent pair.
