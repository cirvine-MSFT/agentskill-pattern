# Protocol amendment v3: action-item extraction excluded pilot

## Identity, immutability, and purpose

Protocol `action-item-extraction-v3` uses UUID namespace
`d94fca73-b06f-4e21-9f7a-31eb42bf8a6d`. V3 is a prospective instrumentation
correction, not a reinterpretation, retry, or continuation of v2. V1 and v2
transcripts, gold, run IDs, session IDs, schedules, hashes, evidence, thresholds,
and dispositions remain immutable and excluded. V2 remains NO-GO at PR #27 /
merge `9f3add6986105dd18ac1b4ed8f3cdf2edd639f5a`, and no v2 pilot ran.

The v2 development observation remains exactly as preserved: 12/12 tuple
matches; precision, recall, and F1 1.00; correct rescission, reassignment, and
date handling; zero unsupported commitments; one worker view and one worker
edit; no parent file calls; valid schema, compact return, and isolation; 38,410
total model tokens; 55.08 seconds wall time. Source grounding remains 1/12
because multiline quotes omitted transcript line prefixes. The v2 NO-GO remains
caused by missing distinct parent/worker debug `Tools:` blocks under its frozen
rule.

## Fresh inputs and evaluator-only gold

V3 freezes exactly three new excluded-pilot transcripts, each below 18 KB, and
three matching evaluator-only gold inventories. Each transcript contains noisy
commitments, suggestions that are not commitments, negations, rescission,
reassignment, changed due dates, conditional and blocked items, decisions
without action, material ambiguity, and distractors. Gold records canonical
owner, action, final due date, status, condition, exact prefixed source line
ranges, criticality, and ambiguity/omission policy. Candidate roots contain no
gold, evaluator, evidence, repository metadata, or sibling material.

## A4-only mechanism and runtime

The three pilot units are A4 only and execute in the frozen order in
`design/execution-plan.json`. There are no A0-A3 AI observations and no
development or main observations. Seeds are not used. Each run freezes its run
ID, deterministic UUIDv5 session, source and gold hashes, task envelope, exact
CLI arguments, status hash, and candidate file-set hash.

The parent model is GPT-5.6 Sol. The project Skill routes once to
`action-ledger-v3-haiku`, fixed to Claude Haiku 4.5. Worker frontmatter tools are
exactly `read` and `edit`. CLI version is exactly 1.0.77, with
`--available-tools=task,view,edit`, `--allow-all-tools`, and
`--disable-builtin-mcps`. The worker makes exactly one structured
whole-transcript `view` and one structured `edit` that replaces the precreated
sentinel ledger. The parent makes zero transcript or ledger file calls. Shell,
search, MCP, recursion, additional delegation, retries, and all other worker
tools are forbidden.

## Prospective warning rule

Before execution, v3 tolerates exactly one root/parent warning:
`Unknown tool name in the tool allowlist: "edit"`. It is accepted only when:

1. no worker unknown-tool warning exists;
2. one worker view and one worker edit each have structured starts and matching
   successful completions;
3. the sentinel is replaced by a valid `action-ledger.v3` artifact; and
4. the observed parent/worker actors and models match the frozen plan.

Any other warning, missing call, extra call, failed completion, actor mismatch,
model mismatch, invalid artifact, or unreplaced sentinel is fatal. Distinct
debug `Tools:` schema blocks are recorded when available but are informative,
not required, because CLI 1.0.77 does not reliably emit them. This rule is a
prospective correction based on excluded v2 development instrumentation; it
does not alter or waive the frozen v2 rule or disposition.

Structured event evidence must link the parent task call ID to the worker
agent/subagent ID and every worker tool event. Parent task events must report
GPT-5.6 Sol; worker lifecycle and tool events must report Claude Haiku 4.5.

## Output and source grounding

Every action item must contain `sourceCitations` with exact bracketed transcript
line identifiers and the complete verbatim prefixed line or contiguous range.
For a matched tuple, the citation set must exactly equal the gold source
line/range set. Missing, malformed, altered, incomplete, or non-supporting
citations fail grounding. Required ambiguities must also reproduce the exact
gold citation set and provide a semantically matching omission explanation.
A canonical tuple match requires owner, action, final due date, status,
condition, and criticality to match. Action and ambiguity comparisons reject
deterministic negation and directional-opposite mismatches before applying
their frozen token-similarity thresholds. The complete definition is frozen in
the execution plan before the pilot and cannot change in response to outcomes.

## Lifecycle, evidence, and intent to treat

Fixture/provenance validation, evaluator behavior, preflight, durable
start-index lifecycle, evidence extraction, warning checking, settled usage
accounting, hash manifests, and report generation are frozen before any start.
The runner rejects an existing runtime or evidence root. It writes preflight
and the durable start index before the first start, retains every post-start
failure in intent-to-treat, runs the three frozen units in order, and permits no
retry or threshold change.

Post-run certification revalidates the frozen foundation, reconstructs each run
from raw JSONL, debug stderr, ledger, exact-session usage, and process metadata,
then recomputes the three-run gate rather than trusting derived run evidence.

## GO gate and authorization boundary

GO requires all of:

- operational success and treatment adherence: 3/3;
- exactly one successful worker view and edit: 3/3;
- zero unsupported critical actions;
- valid schema, compact return, and candidate isolation: 3/3;
- mean tuple F1 at least 0.85 and every run at least 0.75;
- source grounding: 100%;
- every run at most 40,000 total model tokens and 180 seconds wall time.

A successful v3 pilot authorizes only a separate five-arm main-study
preregistration pull request. It never authorizes immediate main execution.
That later PR must freeze A0-A4 identities, hidden main inputs and hashes,
randomization, prompts and tool surfaces, ITT rules, metrics, analysis, and
closure before any main start.
