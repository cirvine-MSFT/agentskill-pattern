# Preregistered unit-test delegation v2

## Question and arms

Can GPT-5.6 Sol reduce quality-adjusted AI credits on a meaningful feature workflow by
routing only substantial unit-test authoring to fixed Claude Sonnet 4.6?

| Arm | Frozen behavior |
| --- | --- |
| A1 | Parent implements production code, writes the target unit tests inline, and may run/fix visible tests. |
| A2 | Parent implements production code, loads `unit-test-authoring` exactly once, and that Skill delegates the target test exactly once to `unit-test-author-sonnet-v2`. |

A2 is not pseudo-delegation: a direct parent `task` call without the prior Skill load is
nonadherent. The worker model requested by agent frontmatter and observed in event/usage
evidence must both be exactly `claude-sonnet-4.6`. The parent may not write delegated
tests. After worker start it may not access the target test, run tests, grade, repair,
rewrite, or retry. Failure remains intention-to-treat (ITT).

## Fresh corpus and isolation

The permanently excluded pilot uses `P11`-`P13`. Held-out main uses `M11`-`M14`.
All requirements, starters, gold implementations, hidden cases, mutants, prompts,
schedule IDs, session IDs, worktree IDs, and hashes are new in v2. No v1 candidate,
fixture, task, observation, session, run, or worktree identity is accepted.

Each observation receives a fresh candidate-only repository containing package metadata,
`TASK.md`, shared source, one starter production module, one convention test, one
precreated sentinel target test, the frozen envelope, and A2 Skill/agent files where
applicable. Gold code, hidden cases, mutants, schedules, evaluator code, sibling
workspaces, prior output, and evidence are outside the observation root.

Feature work is the larger parent goal. Test authoring is substantial but bounded to one
complete file. All tasks are deterministic in-memory CommonJS business logic with no
network, UI, external service, clock, or random dependency.

## A2 routing and artifact contract

The envelope freezes:

- run ID and status hash;
- exact framework: `node:test`, CommonJS, and `node:assert/strict`;
- requirements, changed-production, and nearby-convention paths forming the complete
  worker read set;
- a target path proven to exist before launch and its exact sentinel bytes;
- one complete replacement write as the only worker edit.

The worker has only global `read` and `edit`; runtime audit permits one read of every
listed source/convention path, no target read, and one direct target edit. Shell, search,
MCP, Skill, recursion, delegation, traversal, and other paths are forbidden. Its only
return is:

`<run-id> | <target-test-path> | SUCCESS|FAILURE | <status-hash>`

Evidence must show exactly one successful Skill load, then exactly one named task
delegation; requested and observed worker model; successful worker tool completions;
permitted paths; one target write; compact status; and no parent target access after
worker start. A routing, model, tool, artifact, or terminal violation is retained as A2
nonadherence.

## Deterministic external evaluation

Evaluation starts only after the parent process exits and costs zero AI credits. Feature
correctness and test quality are separate:

- feature hidden-case pass rate against candidate production;
- candidate test syntax/visible pass;
- same tests against gold production (false-positive detection);
- failures against task-specific seeded mutants (false-negative/survivor detection);
- meaningful assertion/test counts and duplicate/trivial detection;
- branch and statement coverage for `src/feature.js` when Node reports stable coverage;
- isolation: only expected production/test paths changed and no worker production edit.

Test-quality composite is the unweighted mean of compile/pass, meaningful assertions,
mutant kill rate, branch coverage, statement coverage, gold pass, isolation, and
nontrivial/nonduplicate status. An unavailable component scores zero in ITT. Coverage
remains a component only while the pinned Node format passes its parser regression;
otherwise the preregistered version stops before an observation rather than changing the
metric.

## Economics and telemetry

Primary economics are combined parent+worker AI credits (`nano_aiu / 1e9`) and parent AI
credits, with the parent/Sonnet split always reported. Secondary telemetry includes
input/output tokens by actor, total model tokens, parent cumulative and peak completion
input, active/wait/wall timing, completion count, tool calls by actor/name, tool-result
bytes, reliability, and adherence.

Sonnet is more expensive than v1 Haiku, so savings are not assumed. All main gates must
pass prospectively:

| Family | A2 relative to A1 |
| --- | --- |
| Combined credits | Paired geometric-mean ratio <= 0.88 and task-stratified ratio <= 0.92 in at least 3/4 tasks. |
| Parent economics/context | Parent-credit ratio <= 0.72; cumulative-input ratio <= 0.78; peak-input ratio <= 0.92. |
| Feature | Mean difference >= -0.02; every task >= -0.05; no A2 hidden score < 0.50 paired with A1 >= 0.90. |
| Test quality | Composite >= -0.03; mutant kill and branch coverage each >= -0.04; gold false-positive rate increase <= 0.02. |
| Reliability/adherence | A2 reliability and adherence each >= 0.95; reliability difference >= -0.04. |
| Guardrails | Total-model-token and wall-time ratios each <= 1.35. |

Economics passing while any quality, reliability, adherence, token, or wall gate fails is
a negative result.

## Randomized excluded pilot and held-out main

The excluded pilot is three randomized pairs (six observations), large enough to yield
several valid pairs but still bounded. Its deterministic order comes from
`unit-test-delegation-v2|sonnet-4.6|2026-08-01|b7314d89`.

Pilot GO requires all six schedule slots attempted or retained, at least five operational
completions, at least two complete valid pairs, feature score 1.0 for every operational
completion, at least two adherent A2 observations whose tests pass candidate and gold,
mean valid-A2 mutant kill >= 0.70, no valid-A2 gold false positive, and every started unit
within 90 combined credits, 300,000 model tokens, and 360 seconds. Ordinary post-start
failure does not abort remaining slots. The pilot decision is made only after the full
schedule unless an evidence-integrity stop is triggered.

GO authorizes only a separate held-out-main execution PR/commit. That review may bind
environment evidence and record GO but cannot alter corpus, prompts, models, tools,
metrics, margins, randomization, or analysis. Main is 24 pairs: four tasks by six
repetitions, 48 observations. Analysis is paired descriptive ITT with task-stratified
summaries and frozen 10,000-block bootstrap intervals; intervals do not override gates.

## Start, retry, and integrity rules

A unit starts at its first accepted parent model completion. Pre-start exclusions are
limited to source/hash drift, failed fresh workspace creation, exact CLI/model/tool
unavailability, consumed identity, evaluator-root accessibility, or failed deterministic
preflight. Repair may restore that unit to its original slot before any model completion.

After start there are no retries, substitutions, continuation turns, repairs, or reruns.
Timeouts, budgets, delegation failures, malformed results, adherence failures, test
failures, and infrastructure failures remain final ITT observations, and the runner
continues to later slots.

Stop the remaining schedule only for evidence integrity that makes subsequent results
untrustworthy: frozen source/hash drift, hidden/evaluator leakage, reused identity, wrong
parent/worker model, a worker tool outside `read`/`edit`, parent target access after worker
start, corrupted lifecycle/evidence locks, or privacy breach. A single failed unit alone
is not a stop reason.

For started units with unavailable economic/latency values, ratios use conservative
imputations of 90 credits, 300,000 parent cumulative/peak input and total model tokens,
and 360 seconds wall time. Nonpositive/noncomputable ratios fail closed.

## Pins, runner, evidence, and no-run boundary

- Base: `cirvine-MSFT/agentskill-pattern@e8eb4098056ce7bc7faf6e09de79e9d5335beeee`
- GitHub Copilot CLI `1.0.77`; Node `22.14.0`; npm `10.9.2`
- Parent `gpt-5.6-sol`, default context, medium effort
- Worker `claude-sonnet-4.6`, agent-frontmatter fixed
- Parent global tools: A1 `edit,powershell,view`; A2
  `edit,powershell,skill,task,view`
- Worker agent tools: `read,edit`

The runner retains v1's corrected exact npm forwarding, Git-index-byte source manifests,
fresh `core.autocrlf=true` checkout regression, fresh candidate Git repositories,
write-once lifecycle locks, concise external evidence, Skill routing audit, and no-parent-
review checks. Preflight and lifecycle are separate; lifecycle requires explicit
`--execute`. Raw events, prompts, workspaces, and usage exports stay in a new absent
access-controlled root outside the repository. Only redacted hashes, statuses, metrics,
and concise diagnostics are publishable.

This preregistration authorizes only the excluded pilot runner and records zero AI
observations, zero consumed v2 identities, and zero result evidence files. Deterministic
reproduce/tests/no-run checks are not observations. No compliance claim is made.
