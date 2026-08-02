# Preregistered unit-test delegation experiment

## Question and trust model

The parent goal is meaningful feature implementation in a small Node.js business-logic
application. GPT-5.6 Sol owns requirements understanding, production code, integration,
and the final compact response. The confirmatory comparison is:

| Arm | Frozen behavior |
| --- | --- |
| A1 control | Parent implements production code and writes unit tests itself. |
| A2 treatment | Parent implements production code, then invokes `unit-test-authoring` once. Fixed Claude Haiku 4.5 reads only the supplied requirements, changed production file, nearby test convention, and precreated target test; it replaces only the target test and returns compact status. |

The parent must trust A2 output. After worker return it may not read, grade, run, repair,
rewrite, or discuss the delegated test. Its final response may report only the compact
worker status and production outcome. Deterministic evaluation occurs after the parent
process exits and is not part of AI credits. No A3 arm is included: the primary question
is the operationally intended fixed-Haiku pattern, and adding GPT-to-GPT would dilute
the paired sample without changing the deployment decision.

## Corpus and leakage boundary

The permanently excluded pilot uses `P01` and `P02`. The held-out main study uses six
independent tasks (`M01`-`M06`) spanning parsing/validation, pricing, policy evaluation,
state transitions, scheduling, and reconciliation. Every task requires nontrivial
production logic with validation and errors; tests remain a substantial bounded
artifact. Network, UI, time-of-day, randomness, and external services are absent.

The external launcher materializes one fresh candidate-only Git repository for each
observation. Candidate files are limited to `TASK.md`, package metadata, shared source,
the task's starter production module, one nearby convention test, the precreated target
test, and A2 Skill/agent files when applicable. Gold production, hidden cases, mutants,
schedule siblings, prior outputs, evaluator code, and other-arm workspaces remain
outside the observation root and must be inaccessible to both parent and worker.
Run/session/worktree IDs are unique and never reused.

## Pilot and authorization boundary

The excluded development smoke/pilot is exactly four observations: two pilot tasks by
two arms, one paired repetition, ordered by the frozen seed. No retry is allowed. Pilot
GO requires 4/4 operational completions, 4/4 feature-correct observations, both A2
workers treatment-adherent, both A2 test artifacts compiling and passing against gold,
mean A2 mutant kill at least 0.60, no false positive against gold, combined credits at
most 40, total model tokens at most 80,000, and wall time at most 300 seconds per
observation.

Pilot failure permanently stops this experiment version. Pilot GO authorizes only a
separate reviewed main-execution authorization commit. That commit may record GO and
bind environment preflight evidence but may not change tasks, prompts, schedule,
metrics, margins, models, tools, or analysis. The reviewed execution amendment
authorizes only the four permanently excluded pilot observations after this
preregistration merged. The guarded launcher requires explicit `--execute`; without it,
the command performs preflight only. Main remains forbidden.

## Main sample and randomization

The main design is 30 complete randomized pairs: six tasks by five repetitions, 60
planned observations. A block is `(task_id, repetition)`. Both arms use fresh workspaces
and session IDs. Within each block, arm order is determined by SHA-256 counter draws
from seed `unit-test-delegation-v1|2026-08-01|61c1391`; block order is determined by the
same deterministic algorithm. The checked-in schedule is authoritative and exactly
reproducible.

The analysis is descriptive paired ITT. Report arm medians, task-stratified means,
paired differences and ratios, bootstrap 95% intervals with frozen seed and 10,000
block resamples, all individual task summaries, and denominators. Intervals describe
sampling variability and do not override the exact gates.

## Outcomes

Feature correctness is scored separately from test quality. The external deterministic
harness records:

- public test pass and hidden acceptance case pass against candidate production;
- candidate test compile/pass, meaningful assertion count, pass against gold (false
  positives), failures against each seeded mutant (false negatives/survivors),
  Node line coverage (the frozen statement-coverage proxy) and branch coverage for
  `src/feature.js` only, isolation, and duplicate/trivial-test flags;
- parent, worker, and combined AI credits (`nano_aiu / 1e9`) and raw nano-AIU;
- parent/worker/total input and output tokens, total model tokens, parent cumulative
  and peak completion input;
- parent active, worker active, parent wait, and wall time;
- completion count, tool-call count by actor/name, tool-result bytes, terminal status,
  reliability, and adherence.

Feature score is hidden cases passed divided by total. Test-quality composite is the
unweighted mean of: compile/pass, meaningful assertions, mutant kill rate, branch
coverage, statement coverage, no false positive against gold, isolation, and
nontrivial/nonduplicate status. Unavailable quality components score zero in ITT.

## Frozen positive-signal gates

All gates must pass; no substitution or post-hoc weighting is allowed.

| Family | Exact main-study gate, A2 relative to A1 |
| --- | --- |
| Primary economics | Paired geometric-mean combined-credit ratio <= 0.80; task-stratified ratio <= 0.85 in at least 5/6 tasks. |
| Parent economics | Parent-credit ratio <= 0.70; parent cumulative-input ratio <= 0.75; parent peak-input ratio <= 0.90. |
| Feature correctness | Paired mean difference >= -0.02 and each task difference >= -0.05; no A2 catastrophic observation with hidden score < 0.50 when its A1 pair is >= 0.90. |
| Test quality | Composite difference >= -0.05; mutant-kill difference >= -0.05; branch-coverage difference >= -0.05; gold false-positive rate no more than 0.02 higher. |
| Reliability/adherence | A2 operational reliability >= 0.95, treatment adherence >= 0.95, and reliability difference >= -0.05. |
| Guardrails | Total-model-token ratio <= 1.50 and wall-time ratio <= 1.50. |

Credits, not raw tokens, are the primary economics outcome. A result passing economics
but failing any quality, reliability, adherence, token, or latency gate is negative.

## Start, failure, retry, and stopping rules

Pre-start exclusions are limited to missing pinned source bytes, failed clean-workspace
creation, unavailable exact CLI/model/tool surface, duplicate ID, evaluator-root
accessibility, or failed deterministic preflight. Such a unit has not received a model
completion and may be scheduled later in its original slot after the environment is
repaired.

The first accepted parent completion starts a unit. Every timeout, budget event, model
mismatch discovered afterward, worker/delegation failure, malformed result, tool misuse,
partial artifact, test failure, or infrastructure failure is retained as final ITT
data. There are no post-start retries, substitutions, continuation turns, repairs, or
reruns. A1 worker metrics are exact zero; unavailable started-unit outcomes remain
`null` in raw evidence and score zero where the frozen quality metric says so. For
paired economic and latency ratios only, unavailable started-unit combined/parent
credits are conservatively imputed to 40 credits, parent cumulative/peak input and total
model tokens to 80,000, and wall time to 300 seconds. Nonpositive or otherwise
noncomputable ratios fail their gates closed.

Stop before any further unit for source/hash drift, hidden/evaluator leakage, reused
identity, wrong parent or worker model, broader worker tools, parent post-return target
test access, evidence corruption, or privacy breach. Do not inspect outcomes to decide
whether to stop except these integrity/safety conditions and the frozen pilot gate.

## Pins, envelopes, evidence, and privacy

- Source base: `cirvine-MSFT/agentskill-pattern@61c1391c7c712a8d8defbbaa6c54212c00ac9ce5`
- GitHub Copilot CLI: `1.0.77`
- Parent: `gpt-5.6-sol`, default context, medium reasoning
- Worker: `claude-haiku-4.5`, frontmatter fixed
- Runtime boundary: global parent `task/view/edit` plus normal production-edit tools;
  worker frontmatter `read/edit`, runtime calls limited to supplied paths
- Node.js: `22.14.0`; Windows runner image and Copilot extension build recorded before
  pilot and held fixed for main
- Observation envelope: 40 combined credits, 80,000 model tokens, 300 seconds wall,
  one parent process, at most one worker invocation

Raw event streams, prompts, tool payloads, and workspaces remain access-controlled and
are not committed. The durable evidence package contains schema-validated derived
metrics, hashes, tool path/name summaries, statuses, and redacted diagnostics. No
credentials, user content, or absolute home paths are retained. This preregistration
contains only source, contracts, schemas, deterministic tests, and hashes.

## No-run attestation

At preregistration, both phases were forbidden and the source manifest root was
`def40cf7d53e098c58afffdd76859955910b0eea16fa9a263a3395de720e5538`. The reviewed
authorization now permits only the excluded pilot and binds that original manifest,
the four generated candidate hashes, and all four predetermined session/worktree IDs.
The prospective no-run attestation still records zero started observations and zero
result evidence files. Passing deterministic checks or holding authorization is not
execution: only the guarded command with explicit `--execute` may cross the lifecycle
boundary. Main remains forbidden.

After runner merge and before any lifecycle start, Windows PowerShell with pinned npm
10.9.2 was found to remove forwarded option names from the single-delimiter runbook
command while leaving their values. The packaging-only correction uses two npm
delimiters and a strict wrapper around the unchanged hash-reviewed runner. The defect
and its reproduction consumed zero pilot IDs, started zero observations, and created
no result or private evidence roots.

After that correction merged, its three newly added files were committed as LF under
the repository's `text eol=lf` policy, but the mutable current-source manifest had
recorded their pre-commit CRLF working-tree hashes. This second outcome-independent
packaging correction makes manifest generation hash finalized staged bytes, rejects
unstaged/untracked inputs and working-tree/index byte differences, and excludes the
manifest itself. A fresh Windows `core.autocrlf=true` checkout must reproduce the
manifest and pass the documented static preflight. Diagnosis and correction consumed
zero IDs, started zero observations, and created no private evidence root. The pilot
must be reauthorized against the corrected current-source root before execution; main
remains forbidden.
