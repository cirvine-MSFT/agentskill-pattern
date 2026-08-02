# Feature documentation delegation protocol v2

**Status:** prospective excluded-pilot authorization. Zero AI observations have started.
The 12 permanently excluded pilot slots are authorized only after this separate no-run
change merges and passes its exact current-main preflight. Held-out main remains forbidden.

## Question and estimand

When GPT-5.6 Sol implements a meaningful API, CLI, or library feature, does mandatory
routing of only its documentation artifact to fixed Claude Sonnet 4.6 reduce complete
workflow AI credits and parent credits without materially reducing deterministic feature
or documentation quality?

The primary estimand is the paired intent-to-treat A2-minus-A1 effect over 24 frozen,
held-out fixture-variant blocks. One observation is one fresh parent session in one fresh
candidate worktree. Each block uses identical public bytes under both arms and randomized
within-block order.

## Arms and mandatory routing

| Arm | Production owner | Documentation owner |
| --- | --- | --- |
| A1 | GPT-5.6 Sol parent | Same parent writes the precreated target inline |
| A2 | GPT-5.6 Sol parent | Parent loads `feature-documentation-sonnet-v2` once; it invokes the fixed Sonnet agent once |

The parent owns requirements, implementation, public checks, integration, and final
response in both arms. A2 delegates only the precreated documentation target after
production work is complete. Requested and observed worker model must both be
`claude-sonnet-4.6`.

The Skill is intentionally only a routing contract. Its named custom agent has only
`read` and `edit`; shell, search, web, MCP, Skills, agents, and recursion are absent. The
worker may read only `TASK.md`, `docs/CONVENTIONS.md`, the exact changed public source
files, and the target. It must replace the complete target in exactly one successful edit
and return one terminal JSON object. No narration is allowed.

A2's parent trusts that compact status. From the first worker target edit onward, the
parent may not read, grade, validate, repair, rewrite, quote, or selectively stage the
target. There is no retry or inline fallback.

### Treatment adherence

Authenticated ordered runtime events, not model claims, determine adherence:

1. the parent loads the exact Skill once and invokes the named custom agent once;
2. exactly one frozen worker session is created with requested and observed model
   `claude-sonnet-4.6`;
3. the worker uses only `read` and `edit`, reads only allowlisted public paths, and makes
   exactly one successful complete-target edit;
4. the worker emits exactly one valid terminal status object and performs no nested
   routing;
5. the parent never edits the target and performs no target access after worker editing
   begins.

Direct custom-agent bypass fails because no Skill load exists. Loading a Skill without
the named agent, emitting a fabricated status, using another model, or writing docs
inline fails as pseudo-delegation. Violations remain in ITT and are never repaired or
retried. A1 is adherent only if it creates no documentation worker and loads no routing
Skill.

## Fresh corpus, sample, and order

No v1 fixture, task, observation, session, worker, or worktree ID is reused. Public task
bytes, conventions, agent, Skill, and generated bundle hashes are new.

Eight held-out main tasks form 24 paired blocks through three adversarial variants each:

| Fixture | Larger engineering goal | Documentation artifact |
| --- | --- | --- |
| `header-preference` | Weighted HTTP-style preference parser | API cookbook |
| `sliding-window` | Configurable sequence window library | Library guide |
| `config-overlay` | Typed layered configuration merge | Configuration example |
| `settings-upgrade` | Versioned settings migration | Migration example |
| `retry-budget` | Budget-aware retry planner | API cookbook |
| `path-rewrite` | Ordered path rewrite engine | API guide |
| `table-project-cli` | Delimited-table projection command | CLI command guide |
| `token-audit-cli` | Token inspection and filtering command | CLI command guide |

Six separate one-variant tasks form 12 permanently outcome-ineligible pilot observations:
`label-fold`, `sum-lines-cli`, `environment-pick`, `chunk-view`, `color-map-cli`, and
`config-alias`. This six-pair sample must yield at least five valid complete pairs to
assess routing and quality mechanics. Normal started failures do not stop later schedule
slots; only evidence-integrity impossibility does.

[`design/schedule.json`](design/schedule.json) freezes seed `82620417`, every block and
run order, and new observation, parent-session, worker-session, and worktree IDs. Main
tasks and evaluator details remain held out from candidate sessions.

## Candidate and evaluator boundary

The generator emits physically separate roots:

1. the candidate root contains exactly one public task, starter source, conventions,
   empty target, syntax check, candidate boundary manifest, Skill, and agent;
2. the coordinator-only evaluator root contains hidden feature vectors, documentation
   assertions, unsupported-claim traps, and exact variant identity.

Candidates never receive source-repository, evaluator, evidence, schedule, sibling,
prior-output, authorization, or runner paths through files, arguments, environment, or
prompt text. A fresh candidate Git root is created per observation. Runner-owned policy
is frozen from `CANDIDATE.json` before launch and never reread afterward. Initial input
bytes are immutable except for the declared production source and documentation target.

The practical boundary detects accidental context/tool leakage; it is not a hostile
sandbox or model-compliance claim. Observed tool events, process arguments, environment
names, negative path probes, and terminal trees are evidence. Parent assertions are not.

## Deterministic zero-credit evaluator

After candidate termination, an external evaluator with no model calls:

1. evaluates production behavior against hidden module or CLI vectors;
2. extracts and executes every `js executable` snippet and `console executable` command;
3. requires every console command to have an adjacent exact `text expected` block;
4. parses JSON fences;
5. resolves repository-relative links and Markdown anchors;
6. checks required headings, public symbols/options, variant facts, and error behavior;
7. detects affirmative unsupported claims; and
8. reports feature correctness separately from documentation correctness, coverage,
   executability, and format.

Execution is time-bounded in a scrubbed evaluator process. AI credits and model timing
exclude evaluator work. A blinded readability/usefulness review is secondary and may
occur only after deterministic outcomes and the statistical decision are frozen; it
cannot rescue a failed gate.

## Outcomes and frozen gates

Primary economics are combined parent-plus-worker AI credits and parent AI credits.
Credits are the runtime accounting unit, not dollar cost. Parent/worker splits are always
reported. Secondary economics and guardrails include tokens, context, timing,
reliability, and treatment adherence.

Ratios are A2/A1 ratios of paired arithmetic means; differences are A2 minus A1.
One-sided 95% paired percentile bootstrap bounds use 100,000 resamples, block as the
unit, and seed `82620418`.

| Domain | Positive-signal requirement |
| --- | --- |
| Combined AI credits | Upper ratio bound <= 0.90 |
| Parent AI credits | Upper ratio bound <= 0.75 |
| Feature correctness | Lower difference bound >= -0.02 and A2 mean >= 0.95 |
| Docs correctness | Lower difference bound >= -0.05 and A2 mean >= 0.90 |
| Docs coverage | Lower difference bound >= -0.05 and A2 mean >= 0.90 |
| Docs executability | Lower difference bound >= -0.05 and A2 mean >= 0.90 |
| Docs format | Lower difference bound >= -0.05 and A2 mean >= 0.90 |
| Completion | A2 >= 0.90 and lower difference bound >= -0.05 |
| Adherence | A2 >= 0.90 |
| Parent cumulative input | Upper ratio bound <= 0.80 |
| Parent peak input | Upper ratio bound <= 0.90 |
| Total tokens | Upper ratio bound <= 1.60 |
| Wall time | Upper ratio bound <= 1.50 |

All conjuncts must pass. Sonnet may or may not save credits. A started failure retains
measured costs and receives zero for incomplete quality dimensions. Missing usage fails
the corresponding gate. There is no winsorization, outlier deletion, pair dropping, or
quality-conditioned exclusion.

## Lifecycle and stopping

Pre-start means no parent model request has occurred. A unit starts at the first
authenticated parent usage event and is permanently ITT. A positively proven
infrastructure failure before start may reuse only the same frozen slot and IDs.

After start, normal feature, documentation, routing, model, tool, timeout, or process
failure is recorded and the schedule continues. Stop remaining slots only if source or
order integrity, candidate/evaluator isolation, usage attribution, deterministic
reproduction, lifecycle locks, or privacy evidence becomes impossible.

Every slot has a write-once reservation and terminal disposition. Duplicate starts,
retries, replacement sessions, and reuse of candidate roots fail closed. All 48 main
observations must start for a positive signal; otherwise only descriptive available-case
summaries are permitted.

Pilot GO requires at least five valid pairs, all 12 scheduled slots disposed exactly
once, exact Skill/agent/model routing in every valid A2 run, reproducible deterministic
evaluation twice, usage partitioning, lifecycle-lock integrity, and no privacy or hidden
path disclosure. A normal started failure can make GO fail but cannot truncate the
remaining pilot schedule. GO authorizes only a separate decision to execute the already
frozen held-out main; it does not execute or authorize main observations.

## Runner audit and evidence

The generic runner contract freezes:

- no evaluator, evidence, schedule, source-repository, or sibling paths in candidate
  arguments, environment, or files;
- immutable in-memory candidate policy plus post-run input-byte comparison;
- exact CLI invocation and exact npm forwarding syntax;
- Git-index byte manifests with a fresh-checkout regression;
- write-once lifecycle locks and one terminal disposition per slot;
- Skill-load, named-agent, requested-model, observed-model, tool, and post-worker access
  audits;
- concise external evidence keyed by observation ID, source hash, initial tree, terminal
  tree, and evidence hash.

Raw events, usage rows, prompts, timestamps, and evaluator files remain private.
Published evidence is the minimum hash-bound routing, usage, disposition, and score
summary needed for audit. Privacy checks reject machine paths, usernames, environment
values, credentials, and unrelated content. Bulky raw evidence is never committed.

## Authorization and execution boundary

[`design/source-manifest.json`](design/source-manifest.json) binds staged Git-index bytes
and every generated candidate/evaluator bundle. Reproduction also checks links,
schedule bytes, schemas, candidate isolation, fresh identifiers, and the no-run
attestation.

[`design/authorization.json`](design/authorization.json) authorizes only the frozen
excluded pilot. It self-hashes its payload and binds merge `d7140a5`, the merged
preregistration root, Git-index bytes for every reviewed authorization delta, all parent,
worker-study, observation, and worktree identities, the exact 1.0.77 CLI binary and path,
the read-only usage-store path and schema, two absent external-root identities, a nonce,
and an expiry. The authorization changes no corpus, order, prompts, models, tools,
evaluator, gates, or thresholds.

The execute path requires an explicit `--execute` through the exact Windows/npm command
in [`README.md`](README.md). Static preflight creates no roots and requires a clean fresh
checkout with `HEAD == origin/main`, the preregistration merge as an ancestor, matching
index bytes, exact CLI bytes, unused frozen IDs, an unmodified read-only usage schema, and
both roots absent and disjoint. Candidate policy is frozen in memory before launch and is
never reread.

The frozen worker UUID is a preregistered study identity because CLI 1.0.77 does not accept
a caller-selected worker session UUID. Runtime never pretends it was observed or consumed:
the authenticated task control-plane `call_*` identity is captured from events and usage,
matched across the task, subagent, model, and tool records, and published only as SHA-256.

Runtime evidence checks the exact parent session and model, parent tool surface, one A2
Skill load, one named Sonnet task, requested and observed `claude-sonnet-4.6`, the
observed control-plane worker call, worker read/edit paths, one complete target
replacement, terminal JSON, and all parent access after worker editing. Direct agent
bypass or parent post-worker documentation access fails adherence. Candidate arguments,
environment, and files receive no evaluator, evidence, schedule, source-repository, or
sibling paths. Built-in and configured MCP servers are disabled for the candidate, while
ordinary Copilot control-plane access remains allowed.

Each started observation is permanently ITT. There are no retries. Proven pre-start
failure consumes no ID. Ordinary post-start implementation, routing, quality, timeout,
model, tool, or process failures retain measured usage and do not stop the remaining
schedule. Only impossible event integrity, usage attribution, deterministic evaluation,
lifecycle locking, isolation, or privacy evidence stops later starts; every remaining
slot still receives one not-started terminal disposition.

The external evaluator executes twice with zero AI credits. Private evidence includes raw
JSONL, read-only usage rows, initial/terminal tree hashes, call/path audit, and write-once
lifecycle records. Sanitized output contains only observation hashes, dispositions,
scores, parent/worker/combined credit splits, pilot gate math, and a root evidence hash.
This is a practical context/tool audit, not a hostile sandbox or compliance claim.

Merge authorizes no automatic run: zero observations remain the attested state until a
human deliberately issues the exact execute command after merge. A pilot GO still cannot
execute main. Main requires a later pilot result, decision, and separate authorization.
Changing tasks, prompts, models, evaluator, thresholds, IDs, or analysis requires a new
preregistration.
