# Preregistered semantic migration corpus benchmark

**Status:** protocol and deterministic foundation only. Frozen 2026-07-29 against
`48f44fbf3dca97a001ab2e822cf17faff869b846` (`main`). No AI arm has been run and
this repository contains no AI outcomes.

Any protocol change after a measured session starts is a deviation. Preserve the
original protocol, record the deviation in the run record, and do not overwrite
the preregistered schedule or thresholds.

## Question and estimands

For generation of semantic acceptance scenarios for a deterministic v1-to-v2
configuration migration:

1. Does model tier affect corpus quality?
2. Does direct delegation affect corpus quality?
3. Does the delegation effect interact with model tier?
4. Is each AI arm noninferior to a strong deterministic baseline, and does any
   arm provide a materially better quality/resource tradeoff?

The experimental unit is one fresh session producing one 60-case staging file.
The primary run-level quality endpoints are promotion rate, instrumented semantic
path coverage, and held-out mutant kill rate. Rule/invariant coverage, diagnostic
category coverage, diversity, latency, usage, tool behavior, and compliance are
secondary endpoints. Oracle correctness is a prerequisite, not an endpoint.

## Fixture and semantic contract

The fixture migrates a v1 service configuration into a deterministic v2 shape.
The public, machine-executable mapping and invariant program is
`fixture/spec/mapping-spec.json`. It contains stable rule, branch-path, invariant,
and diagnostic IDs. The candidate implementation in `fixture/migration/index.mjs`
interprets that program. The reference oracle in `fixture/oracle/index.mjs` is an
independent explicit implementation: it does not import the candidate, mapping
interpreter, or candidate schema validator.

The migration covers:

- service-name normalization; environment-specific port and timeout defaults;
- canonical and deprecated region mappings;
- log-level rename and production format precedence;
- disabled, memory, and Redis cache semantics;
- SQLite, PostgreSQL, and MySQL projections and default ports;
- fixed/exponential retries with a 60-second cap;
- CORS canonicalization/deduplication and feature normalization/sorting;
- domain and cross-field invariants for production safety, cache requirements,
  effective port conflicts, retry bounds, origin syntax, and normalized collisions.

Every structurally valid case emits the exact rule IDs, decision-path IDs, and
applicable invariant IDs it exercised. Invalid semantic inputs still execute all
mapping decisions, but the returned `config` is `null`. This keeps diagnostics
and trace coverage observable without treating invalid configurations as
successful migrations.

## Oracle prerequisite and trust checks

Do not start a measured session unless all of these pass:

1. The manually derived assertions in `tests/golden-cases.json` agree with both
   the oracle and candidate.
2. Metamorphic checks pass for property order, ignored disabled-cache fields,
   canonical/legacy region equivalence, timeout scaling, and origin duplication.
3. Candidate/oracle parity holds for the complete deterministic corpus and the
   acceptance-only examples.
4. All trace IDs are declared by the mapping program.
5. Staging, promotion, mutation, and report artifacts reproduce exactly.

The 33 mutants test corpus sensitivity only. A high mutation score cannot repair
or establish a wrong oracle. If any prerequisite fails, the benchmark is
invalidated until the oracle/goldens are reviewed and the preregistration is
versioned before outcomes are inspected.

## Arms

The fixed model IDs are part of the treatment, not labels that may be silently
substituted.

| Arm | Model tier | Delegation | Fixed execution model |
|---:|---|---|---|
| 0 | None | No | Strong deterministic baseline |
| 1 | Frontier | No | `gpt-5.6-sol`, inline |
| 2 | Frontier | Yes | `gpt-5.6-sol` parent and same-model direct-staging worker |
| 3 | Cheap | No | `claude-haiku-4.5`, inline |
| 4 | Cheap | Yes | `claude-haiku-4.5` parent and worker via the staged Skill/agent contract |

Arms 1-4 form the complete 2x2 model-tier by delegation factorial. Arm 0 is the
external baseline. The shared task text is byte-identical; routing instructions
are injected by the coordinator and are not appended to that text.

### Atomic model-binding preflight

Before opening any outcome:

1. Create fresh no-outcome probe sessions using the exact requested bindings.
2. Export platform event/session evidence identifying the observed parent model
   and, for delegated cells, the observed worker model.
3. Fill a copy of `design/model-preflight-template.json`.
4. Run `scripts/preflight-models.mjs` and freeze its availability output.

A cell is available only when the requested and observed IDs match, model
binding is reported atomic, fresh session IDs exist, delegated workers match the
cell model, and evidence was captured before outcome inspection. If any AI cell
is unavailable, mark it unavailable before runs. Do not substitute a model,
run only a delegation or tier marginal, or describe the result as a partial
factorial. The preregistered factorial analysis is withheld; arm 0 may be
reported descriptively.

## Blocking, repetitions, and schedule

There are 12 randomized complete blocks and 60 planned runs. Each block contains
each arm exactly once. `design/seeds.json` freezes block seeds and
`design/schedule.json` freezes within-block order. Arm 0 uses its block seed for
the grammar/property component; the other deterministic components remain fixed.
AI arms receive the same block seed as an input-design seed.

Twelve paired repetitions per arm were chosen to expose run-to-run session
variation while retaining complete-block comparisons. Inference is at the run
or block level; 60 cases within a run are not treated as 60 independent model
replicates.

## Common contract and budget

Every run receives:

- the shared prompt in `design/shared-task-prompt.txt`;
- public v1/scenario/staging schemas and the public mapping contract;
- a fresh workspace and a single coordinator-selected block seed;
- exactly 60 case slots and the same staging schema;
- 30 wall-clock minutes, at most 120 tool calls, and at most 100,000 total model
  tokens for AI arms;
- no retry for semantic quality or low scores.

The deterministic baseline has no model usage but is held to the same 60-case
output and wall-clock ceiling. Resource differences are measured, not normalized
away.

Staging files contain inputs only. They must not contain expected output,
diagnostics, or traces. The coordinator validates and promotes each accepted
staging file in a subprocess. Promotion invokes only the independent oracle.
Expected outputs do not exist before promotion.

## Delegation and parent-context isolation

Delegated workers write directly to the named staging file. They do not stream
the corpus through the parent. The parent may receive only:

- staging path and SHA-256;
- case count and validator error count;
- compact promotion/report summaries.

The parent must not open or reread the full staging or promoted corpus into its
context. It validates/promotes by command and records compact stdout. This keeps
the larger parent migration task meaningful without turning parent context into
an unmeasured corpus-review treatment.

For arm 4, copy `design/cheap-delegated-skill.md` into the fresh session's active
Skill/agent location only after the workspace is created. For arm 2, inject
`design/delegated-worker-instruction.txt` directly. Both workers use identical
staging ownership and budget rules.

## Acceptance opacity and held-out provenance

Measured generator workspaces include only the public contract, public schemas,
shared prompt, seed, and empty staging destination. Exclude:

- `acceptance/**`
- `artifacts/**`
- `fixture/oracle/**`
- `mutants/**`
- `tests/**`
- all prior run files

`acceptance/held-out-rules.json` and `acceptance/held-out-examples.json` were
newly authored on 2026-07-29 against the frozen base commit and are not supplied
to generators. Repository/path isolation establishes prompt and workspace
opacity only. It does **not** establish that similar material was absent from
model pretraining; no training-leakage claim is made.

## Strong deterministic baseline

Arm 0 is not a strawman. `baseline/generate.mjs` combines:

1. explicit rule/invariant decision tables;
2. in-range, edge, and just-outside boundary partitions;
3. a greedy pairwise covering array over environment, region, cache, database,
   retry, and logging dimensions, with executable proof that no pair is missing;
4. seeded schema/grammar/property generation for names, origins, features, and
   timeouts;
5. `FiniteDomainSolver`, a dependency-free finite-domain constraint solver used
   for valid multi-factor conjunctions.

Exact-input deduplication happens after generation. If strategies produce the
same input, source tags are merged rather than counting a duplicate as another
case. The checked foundation corpus is 60 unique inputs.

## Hidden mutants and acceptance

`mutants/definitions.mjs` defines 33 deterministic mapping/invariant faults. They
include wrong aliases/defaults/units, precedence and canonicalization defects,
omitted fields, retry-cap errors, and omitted domain/cross-field diagnostics.
Definitions, triggers, and kill matrices are acceptance-only and never copied to
generator workspaces.

A mutant is killed when at least one promoted case produces a result different
from its oracle expected result under that mutant. Nonapplicable cases are
recorded separately from survivors. The per-case matrix records both
applicability and kills, preventing a mutant from appearing covered merely
because it exists in the catalog.

## Metrics

All quality metrics are computed after opaque oracle promotion.

| Metric | Definition |
|---|---|
| Structural validity | Staged cases passing scenario and v1 structural schemas / submitted cases |
| Promotion rate | Cases accepted and oracle-promoted / 60 |
| Semantic rule/path/invariant coverage | Distinct instrumented declared IDs exercised / declared IDs |
| Hidden mutant kill rate | Mutants killed by at least one promoted case / applicable mutant catalog |
| Diagnostic category coverage | Distinct semantic diagnostic categories emitted / five declared categories |
| Exact redundancy | Repeated SHA-256 of canonical JSON input; lower is better |
| Semantic redundancy | Repeated signature of paths, invariant IDs, and diagnostic IDs |
| Diversity | Unique semantic-signature rate and mean pairwise Jaccard distance over path/diagnostic sets |
| Usage | Parent, worker, and total nano-AIU/credits plus input/output/total tokens |
| Tool behavior | Distinct tool surface and calls by tool, parent, and worker |
| Latency | Start-to-staging wall time; parent active, worker active, and authenticated parent wait where available |
| Compliance | Fresh session, exact models, opacity, direct staging, case/budget limits, and deviations |

Semantic `status: invalid` is often an intentional negative case and is not a
structural failure. Reports keep that count separate from promotion validity.
Duplicate detection compares generated artifacts with one another; it is a
redundancy/diversity measure, not a leakage detector.

`schemas/run-record.schema.json` is the normative telemetry envelope. Total usage
must equal parent plus worker where the platform exposes additive units. Missing
platform fields remain explicit `null`/unavailable in collected records; they are
never reconstructed from outcome quality.

## Practical materiality and noninferiority

The following run-level differences are fixed before AI outcomes:

- promotion-rate noninferiority margin: -5 percentage points;
- semantic path-coverage noninferiority margin: -3 percentage points;
- mutant-kill noninferiority margin: -5 percentage points;
- materially better quality: at least +3 points path coverage or +5 points
  mutant kill, with promotion noninferior;
- materially better diversity: at least +10 points unique semantic signatures,
  with all three primary quality measures noninferior;
- materially better efficiency: at least 20% lower median total credits/nano-AIU
  or latency, with all three primary quality measures noninferior.

These thresholds describe practical decisions. Failure to detect a statistical
difference is not equivalence or noninferiority.

## Statistical analysis

Analyze the 12 run-level observations per available arm.

1. Report every arm's median, interquartile range, mean, standard deviation, and
   all 12 block values for each endpoint.
2. For arms 1-4, code tier and delegation as -1/+1. Estimate paired block-level
   tier, delegation, and interaction contrasts. Report contrast estimates and
   95% block-bootstrap intervals using 10,000 resamples and seed `20260729`.
3. Compare each AI arm with arm 0 using paired within-block differences. Report
   two-sided exact sign-flip/randomization p-values and 95% block-bootstrap
   intervals.
4. Claim noninferiority only when the lower 95% interval for the paired
   difference exceeds the fixed margin. Report point estimates against the
   materiality thresholds even when intervals are wide.
5. Apply Holm correction across the four baseline comparisons separately for
   each primary endpoint. Factorial main effects/interactions are the three
   preregistered contrasts and are reported with unadjusted intervals plus a
   clear multiplicity warning.
6. Treat usage, tools, latency, compliance, diagnostic coverage, redundancy, and
   diversity as secondary/descriptive. Do not convert them into an unregistered
   composite score.

## Missingness, retries, and exclusions

- A pre-session platform failure may receive one retry in a new session with the
  same arm, block, model, seed, and remaining full budget. Record both attempts.
- A started session is never retried because of output quality, validator
  failure, timeout, low coverage, or low mutant score.
- Model mismatch, acceptance exposure, nonfresh session, or non-atomic binding
  is an exclusion and compliance failure, not a zero silently replaced by a new
  trial.
- A malformed/short/late staging file remains the measured outcome with its
  observed structural validity and promotion rate.
- Primary complete-block analysis includes only blocks with all available arms.
  Also report all-arm descriptive data and sensitivity bounds that assign
  missing quality outcomes first 0 and then 1. Do not impute intermediate values.
- If more than two blocks are incomplete, withhold confirmatory language and
  report the benchmark as descriptive.

## Blinding and judging

Oracle promotion, traces, mutation, schemas, and redundancy metrics are
deterministic and require no judge. The evaluator receives opaque run IDs; arm,
model, delegation, session text, and usage are joined only after metrics freeze.

No subjective judge is planned. A judge may be added only if objective arms are
within all practical materiality thresholds and a downstream decision genuinely
requires ranking diagnostic actionability. In that event, freeze a separate
rubric, blinded bundles, judge models/humans, and analysis before opening arm
labels. Such judgments are secondary and cannot replace the preregistered
deterministic endpoints.

## Execution order

1. Run `npm test` and `npm run reproduce`.
2. Generate/freeze `design/schedule.json`.
3. Run and freeze atomic model-binding availability preflight.
4. Create isolated fresh workspaces in schedule order.
5. Generate inputs directly to staging; collect raw telemetry.
6. Validate staging without opening the corpus in parent context.
7. Promote through the oracle and freeze hashes.
8. Run hidden acceptance, traces, mutation, and compact reporting under blinded
   run IDs.
9. Freeze metric tables, then join arm labels and execute the registered analysis.

Do not merge, publish claims, or alter this protocol merely because a preferred
arm underperforms.
