# Feature documentation delegation protocol v1

**Status:** prospectively preregistered, design only. Zero AI observations have
started. The permanently excluded pilot and the main experiment both require later,
explicit authorization.

## Question and estimand

When a GPT-5.6 Sol parent owns a meaningful API, CLI, or library feature, does
delegating only its bounded user-facing guide to fixed Claude Haiku 4.5 reduce
complete-system AI credits and parent context without materially reducing feature or
documentation quality?

The primary estimand is the paired intent-to-treat A2-minus-A1 effect across 24 frozen
fixture-variant blocks. The experimental unit is one fresh parent session in one fresh
worktree. A block contains the same public task bytes under both arms; arm order is
randomized within each block.

## Arms

| Arm | Parent responsibility | Documentation responsibility |
| --- | --- | --- |
| A1 | Requirements, production code, integration, guide, final response | GPT-5.6 Sol parent writes the precreated target inline |
| A2 | Requirements, production code, integration, final response | Parent invokes `feature-documentation` once; fixed Claude Haiku 4.5 writes only the target |

Both parents use GPT-5.6 Sol at medium effort in GitHub Copilot CLI 1.0.77. A2's
worker uses the generated `feature-documentation-haiku` profile with only built-in
`read` and `edit`. It has no shell, search, web, MCP, Skill, or recursive delegation.
The parent reaches it through the global task/custom-agent surface.

The parent completes and checks production work before delegation. It passes only
`TASK.md`, `docs/CONVENTIONS.md`, the exact changed public source/API file, the
precreated target, and an owned-path restriction equal to that target. The worker
writes directly and returns one compact status line. After the call, A2's parent may
not read, grade, validate, quote, repair, rewrite, or selectively stage the target.
There is no retry and no inline fallback. Telemetry, file-read events, file-edit
events, terminal bytes, and terminal tree enforce adherence; parent self-assertion is
insufficient.

### Treatment-adherence predicate

[`scripts/evaluate-adherence.mjs`](scripts/evaluate-adherence.mjs) deterministically
derives the recorded `adherent` value from authenticated ordered events. A2 is
adherent if and only if all of these hold:

1. the parent invokes `feature-documentation-haiku` exactly once and exactly one
   worker session uses its frozen session ID and `claude-haiku-4.5`;
2. the worker uses only `read` and `edit`, reads only the four public allowlisted
   paths, edits only the target, and makes at least one successful target edit;
3. the worker emits exactly one compact target status and never invokes another Skill
   or agent;
4. the parent never edits the target; and
5. after the worker's first target edit, the parent never reads or edits the target.

Any violation sets `adherent=false`; the observation remains ITT and is not retried.
A1 is adherent only when it creates and invokes no documentation worker. The
candidate-local Skill and agent are the authoritative runtime copies. They are
byte-identical to the hash-pinned repository sources; the parent invokes that profile
through the CLI's global task/custom-agent surface.

Execution preflight records whether the candidate filesystem is case-sensitive. The
adherence evaluator resolves paths using that captured behavior: exact case on
case-sensitive filesystems and case-folded comparison only on case-insensitive ones.

## Fixtures, sample, and order

Eight independent main tasks make implementation the larger parent goal:

| Fixture | Production goal | Bounded documentation artifact |
| --- | --- | --- |
| `cursor-pagination` | Cursor pagination API | API usage guide |
| `retry-schedule` | Deterministic retry policy | Executable cookbook |
| `route-template` | Route-template matcher | API guide |
| `configuration-migration` | v1-to-v2 migration API | Migration note |
| `duration-parser` | Strict duration parser | API guide |
| `batch-planner` | Capacity-bounded batch planner | Cookbook |
| `config-inspect-cli` | Configuration inspection command | CLI command guide |
| `json-redact-cli` | JSON redaction command | CLI command guide |

Each task has three fixed adversarial variants that alter defaults, option names,
formats, or semantics. This prevents a worker from succeeding by reproducing a generic
memorized guide. The 8 × 3 combinations form 24 complete blocks and 48 main
observations. [`design/schedule.json`](design/schedule.json) freezes every block,
order, observation ID, parent ID, treatment-worker ID, and worktree ID using seed
`56017731`. No optional GPT-to-GPT arm is included because it would dilute the primary
A2-versus-A1 question.

Two separate one-variant tasks, `pilot-slug-codec` and `pilot-greet-cli`, form four
permanently outcome-ineligible development observations. Their IDs begin `PILOT`;
main IDs begin `MAIN`. Pilot worktrees, sessions, outputs, and summaries can never be
reused in the main experiment.

## Candidate and evaluator boundary

`generate-fixture.mjs` deterministically emits two physically separate roots:

1. the candidate root contains one public task, one starter source file, conventions,
   a precreated empty documentation target, public syntax check, Skill, agent, and a
   public boundary manifest;
2. the coordinator-only evaluator root contains the selected hidden feature vectors,
   documentation facts, unsupported-claim traps, and exact variant identity.

Main execution must create a fresh isolated worktree from the preregistered source pin
for every observation, materialize only the candidate root into it, and make all
coordinator, benchmark, sibling, prior-output, evaluator, schedule, and evidence roots
unavailable to parent and worker tools. The evaluator root remains outside every
candidate workspace. Candidate bytes are hash-bound before session creation.

Hidden documentation requirements, executable checks, expected outputs, unsupported
claim traps, and adversarial variant definitions are never copied into candidates.
The public task necessarily states feature requirements; the hidden evaluator checks
whether the implementation and guide faithfully realize them without exposing exact
test vectors or scoring.

## Deterministic quality evaluation

The parent never grades documentation. After its session terminates, the external
zero-credit evaluator:

1. imports the implemented library or invokes the implemented CLI against hidden
   feature vectors;
2. extracts every `js executable` and `console executable` block;
3. runs JavaScript snippets and CLI commands with a five-second bound;
4. compares CLI stdout to the immediately following `text expected` block;
5. parses every JSON fence;
6. resolves local files and Markdown anchors;
7. checks required headings, symbols/options, variant facts, and error behavior; and
8. penalizes claims of unsupported behavior.

It emits feature correctness and documentation correctness, coverage, executability,
format, unsupported-claim count, and diagnostics under
[`schemas/evaluation.schema.json`](schemas/evaluation.schema.json). Deterministic
evaluation consumes zero AI credits and is excluded from latency.

The machine field named documentation `correctness` is specifically required
symbol/option reference presence minus affirmative unsupported-claim penalties; it is
not a free-form semantic judgment. Coverage checks variant facts, while executable
snippets and exact command outputs are the strongest deterministic documentation
quality signal. Negated limitations such as "does not support wildcards" are not
penalized. The per-observation `pass` field is a convenience summary that also checks
format; it is not the experiment-level positive-signal decision.

Candidate code and snippets execute only in a dedicated evaluator sandbox with no
secrets, denied network access, a scrubbed environment, and filesystem access limited
to the candidate plus evaluator probe. The checked-in evaluator scrubs inherited
environment variables; the execution coordinator must provide the OS/container
network and filesystem boundary.

A secondary blinded readability/usefulness review may occur only after all
deterministic outcomes and the statistical decision are frozen. Reviewers receive
rendered documentation with arm, model, task ID, session metadata, costs, and
deterministic scores removed. Artifact order uses a separately committed seed.
Reviewers score clarity and usefulness on fixed five-point rubrics. These judgments
are descriptive and cannot rescue or overturn the primary decision.

## Outcomes and economics

[`schemas/observation.schema.json`](schemas/observation.schema.json) freezes the
record. Primary efficiency outcomes are:

- combined parent-plus-worker AI credits;
- parent AI credits; and
- parent cumulative and peak input tokens.

Also capture combined/parent/worker nano-AIU; total, parent, and worker tokens; parent
output and worker input/output tokens; active, worker, wait, and wall milliseconds;
completion count; parent/worker tool calls and result bytes; terminal completion;
treatment adherence; and deterministic quality. Credits are the runtime accounting
unit, not dollar cost. Raw token inflation alone is not failure if credit, quality,
reliability, and token guardrails all pass.

## Frozen positive-signal rule

A positive signal requires every conjunct below. Ratios are A2/A1; differences are
A2 minus A1. Confidence bounds are one-sided 95% paired percentile bootstrap bounds
with 100,000 resamples, block as the resampling unit, seed `56017732`, and the
predeclared statistic recomputed within each sample.

| Domain | Required gate |
| --- | --- |
| Combined credits | Upper ratio bound ≤ 0.85 |
| Parent credits | Upper ratio bound ≤ 0.70 |
| Parent cumulative input | Upper ratio bound ≤ 0.70 |
| Parent peak input | Upper ratio bound ≤ 0.85 |
| Feature correctness | Lower difference bound ≥ -0.02 and A2 mean ≥ 0.95 |
| Docs correctness | Lower difference bound ≥ -0.05 and A2 mean ≥ 0.90 |
| Docs coverage | Lower difference bound ≥ -0.05 and A2 mean ≥ 0.90 |
| Docs executability | Lower difference bound ≥ -0.05 and A2 mean ≥ 0.90 |
| Reliability | A2 completion ≥ 0.90 and lower completion-difference bound ≥ -0.05 |
| Adherence | A2 treatment adherence ≥ 0.90 |
| Total tokens | Upper ratio bound ≤ 1.75 |
| Wall time | Upper ratio bound ≤ 1.50 |

Ratio statistics are ratios of paired arithmetic means over all started ITT units,
not means of per-unit ratios. A started failure retains measured cost and receives
zero for every incomplete quality dimension. Missing required usage after a started
unit fails the corresponding gate; it is not imputed. Reliability and adherence use
all 24 scheduled treatment units. No outcome is winsorized or removed as an outlier.
Point estimates, two-sided 95% intervals, and per-fixture effects are descriptive.

All 48 main units must start for a positive-signal decision. If operational stopping
leaves either arm unstarted in any block, the study reports descriptive available-case
summaries only and the combined signal is automatically not met. Consequently every
bootstrap resample contains both arms for every sampled block; incomplete-pair
imputation or post-hoc pair dropping is forbidden.

## Lifecycle, ITT, and stopping

Pre-start means no parent session exists and no model request has been sent. A unit
starts when the pinned parent CLI emits its first model-usage event. From that instant
it is permanently ITT: no retry, replacement, continuation in a new session, or
outcome-driven exclusion. A positively proven infrastructure failure before start
may rerun in the same schedule slot with the same frozen IDs and bytes.

Execution stops without opening later outcome files if any of these occur:

- candidate/evaluator isolation or source hashes cannot be proven;
- CLI/model/profile/tool pins differ;
- observation order or IDs differ from the schedule;
- evidence capture cannot distinguish parent and worker usage;
- a candidate can access hidden or prior-observation material;
- deterministic evaluator reproduction differs; or
- privacy review detects secrets or personal content.

An operational stop does not erase started units. The report distinguishes
pre-start unavailable slots from started ITT failures.

## Interpretation limit

The contrast estimates the complete A2 configuration, not an isolated
Haiku-versus-GPT writing ability effect. A1's document author is the full-tool parent
and can run examples before finishing. A2's bounded worker intentionally lacks shell
and must derive examples from public requirements and implemented source. Any
executability difference therefore includes model, delegation, context, and
tool-surface effects together.

## Permanently excluded pilot

This design session does not run the pilot. A later authorization may run exactly the
four scheduled pilot observations, once each, solely to verify:

- fixed-Haiku routing and model identity;
- worker read/edit confinement and direct target ownership;
- parent non-read behavior after delegation;
- parent/worker usage attribution;
- fresh IDs/worktrees and candidate/evaluator separation;
- terminal and tool-event capture; and
- deterministic feature, snippet, output, JSON, link, and anchor evaluation.

Pilot GO requires all four sessions to start at most once, all artifacts to evaluate,
both A2 workers to use the fixed profile and only allowed paths/tools, both A2 parents
to avoid post-delegation reads, usage to partition exactly, and deterministic
reproduction to match twice. GO only authorizes the already frozen 24-block main
boundary. Any prompt, fixture, evaluator, schema, threshold, pin, or mechanism change
requires a new preregistration and a new excluded pilot. Pilot semantic scores never
enter main estimates.

## Evidence, privacy, and retention

The coordinator records authenticated raw events, usage rows, exact prompts, session
and worktree IDs, initial/terminal commits and trees, file reads/edits, tool calls and
result byte counts, process timing, candidate/evaluator hashes, deterministic output,
and deviations. Evidence is keyed by observation ID and source hash. Parent and worker
credits/tokens are separately attributable; combined fields equal their sums.

Prompts and fixtures contain synthetic data only. Before archival, remove machine
paths, usernames, environment values, credentials, and unrelated repository content.
Never publish local usage databases or full conversation history. The eventual PR
keeps schemas, manifests, aggregate tables, and the smallest audit excerpts needed for
adherence; bulky raw evidence remains access-controlled and is not added to this
repository.

## Freeze and execution boundary

The source pin, models, CLI, arms, prompt envelopes, task catalog, variants, seed,
schedule, IDs, sample, evaluator, schemas, metrics, thresholds, pilot gates, privacy,
retention, and stopping rules are frozen by
[`design/source-manifest.json`](design/source-manifest.json). Reproduction checks
generated candidate/evaluator bundle digests, source hashes, links, schedule bytes,
and the no-run attestation.

Merging this design PR would not authorize any observation. Execution requires a new
session that first verifies the merged commit against the manifest and receives
explicit pilot authorization. Main execution requires a later pilot GO and another
explicit authorization. No result evidence may be created before those boundaries.
