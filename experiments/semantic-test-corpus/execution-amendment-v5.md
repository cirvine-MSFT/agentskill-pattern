# Preregistered execution protocol v5

This amendment supersedes v4 for future execution. V2, v3, v4, and all pilot
evidence remain immutable historical records. No measured v5 unit has started.

## Frozen identity and source

- Protocol: `semantic-test-corpus-execution-v5`
- Namespace: `semantic-test-corpus-v5-0eb04ca0-7474-4fcc-9c2f-41802423e8d8`
- Pilot namespace: `semantic-test-corpus-v5-pilot-only-8c705727-fd93-47f7-9c72-f8cff3442523`
- Source commit: `b5e69bd2a470e5520ba0684f7e1a9fa2f305141b`
- Design root: `design/v5/`
- Schedule: 12 complete randomized blocks, 72 fresh `V5-*` run IDs, and 60
  fresh deterministic AI-session UUIDs.

No earlier run ID, session ID, namespace, candidate, staging root, artifact root,
or global-order slot may be reused.

## Scientific correction

V4 incorrectly required successful treatment conformance from every AI arm in
disposable smoke. R3 established working execution infrastructure for GPT inline,
GPT-to-GPT, Haiku inline, and GPT-to-fixed-Haiku. The Haiku-to-Haiku surface also
started on real infrastructure, but its parent called Task before Skill
completion/context and removed the required terminal LF. Those observations are
treatment-adherence failures, not global infrastructure failures.

V5 pre-start eligibility is limited to outcome-independent facts: the exact
pinned source/candidate, generated sandbox schema, live MCP initialize and exact
tools/list, CLI/model availability, readable usage store, writable artifact
paths, deterministic session identity, and the ability to start the requested
model/mechanism surface. Skill ordering, exact Task bytes, worker routing,
MCP-call behavior, terminal return, staging completion, semantic quality, and
all other model behavior are non-gating pilot observations.

The exact v5 builders require a new disposable pilot series with fresh IDs.
V4/R3 may be cited only as non-authorizing context. Every pilot has a separate
usage export and is excluded from measured outcomes.

## Started-unit ITT rule

The durable lifecycle marker is the start boundary. After it exists, every model
behavior, routing or identity mismatch, Skill ordering failure, exact-byte
mismatch (including terminal LF), missing or invalid MCP call, terminal failure,
partial staging, timeout, budget failure, or tool misuse is a final measured ITT
failure. Actual artifacts and all available same-session usage, cost, and latency
are retained. There is exactly one attempt and no retry.

Only a positively proven failure before the durable start boundary may be
`unavailable`. No post-start check may exclude, erase, or relabel a started unit
as unavailable.

Started failures receive deterministic quality outcomes. When evaluator-only
code can safely authenticate and snapshot valid staged writes, it scores that
partial snapshot. Otherwise promotion rate, path coverage, and mutant kill rate
are zero, with explicit failure and scoring-source indicators. Operational
success, treatment adherence, and semantic quality are reported separately.

## Analysis

Primary analysis is descriptive ITT. Every started unit appears in its arm
summary and all-attempt cost totals. A randomized block is administratively
complete when each scheduled arm has one final disposition; measured failures
count as final dispositions and do not make a block incomplete. Registered
within-block contrasts use the deterministic outcome values for all started
units in outcome-complete blocks. Pre-session unavailable cells remain explicit
and are never replaced with invented model output.

Report all twelve block values, point estimates, disposition counts, treatment
adherence, operational success, quality scoring source, partial scenario counts,
and usage/cost/latency availability. Evidence is unsigned local descriptive
evidence. Do not make unsupported significance, causality, compliance, or
population-generalization claims.

## Frozen exact-byte contract

Delegated Task bytes are compared byte-for-byte, including the final LF.
Whitespace normalization and optional trailing bytes are prohibited. The v5
prompt and harness are not tailored in response to R3; the six conceptual arms,
public-contract-only deterministic baseline, and target GPT-to-fixed-Haiku arm
remain unchanged.
