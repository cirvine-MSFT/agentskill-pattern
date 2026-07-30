# Preregistered semantic migration corpus benchmark

**Status:** protocol and deterministic foundation only. Initially frozen
2026-07-29 against `48f44fbf3dca97a001ab2e822cf17faff869b846` (`main`) and
revised 2026-07-30 in response to pre-run review. No AI arm has been run and this
repository contains no AI outcomes.

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
interprets that program. The evaluator-only reference oracle in
`evaluator/oracle/index.mjs` is an
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

1. The manually derived assertions in `evaluator/tests/golden-cases.json` agree with both
   the oracle and candidate.
2. Metamorphic checks pass for property order, full-outcome equivalence of
   ignored disabled-cache fields, canonical/legacy region equivalence, timeout
   scaling, and origin duplication.
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
| 2 | Frontier | Yes | `gpt-5.6-sol` parent and worker through the common delegated Skill |
| 3 | Cheap | No | `claude-haiku-4.5`, inline |
| 4 | Cheap | Yes | `claude-haiku-4.5` parent and worker through the common delegated Skill |

Arms 1-4 form the complete 2x2 model-tier by delegation factorial. Arm 0 is the
external baseline. All AI arms use the byte-identical shared task artifact and
tool surface. Arms 2 and 4 use the same byte-identical
`task/delegated-worker-skill.md`, invocation name, direct-staging ownership,
return shape, and tool surface; only the bound parent/worker model IDs differ.
Inline arms execute the same task contract directly.

### Authenticated per-run model binding

For every measured AI run, before generation starts:

1. Create a fresh parent session and, for delegated arms, a fresh worker session
   using the exact requested bindings.
2. Obtain the platform's raw JSON event export, detached Ed25519 signature, and
   trusted platform public key under `design/platform-evidence-contract.json`.
3. Record signed `run.started`, `session.created`, and atomic `model.bound` events
   carrying the frozen run ID, block ID, arm ID, role, and unique session ID.
4. Bind each run record to the exact export/payload/signature/key hashes and
   signed event/session IDs, then run `scripts/preflight-models.mjs`.

A run is available only when signature verification succeeds; its run record
binds the exact raw evidence hashes and event IDs; every required role has a
unique session created within ten minutes before that run; the signed atomic
binding matches the requested model; `run.started` uses the authenticated parent;
and delegated worker parentage is correct. The verifier evaluates all 48 AI runs
and 72 parent/worker role sessions, not one representative probe per arm.
Caller-provided verification/freshness strings are not inputs. Missing, reused,
unsigned, fabricated, non-atomic, late, or model-mismatched evidence makes that
run unavailable. If any AI run is unavailable, do not
substitute a model, run only a marginal, or call the result a partial factorial.
The factorial analysis is withheld; arm 0 may be reported descriptively.

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
- a target of exactly 60 case slots and the same 0-60 submission schema;
- 30 wall-clock minutes, at most 120 tool calls, and at most 100,000 total model
  tokens for AI arms;
- no retry for semantic quality or low scores.

The deterministic baseline has no model usage but is held to the same 60-case
output and wall-clock ceiling. Resource differences are measured, not normalized
away.

Staging files contain inputs only. They must not contain expected output,
diagnostics, or traces. The evaluator measures JSON parse errors, missing slots,
and each malformed case rather than discarding the run. It validates every
present slot independently, preserves indexed rejection reasons, and oracle-
promotes only valid cases. `promotionRate = promotedCases / 60`, including zero
and partial submissions. Expected outputs are created only by the independent
oracle after each case passes promotion.

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

Signed role mappings are derived from each run's `session.created` and
`model.bound` events. In delegated arms, only the authenticated worker may write
the exact staging file; worker writes anywhere else fail compliance. The parent
may only invoke delegation, call compact validation/promotion tools, and receive
the frozen compact return fields. Any parent staging read/write, missing worker
staging write, or parent-does-all trace fails compliance. Inline arms have no
worker and require the authenticated parent to write staging directly.

For both arms 2 and 4, invoke the single materialized
`task/delegated-worker-skill.md` artifact using the same Skill name. The
coordinator rejects any run whose signed tool/session evidence shows a different
delegation mechanism, return surface, or worker access pattern.

## Acceptance opacity and held-out provenance

All hidden material is under the separate `evaluator/` package: oracle, goldens,
held-out rules/examples, mutants, promoted artifacts, and evaluator tests.
Measured sessions never use this benchmark checkout as their repository.
`scripts/materialize-candidate.mjs` creates a new external Git repository from
the exact allowlist in `design/candidate-manifest.json`; it refuses destinations
inside or containing the benchmark repository and never copies `evaluator/`,
prior staging, the candidate migration implementation, seeds, or schedule.
The sole in-tree exception is the cleaned `.test-work/` path used by the
materializer regression test; measured runs must use an external destination.

Before session creation, the platform must enforce `candidate-root-only`
filesystem access, explicitly deny the evaluator root, and deny network access.
Afterward, `scripts/verify-isolation-evidence.mjs` verifies the signed platform
export and derives compliance from policy, file-access, network-access, and
audit-completion events. Caller booleans are not accepted. An incomplete audit,
outside-root/evaluator attempt, allowed network request, policy mismatch, or
unexpected session is noncompliant.
Every signed `file.read` or `file.write` tool call must carry a unique call ID,
path, and authenticated actor and have exactly one matching `fs.access` event
with the same call ID, actor/session, path, operation, and allowed decision.
Orphan tool calls or filesystem events—including a staging write with no
filesystem event—fail closed.

Each run also records signed `run.completed` and `outcomes.unblinded` events
from the authenticated parent. Any signed `outcome.accessed` event must identify
an authenticated run session/role and occur after both timestamps. Premature or
uncorrelated access is a compliance failure; post-boundary evaluator access is
retained in the audit.

`evaluator/acceptance/held-out-rules.json` and
`evaluator/acceptance/held-out-examples.json` were newly authored on 2026-07-29
against the frozen base commit. Materialization and signed access evidence prove
only that they were not supplied to measured prompts/workspaces. They do **not**
show that similar material was absent from model pretraining; no training-
leakage claim is made.

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

`evaluator/mutants/definitions.mjs` defines a frozen catalog of 33 deterministic
mapping/invariant faults. They
include wrong aliases/defaults/units, precedence and canonicalization defects,
omitted fields, retry-cap errors, and omitted domain/cross-field diagnostics.
Definitions, triggers, and kill matrices are acceptance-only and never copied to
generator workspaces.

Before scoring, `evaluator/mutants/validate.mjs` independently verifies unique
IDs, declared rule/invariant targets, a baseline/golden witness for every
mutant, non-equivalence, no fixture mutation, unchanged instrumentation/status,
and changes confined to one declared config or diagnostic fault surface.

A mutant is killed when at least one promoted case exposes it. The denominator
is always the frozen 33-mutant valid catalog. A mutant with no triggering case
is an untriggered survivor, never removed as “not applicable.” The matrix records
trigger and kill evidence per case, and reports `killed / 33`.

## Metrics

All quality metrics are computed after opaque oracle promotion.

| Metric | Definition |
|---|---|
| Structural validity | Staged cases passing scenario and v1 structural schemas / submitted cases |
| Promotion rate | Cases accepted and oracle-promoted / 60 |
| Semantic rule/path/invariant coverage | Distinct instrumented declared IDs exercised / declared IDs |
| Hidden mutant kill rate | Mutants killed by at least one promoted case / frozen 33-mutant catalog |
| Diagnostic category coverage | Distinct semantic diagnostic categories emitted / five declared categories |
| Exact redundancy | Repeated SHA-256 of canonical JSON input; lower is better |
| Semantic redundancy | Repeated signature of paths, invariant IDs, and diagnostic IDs |
| Diversity | Unique semantic-signature rate and mean pairwise Jaccard distance over path/diagnostic sets |
| Usage | Parent, worker, and total nano-AIU/credits plus input/output/total tokens |
| Tool behavior | Distinct tool surface and calls by tool, parent, and worker |
| Latency | Start-to-staging wall time; parent active, worker active, and authenticated parent wait where available |
| Compliance | Derived signed model/policy/access/audit evidence plus budget and mechanism deviations |

Semantic `status: invalid` is often an intentional negative case and is not a
structural failure. Reports keep that count separate from promotion validity.
Duplicate detection compares generated artifacts with one another; it is a
redundancy/diversity measure, not a leakage detector.

`schemas/run-record.schema.json` is the normative telemetry envelope. Its
compliance object references the derived isolation audit and evidence hash; it
does not accept self-attested booleans. Total usage
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
   The tier and delegation main effects are differences of their two marginal
   means. Interaction is half the difference between frontier and cheap
   delegation effects. Also report the four conditional simple effects:
   delegation at frontier/cheap and tier within inline/delegated runs.
3. For each of four AI arms and each of three primary endpoints, use the paired
   within-block difference `AI - baseline` for the one-sided noninferiority null
   `H0: difference <= margin` against `H1: difference > margin`. Compute the
   one-sided exact sign-flip/randomization p-value after shifting by the fixed
   margin, and a one-sided 95% lower block-bootstrap bound.
4. Apply Holm step-down control at family-wise alpha 0.05 across the complete
   family of 12 noninferiority hypotheses (four arms x three primary endpoints).
   Claim noninferiority only when its Holm-adjusted one-sided p-value is below
   0.05. Also report the unadjusted lower bound and point estimate against the
   practical margin; do not call an unadjusted interval confirmatory.
5. Equality/superiority is a separate question. Report two-sided paired
   sign-flip p-values and two-sided 95% block-bootstrap intervals descriptively,
   with a separate Holm adjustment across the 12 equality hypotheses. A failed
   equality test does not establish equivalence, and an equality result cannot
   substitute for the one-sided noninferiority test.
6. Factorial main effects/interactions are the three preregistered contrasts and
   are reported with unadjusted intervals plus a clear multiplicity warning.
7. Treat usage, tools, latency, compliance, diagnostic coverage, redundancy, and
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
  Also report all-arm descriptive data and sensitivity bounds that assign each
  missing arm outcome first 0 and then 1, plus worst/best paired AI-minus-
  baseline bounds. Do not impute intermediate values.
- If zero complete blocks remain, do not execute sign-flip or paired-factorial
  routines. Emit deterministic per-arm availability/summaries and sensitivity
  bounds, set paired comparisons/factorial results to null, and give an explicit
  unavailable reason.
- If more than two blocks are incomplete, withhold confirmatory language and
  report the benchmark as descriptive. `evaluator/statistics.mjs` then emits
  `confirmatoryAvailable: false`, an explicit reason, and `noninferior: null` for
  every comparison regardless of raw or Holm-adjusted p-values.

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
3. Materialize external allowlisted candidate repositories and apply filesystem/
   network policy.
4. In schedule order, create each run's fresh role sessions and verify/freeze its
   signed run/model binding before generation.
5. Generate inputs directly to staging; collect call-correlated signed raw
   telemetry/access logs.
6. Verify the signed isolation audit, then validate each staging slot without
   opening corpus content in parent context.
7. Promote valid cases through the evaluator oracle and freeze hashes.
8. Run evaluator-only held-out acceptance, traces, mutation, and compact reporting under blinded
   run IDs.
9. Freeze metric tables, then join arm labels and execute the registered analysis.

Do not merge, publish claims, or alter this protocol merely because a preferred
arm underperforms.
