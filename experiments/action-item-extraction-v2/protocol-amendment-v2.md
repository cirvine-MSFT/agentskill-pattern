# Protocol amendment v2: corrected action-item extraction feasibility

## Identity and separation

Protocol `action-item-extraction-v2` uses UUID namespace
`a3f947dc-bfa8-4d93-84a9-837b507c621e`. It is a fresh attempt, not a repair or
continuation of v1. V1 is immutable NO-GO at merge
`4900bdde8250292c86d4040d242359359ac050a0` / PR #26. V2 validation binds that
reference without reading, executing, copying, or hashing any v1 transcript,
gold, runtime, session, run, or evidence artifact.

## Inputs and scoring

The development transcript and three excluded-pilot transcripts are new,
synthetic, 4-18 KB meeting records. Each contains final explicit commitments,
suggestions, negations, rescission, reassignment, due-date change, conditional
and blocked work, decisions without assigned actions, materially ambiguous
apparent commitments, and distractors. Evaluator-only gold has twelve expected
items and five expected omissions per transcript. Every source quote is
line-grounded in the concrete frozen transcript.

The deterministic evaluator records tuple precision, recall and F1; owner,
action, due-date, status, condition and criticality accuracy; rescission,
reassignment and date-change handling; unsupported commitments and unsupported
critical actions; schema validity; duplicates; and source grounding. The
deterministic A0 floor is descriptive and does not authorize an AI arm.

## Corrected A4 mechanism

The project Skill `action-ledger-v2` routes exactly once to
`action-ledger-v2-haiku`. Worker frontmatter is exactly
`tools: ["read", "edit"]`, pinned to `claude-haiku-4.5`. Runtime behavior is
exactly one whole-transcript structured `view`, followed by exactly one builtin
structured `edit` replacing the existing sentinel ledger, then one compact
run/path/count/frozen-status-hash line. There is no shell, search, MCP,
recursion, delegation, traversal, retry, or per-item tool loop.

The task envelope supplies the exact sentinel bytes so the worker can perform
the replacement without a forbidden ledger read.

The parent is GPT-5.6 Sol. It must load the project Skill, delegate once, never
view the transcript, never view/edit the ledger, and return only the worker
line. Each candidate contains exactly:

1. `.github\skills\action-ledger-v2\SKILL.md`
2. `.github\agents\action-ledger-v2-haiku.agent.md`
3. `input\transcript.txt`
4. precreated `output\ledger.json`

No candidate git metadata, gold, evaluator, evidence, or other file is allowed.

## Frozen launch and event interpretation

CLI version is exactly 1.0.77. Every launch uses frozen arguments with
`--model gpt-5.6-sol`, `--output-format json`, `--log-level debug`,
`--allow-all-tools`, exact global filter
`--available-tools=task,view,edit`, and `--disable-builtin-mcps`, plus the
supported safe flags in `design\execution-plan.json`. JSON output is parsed as
JSONL event objects.

The worker identity comes only from `subagent.started.agentId`; parent file
calls have no `agentId`. A tool completion counts only when its `toolCallId`
matches the start and `success` is true. Raw events and debug stderr must
contain parent and worker `Tools:` schemas; worker schema evidence must include
structured `view` and builtin `edit`.

Any worker unknown-tool warning is fatal. Read/view warnings and all other
unknown-tool warnings are fatal. The only tolerated warning is an exact
root/parent warning, before child registry creation, that bare `edit` or
source-qualified `builtin:edit` is unknown. It is accepted only if the worker
schema proves view/builtin-edit and the worker edit starts and completes
successfully. Accepted warning evidence is recorded explicitly.

## One-shot lifecycle and gate

Fresh `DEV-ACTION-V2-*` executes exactly once later. Runtime and evidence roots
must not already exist. Preflight and durable start-index are written before
the lifecycle starts. Failure preserves intent-to-treat evidence, persists
NO-GO, starts zero pilots, and stops without retry or tuning.

After a passing development unit, the harness writes the pilot gate before any
pilot starts, then runs exactly three fresh excluded A4 units once each. GO
requires all of:

- operational success and treatment adherence: 3/3;
- exactly one successful worker view and edit: 3/3;
- zero unsupported critical actions;
- valid schema, compact return, and candidate isolation: 3/3;
- mean tuple F1 at least 0.85 and every run at least 0.75;
- every run at most 40,000 total model tokens and 180 seconds wall time.

No retry or threshold softening is allowed. Raw JSONL, stderr/debug, usage,
run configuration, ledger, score, run evidence, preflight, start index, gate,
summary, report, and hash manifest form the evidence package.

## Authorization boundary

A feasibility GO authorizes only a separate confirmatory preregistration pull
request. That later PR must freeze hidden main hashes, randomized blocks, all
five A0-A4 arms, exact prompts/pins/tool surfaces, ITT rules, quality and
reliability metrics, parent-cost/context targets, total-token and latency caps,
blinded judging, analysis, and closure. No confirmatory or main unit is
authorized by this amendment.
